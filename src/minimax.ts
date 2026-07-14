import { makeProviderUsage, normalizeWindow } from "./usage.js";
import { MinimaxConfig, ProviderUsage } from "./types.js";

const CN_BASE_URL = "https://api.minimaxi.com";
const GLOBAL_BASE_URL = "https://api.minimax.io";

interface MinimaxModelRemain {
  model_name: string;
  start_time: number;
  end_time: number;
  remains_time: number;
  current_interval_total_count: number;
  current_interval_usage_count: number;
  current_interval_remaining_percent?: number;
  current_weekly_total_count: number;
  current_weekly_usage_count: number;
  current_weekly_remaining_percent?: number;
  weekly_start_time: number;
  weekly_end_time: number;
  weekly_remains_time: number;
}

interface MinimaxQuotaResponse {
  model_remains: MinimaxModelRemain[];
  category_remains?: MinimaxCategoryRemain[];
  base_resp: {
    status_code: number;
    status_msg: string;
  };
}

interface MinimaxCategoryRemain {
  start_time: number;
  end_time: number;
  remains_time: number;
  current_interval_total_count: number;
  current_interval_usage_count: number;
  current_interval_remaining_percent?: number;
  current_weekly_total_count: number;
  current_weekly_usage_count: number;
  current_weekly_remaining_percent?: number;
  weekly_start_time: number;
  weekly_end_time: number;
  weekly_remains_time: number;
  category: string;
  display_name: string;
}

function baseUrl(config: MinimaxConfig): string {
  return config.region === "global" ? GLOBAL_BASE_URL : CN_BASE_URL;
}

export async function fetchMinimaxQuota(config: MinimaxConfig): Promise<MinimaxQuotaResponse> {
  const url = `${baseUrl(config)}/v1/token_plan/remains`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`MiniMax quota API returned HTTP ${response.status}`);
  }

  const data = (await response.json()) as MinimaxQuotaResponse;

  if (data.base_resp?.status_code !== 0) {
    throw new Error(`MiniMax API error: ${data.base_resp?.status_msg ?? "unknown error"} (code ${data.base_resp?.status_code})`);
  }

  return data;
}

export function usageFromMinimaxQuota(
  quota: MinimaxQuotaResponse,
  options: { observedAt?: string; source: string },
): ProviderUsage | null {
  const models = quota.model_remains;
  const categories = quota.category_remains;
  if (!models || models.length === 0) {
    return null;
  }

  // Prefer the "general" model entry — it reflects the text/chat plan this CLI
  // is most often used for. Fall back to the first model so we never return
  // null for an account that only reports other models.
  const primary = models.find((m) => m.model_name === "general") ?? models[0];

  let fiveHourPercent = 0;
  let fiveHourReset = primary.end_time;
  let weeklyPercent = 0;
  let weeklyReset = primary.weekly_end_time;

  if (categories && categories.length > 0) {
    const textGen = categories.find((c) => c.category === "text_generation");
    if (textGen) {
      fiveHourPercent = percentFromQuota(
        textGen.current_interval_total_count,
        textGen.current_interval_usage_count,
        textGen.current_interval_remaining_percent,
      );
      fiveHourReset = textGen.end_time;
      weeklyPercent = percentFromQuota(
        textGen.current_weekly_total_count,
        textGen.current_weekly_usage_count,
        textGen.current_weekly_remaining_percent,
      ) ?? fiveHourPercent;
      weeklyReset = textGen.weekly_end_time;
    }
  } else {
    fiveHourPercent = percentFromQuota(
      primary.current_interval_total_count,
      primary.current_interval_usage_count,
      primary.current_interval_remaining_percent,
    );

    weeklyPercent = percentFromQuota(
      primary.current_weekly_total_count,
      primary.current_weekly_usage_count,
      primary.current_weekly_remaining_percent,
    ) ?? fiveHourPercent;
  }

  const fiveHour = normalizeWindow("five_hour", {
    used_percent: fiveHourPercent,
    resets_at: new Date(fiveHourReset).toISOString(),
  }, 300);

  const sevenDay = normalizeWindow("seven_day", {
    used_percent: weeklyPercent,
    resets_at: new Date(weeklyReset).toISOString(),
  }, 10080);

  if (!fiveHour || !sevenDay) {
    return null;
  }

  return makeProviderUsage({
    provider: "minimax",
    source: options.source,
    observedAt: options.observedAt,
    planType: primary.model_name ?? null,
    fiveHour,
    sevenDay,
  });
}

// MiniMax reports usage two ways depending on plan type. Count-based accounts
// (e.g. `video`) populate current_*_usage_count / current_*_total_count.
// Credit-based accounts (e.g. `general`) keep total at 0 and expose
// current_*_remaining_percent in 0-100. Prefer the count ratio when total > 0,
// otherwise derive from the remaining percent, and only fall back to 0 when
// neither signal is present.
function percentFromQuota(
  totalCount: number | undefined,
  usageCount: number | undefined,
  remainingPercent: number | undefined,
): number {
  if (typeof totalCount === "number" && totalCount > 0 && typeof usageCount === "number") {
    return Math.max(0, Math.min(100, (usageCount / totalCount) * 100));
  }
  if (typeof remainingPercent === "number" && Number.isFinite(remainingPercent)) {
    return Math.max(0, Math.min(100, 100 - remainingPercent));
  }
  return 0;
}

export async function collectMinimaxUsage(config: MinimaxConfig): Promise<ProviderUsage> {
  if (!config.apiKey) {
    throw new Error("MiniMax API key not configured. Edit ~/.coding-usage-bar/config.json to set minimax.apiKey.");
  }

  const quota = await fetchMinimaxQuota(config);
  const usage = usageFromMinimaxQuota(quota, {
    source: `${baseUrl(config)}/v1/token_plan/remains`,
  });

  if (!usage) {
    throw new Error("MiniMax quota response did not contain expected token plan data");
  }

  return usage;
}
