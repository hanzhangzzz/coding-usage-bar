import { makeProviderUsage, normalizeWindow } from "./usage.js";
import { GlmConfig, ProviderUsage } from "./types.js";

const DEFAULT_BASE_URL = "https://open.bigmodel.cn";

interface GlmLimit {
  type: string;
  unit?: number;
  number?: number;
  percentage: number;
  // Omitted for a fresh window with zero usage.
  nextResetTime?: number;
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

function resetTimeIso(value: number | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// GLM identifies windows by shape: unit 3 + number 5 is the 5-hour window,
// unit 6 + number 1 is the weekly window. Matching on shape (with a
// reset-time sort as fallback) matters because sorting alone breaks when a
// window omits nextResetTime — which GLM does for a fresh window with zero
// usage (same proto-style field omission as Kimi's zero `used`). The zero
// percentage is a real signal and must not be dropped; a missing reset time
// falls back to `observedAt`, which renders as "reset due".
function pickTokenWindows(limits: GlmLimit[]): { five: GlmLimit; seven: GlmLimit } | null {
  const tokenLimits = limits.filter((limit) => limit.type === "TOKENS_LIMIT");
  if (tokenLimits.length < 2) {
    return null;
  }
  let five = tokenLimits.find((limit) => limit.unit === 3 && limit.number === 5) ?? null;
  let seven = tokenLimits.find((limit) => limit.unit === 6 && limit.number === 1) ?? null;
  if (!five || !seven) {
    const rest = tokenLimits
      .filter((limit) => limit !== five && limit !== seven)
      .sort((a, b) => (a.nextResetTime ?? 0) - (b.nextResetTime ?? 0));
    five = five ?? rest.shift() ?? null;
    seven = seven ?? rest.shift() ?? null;
  }
  return five && seven ? { five, seven } : null;
}

export function usageFromGlmQuota(
  quota: GlmQuotaResponse,
  options: { observedAt?: string; source: string },
): ProviderUsage | null {
  if (!quota.success || !quota.data) {
    return null;
  }

  const picked = pickTokenWindows(quota.data.limits);
  if (!picked) {
    return null;
  }

  // new Date(undefined).toISOString() throws RangeError("Invalid time value"),
  // which used to fail the whole live collection; never convert unchecked.
  const fallbackIso = options.observedAt ?? new Date().toISOString();

  const fiveHour = normalizeWindow("five_hour", {
    used_percent: picked.five.percentage,
    resets_at: resetTimeIso(picked.five.nextResetTime) ?? fallbackIso,
  }, 300);

  const sevenDay = normalizeWindow("seven_day", {
    used_percent: picked.seven.percentage,
    resets_at: resetTimeIso(picked.seven.nextResetTime) ?? fallbackIso,
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
