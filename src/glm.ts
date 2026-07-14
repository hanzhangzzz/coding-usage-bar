import { makeProviderUsage, normalizeWindow } from "./usage.js";
import { GlmConfig, ProviderUsage } from "./types.js";

const DEFAULT_BASE_URL = "https://open.bigmodel.cn";

interface GlmLimit {
  type: string;
  unit?: number;
  number?: number;
  percentage: number;
  nextResetTime: number;
}

interface GlmQuotaResponse {
  success: boolean;
  data?: {
    limits: GlmLimit[];
    level: string;
  };
}

export async function fetchGlmQuota(config: GlmConfig): Promise<GlmQuotaResponse> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  const url = `${baseUrl}/api/monitor/usage/quota/limit`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`GLM quota API returned HTTP ${response.status}`);
  }

  return (await response.json()) as GlmQuotaResponse;
}

export function usageFromGlmQuota(
  quota: GlmQuotaResponse,
  options: { observedAt?: string; source: string },
): ProviderUsage | null {
  if (!quota.success || !quota.data) {
    return null;
  }

  const tokenLimits = quota.data.limits.filter(
    (limit) => limit.type === "TOKENS_LIMIT",
  );

  if (tokenLimits.length < 2) {
    return null;
  }

  const sortedByReset = [...tokenLimits].sort(
    (a, b) => a.nextResetTime - b.nextResetTime,
  );

  const fiveHourRaw = sortedByReset[0];
  const sevenDayRaw = sortedByReset[1];

  const fiveHour = normalizeWindow("five_hour", {
    used_percent: fiveHourRaw.percentage,
    resets_at: new Date(fiveHourRaw.nextResetTime).toISOString(),
  }, 300);

  const sevenDay = normalizeWindow("seven_day", {
    used_percent: sevenDayRaw.percentage,
    resets_at: new Date(sevenDayRaw.nextResetTime).toISOString(),
  }, 10080);

  if (!fiveHour || !sevenDay) {
    return null;
  }

  return makeProviderUsage({
    provider: "glm",
    source: options.source,
    observedAt: options.observedAt,
    planType: quota.data.level ?? null,
    fiveHour,
    sevenDay,
  });
}

export async function collectGlmUsage(config: GlmConfig): Promise<ProviderUsage> {
  if (!config.apiKey) {
    throw new Error("GLM API key not configured. Edit ~/.coding-usage-bar/config.json to set glm.apiKey.");
  }

  const quota = await fetchGlmQuota(config);
  const usage = usageFromGlmQuota(quota, {
    source: `${config.baseUrl || DEFAULT_BASE_URL}/api/monitor/usage/quota/limit`,
  });

  if (!usage) {
    throw new Error("GLM quota response did not contain expected token limit data");
  }

  return usage;
}
