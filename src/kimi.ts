import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeProviderUsage, normalizeWindow } from "./usage.js";
import { KimiConfig, ProviderUsage } from "./types.js";

const DEFAULT_BASE_URL = "https://api.kimi.com/coding";
const KIMI_HOST_PATTERN = /kimi\.com/;

interface KimiQuotaDetail {
  limit?: string | number;
  used?: string | number;
  remaining?: string | number;
  resetTime?: string;
}

interface KimiWindowLimit {
  window?: { duration?: number; timeUnit?: string };
  detail?: KimiQuotaDetail;
}

interface KimiUsagesResponse {
  user?: { membership?: { level?: string } };
  usage?: KimiQuotaDetail;
  limits?: KimiWindowLimit[];
}

function asNumber(value: string | number | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// Kimi reports limit/used/remaining per window. Prefer the used/limit ratio;
// when limit is 0 or missing, derive the total from used + remaining instead of
// falling back to 0% while a real signal exists.
function percentFromDetail(detail: KimiQuotaDetail): number | null {
  const limit = asNumber(detail.limit);
  const used = asNumber(detail.used);
  const remaining = asNumber(detail.remaining);
  if (limit !== null && limit > 0 && used !== null) {
    return Math.max(0, Math.min(100, (used / limit) * 100));
  }
  if (used !== null && remaining !== null && used + remaining > 0) {
    return Math.max(0, Math.min(100, (used / (used + remaining)) * 100));
  }
  return null;
}

function fiveHourLimit(limits: KimiWindowLimit[]): KimiWindowLimit | null {
  const withWindow = limits.filter((entry) => typeof entry.window?.duration === "number");
  const exact = withWindow.find(
    (entry) => entry.window?.duration === 300 && entry.window?.timeUnit === "TIME_UNIT_MINUTE",
  );
  if (exact) {
    return exact;
  }
  const sorted = [...withWindow].sort(
    (left, right) => (left.window?.duration ?? Infinity) - (right.window?.duration ?? Infinity),
  );
  return sorted[0] ?? null;
}

export async function fetchKimiUsages(config: KimiConfig): Promise<KimiUsagesResponse> {
  const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = `${baseUrl}/v1/usages`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Kimi usages API returned HTTP ${response.status}`);
  }

  return (await response.json()) as KimiUsagesResponse;
}

export function usageFromKimiUsages(
  usages: KimiUsagesResponse,
  options: { observedAt?: string; source: string },
): ProviderUsage | null {
  const shortWindow = fiveHourLimit(usages.limits ?? []);
  const fiveHourPercent = shortWindow?.detail ? percentFromDetail(shortWindow.detail) : null;
  const fiveHourReset = shortWindow?.detail?.resetTime;
  const sevenDayPercent = usages.usage ? percentFromDetail(usages.usage) : null;
  const sevenDayReset = usages.usage?.resetTime;

  if (fiveHourPercent === null || !fiveHourReset || sevenDayPercent === null || !sevenDayReset) {
    return null;
  }

  const fiveHour = normalizeWindow("five_hour", {
    used_percent: fiveHourPercent,
    resets_at: fiveHourReset,
  }, 300);

  const sevenDay = normalizeWindow("seven_day", {
    used_percent: sevenDayPercent,
    resets_at: sevenDayReset,
  }, 10080);

  if (!fiveHour || !sevenDay) {
    return null;
  }

  return makeProviderUsage({
    provider: "kimi",
    source: options.source,
    observedAt: options.observedAt,
    planType: usages.user?.membership?.level ?? null,
    fiveHour,
    sevenDay,
  });
}

// Claude Code lanes keep the Kimi credential in ~/.config/claude-lanes/config.env
// as CONFIG_<n>_BASE_URL / CONFIG_<n>_AUTH_TOKEN pairs. Scan every numbered entry
// and pick the one whose base URL points at kimi.com, so lane reordering does not
// break the lookup.
export function readClaudeLanesKimiConfig(configFile: string): KimiConfig | null {
  let content: string;
  try {
    content = fs.readFileSync(configFile, "utf8");
  } catch {
    return null;
  }

  const entries = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    entries.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }

  const indices = new Set<number>();
  for (const key of entries.keys()) {
    const match = key.match(/^CONFIG_(\d+)_(?:BASE_URL|AUTH_TOKEN)$/);
    if (match) {
      indices.add(Number(match[1]));
    }
  }

  for (const index of [...indices].sort((left, right) => left - right)) {
    const baseUrl = entries.get(`CONFIG_${index}_BASE_URL`);
    const apiKey = entries.get(`CONFIG_${index}_AUTH_TOKEN`);
    if (baseUrl && apiKey && KIMI_HOST_PATTERN.test(baseUrl)) {
      return { baseUrl, apiKey };
    }
  }
  return null;
}

// Resolution order: explicit ~/.coding-usage-bar/config.json kimi.* wins;
// otherwise fall back to the claude-lanes lane that targets kimi.com.
export function resolveKimiConfig(config: KimiConfig | undefined, homeDir = os.homedir()): KimiConfig {
  const lanes = readClaudeLanesKimiConfig(
    path.join(homeDir, ".config", "claude-lanes", "config.env"),
  );
  return {
    baseUrl: config?.baseUrl || lanes?.baseUrl,
    apiKey: config?.apiKey || lanes?.apiKey,
  };
}

export async function collectKimiUsage(config: KimiConfig): Promise<ProviderUsage> {
  if (!config.apiKey) {
    throw new Error("Kimi API key not configured. Edit ~/.coding-usage-bar/config.json to set kimi.apiKey, or configure a kimi.com lane in ~/.config/claude-lanes/config.env.");
  }

  const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const usages = await fetchKimiUsages(config);
  const usage = usageFromKimiUsages(usages, {
    source: `${baseUrl}/v1/usages`,
  });

  if (!usage) {
    throw new Error("Kimi usages response did not contain expected 5h/7d quota data");
  }

  return usage;
}
