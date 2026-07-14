import { ProviderId, ProviderUsage, UsageWindow, WindowName } from "./types.js";

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function normalizeWindow(
  name: WindowName,
  raw: unknown,
  fallbackMinutes: number,
): UsageWindow | null {
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const usedPercent = asNumber(record.used_percent ?? record.used_percentage);
  const windowMinutes = asNumber(record.window_minutes ?? record.windowMinutes) ?? fallbackMinutes;
  const resetsAtRaw = record.resets_at ?? record.resetsAt;
  const resetsAt =
    typeof resetsAtRaw === "number"
      ? new Date(resetsAtRaw * 1000).toISOString()
      : asString(resetsAtRaw);

  if (usedPercent === null || resetsAt === null) {
    return null;
  }

  return {
    name,
    windowMinutes,
    usedPercent,
    resetsAt,
  };
}

export function findWindow(usage: ProviderUsage, name: WindowName) {
  return usage.windows.find((window) => window.name === name);
}

export function validateProviderUsage(usage: ProviderUsage) {
  const fiveHour = findWindow(usage, "five_hour");
  const sevenDay = findWindow(usage, "seven_day");
  if (!fiveHour || fiveHour.windowMinutes !== 300) {
    throw new Error(`${usage.provider}: missing 5h usage window`);
  }
  if (!sevenDay || sevenDay.windowMinutes !== 10080) {
    throw new Error(`${usage.provider}: missing 7d usage window`);
  }
}

export function makeProviderUsage(input: {
  provider: ProviderId;
  source: string;
  observedAt?: string;
  planType?: string | null;
  fiveHour: UsageWindow;
  sevenDay: UsageWindow;
}): ProviderUsage {
  return {
    provider: input.provider,
    source: input.source,
    observedAt: input.observedAt ?? new Date().toISOString(),
    planType: input.planType ?? null,
    windows: [input.fiveHour, input.sevenDay],
  };
}
