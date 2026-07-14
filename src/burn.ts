import { findWindow } from "./usage.js";
import { BurnAnalysis, BurnProfile, BurnState, ProviderId, ProviderUsage } from "./types.js";

const PROFILE_FACTORS: Record<BurnProfile, { min: number; max: number }> = {
  low: { min: 0.8, max: 1.1 },
  high: { min: 0.9, max: 1.35 },
};

function round(value: number) {
  return Math.round(value * 10) / 10;
}

function minutesUntil(iso: string, nowMs: number) {
  return Math.max(0, (Date.parse(iso) - nowMs) / 60_000);
}

const MIN_TOTAL_FIVE_DELTA = 5;

export function estimateConversionRate(samples: ProviderUsage[]): number | null {
  const usable = [...samples]
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt))
    .map((sample) => ({
      five: findWindow(sample, "five_hour")?.usedPercent,
      seven: findWindow(sample, "seven_day")?.usedPercent,
    }))
    .filter((item): item is { five: number; seven: number } => {
      return typeof item.five === "number" && typeof item.seven === "number";
    });

  // Trim to the longest tail where the 7d window is monotonically non-decreasing.
  // Cross-session anomalies (Codex picking a different rollout file with stale
  // rate_limits) show up as sharp drops in 7d; using only the most recent
  // stable tail avoids contaminating the rate with the recovery ramp-up.
  let startIdx = usable.length - 1;
  while (startIdx > 0 && usable[startIdx - 1].seven <= usable[startIdx].seven) {
    startIdx -= 1;
  }
  // If we stopped because of a drop, the sample we landed on is the anomalous
  // low reading itself; skip it so its artificially low 7d baseline doesn't
  // inflate the first delta of the tail.
  if (startIdx > 0) {
    startIdx += 1;
  }
  const recent = usable.slice(startIdx);

  // Aggregate cumulative deltas across positive 5h advances. Using totals
  // (not the median of per-pair rates) averages out integer-rounding noise:
  // a single 5h tick is often 1% while 7d may not bump until several 5h ticks
  // accumulate, so per-pair rates are dominated by zeros and over-estimates.
  let totalFive = 0;
  let totalSeven = 0;
  for (let i = 1; i < recent.length; i += 1) {
    const deltaFive = recent[i].five - recent[i - 1].five;
    const deltaSeven = recent[i].seven - recent[i - 1].seven;
    if (deltaFive > 0 && deltaSeven >= 0) {
      totalFive += deltaFive;
      totalSeven += deltaSeven;
    }
  }

  if (totalFive < MIN_TOTAL_FIVE_DELTA) {
    return null;
  }
  const value = totalSeven / totalFive;
  return Number.isFinite(value) && value > 0 ? value : null;
}

function providerLabel(provider: ProviderId) {
  return provider === "claude" ? "Claude" : provider === "glm" ? "GLM" : provider === "deepseek" ? "DeepSeek" : provider === "minimax" ? "MiniMax" : "Codex";
}

function messageForState(provider: ProviderId, state: BurnState, fiveUsed?: number, target?: { min: number; max: number }) {
  const label = providerLabel(provider);
  if (state === "LIMIT_RISK") {
    return `${label} usage is close to a plan limit. Consider switching provider or lowering intensity.`;
  }
  if (!target || fiveUsed === undefined) {
    return `${label} usage is visible, but more samples are needed before dynamic burn advice is available.`;
  }
  if (state === "UNDER_BURN") {
    return `${label} 5h usage is below target (${round(fiveUsed)}%, target ${round(target.min)}%-${round(target.max)}%).`;
  }
  if (state === "OVER_BURN") {
    return `${label} 5h usage is above target (${round(fiveUsed)}%, target ${round(target.min)}%-${round(target.max)}%).`;
  }
  return `${label} burn pace is on track (${round(fiveUsed)}%, target ${round(target.min)}%-${round(target.max)}%).`;
}

export function analyzeUsage(
  usage: ProviderUsage,
  samples: ProviderUsage[],
  profile: BurnProfile = "low",
  now = new Date(),
): BurnAnalysis {
  const fiveHour = findWindow(usage, "five_hour");
  const sevenDay = findWindow(usage, "seven_day");

  if (usage.balance && usage.windows.length === 0) {
    const currency = usage.balance.currency === "CNY" ? "¥" : "$";
    const balanceText = `${currency}${usage.balance.total}`;
    return {
      provider: usage.provider,
      state: "RAW",
      profile,
      observedAt: usage.observedAt,
      message: usage.balance.isAvailable
        ? `${messageForState(usage.provider, "RAW")} balance: ${balanceText}`
        : `${messageForState(usage.provider, "LIMIT_RISK")} balance depleted`,
    };
  }

  if ((fiveHour?.usedPercent ?? 0) >= 90 || (sevenDay?.usedPercent ?? 0) >= 90) {
    return {
      provider: usage.provider,
      state: "LIMIT_RISK",
      profile,
      observedAt: usage.observedAt,
      fiveHour,
      sevenDay,
      message: messageForState(usage.provider, "LIMIT_RISK"),
    };
  }

  if (!fiveHour || !sevenDay) {
    const label = providerLabel(usage.provider);
    const message = !fiveHour && sevenDay
      ? `${label} 5h usage unavailable; showing 7d only.`
      : fiveHour && !sevenDay
        ? `${label} 7d usage unavailable; showing 5h only.`
        : `${label} usage windows unavailable.`;
    return {
      provider: usage.provider,
      state: "RAW",
      profile,
      observedAt: usage.observedAt,
      fiveHour,
      sevenDay,
      message,
    };
  }

  const conversionRate = estimateConversionRate(samples);
  if (conversionRate === null) {
    return {
      provider: usage.provider,
      state: "RAW",
      profile,
      observedAt: usage.observedAt,
      fiveHour,
      sevenDay,
      message: messageForState(usage.provider, "RAW"),
    };
  }

  const remainingSeven = Math.max(0, 100 - sevenDay.usedPercent);
  const remainingSlots = Math.max(1, minutesUntil(sevenDay.resetsAt, now.getTime()) / 300);
  const weeklyBudgetPerSlot = remainingSeven / remainingSlots;
  const recommendedPercent = Math.min(100, weeklyBudgetPerSlot / conversionRate);
  const factors = PROFILE_FACTORS[profile];
  const target = {
    minPercent: Math.min(100, recommendedPercent * factors.min),
    maxPercent: Math.min(100, recommendedPercent * factors.max),
    recommendedPercent,
    conversionRate,
  };

  let state: BurnState = "ON_TRACK";
  if (fiveHour.usedPercent < target.minPercent) {
    state = "UNDER_BURN";
  } else if (fiveHour.usedPercent > target.maxPercent) {
    state = "OVER_BURN";
  }

  return {
    provider: usage.provider,
    state,
    profile,
    observedAt: usage.observedAt,
    fiveHour,
    sevenDay,
    target,
    message: messageForState(usage.provider, state, fiveHour.usedPercent, {
      min: target.minPercent,
      max: target.maxPercent,
    }),
  };
}
