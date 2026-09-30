import { PricingInfo } from "./types.js";

// Peak / off-peak pricing tiers for the two providers that publish a clock-based
// discount. Both rules are stated by the vendor in Beijing time (UTC+8, no DST),
// so the arithmetic below deliberately avoids the host time zone.
//
// DeepSeek (api-docs.deepseek.com/quick_start/pricing): peak is 01:00-04:00 and
// 06:00-10:00 UTC, Monday through Friday, excluding Chinese public holidays;
// every other hour is off-peak at 50% of the peak rate. In Beijing time that is
// 09:00-12:00 and 14:00-18:00.
//
// GLM Coding Plan V3 (docs.bigmodel.cn/cn/coding-plan/overview): 高峰时段 is
// 每周一至周五的 14:00~18:00 (UTC+8) at the base credit deduction; all other
// hours deduct 50% of the base credits. The page does not exclude public
// holidays, and time-boxed promotions (e.g. all-day off-peak during a holiday
// campaign) are not modelled here: the tier follows the standing rule only.

const BEIJING_OFFSET_MINUTES = 8 * 60;
const MINUTES_PER_DAY = 24 * 60;
const LOOKAHEAD_DAYS = 40;

// Rest days from 国务院办公厅关于2026年部分节假日安排的通知 (国办发明电〔2025〕7号,
// 2025-11-04). Adjusted working weekends (调休上班) are intentionally not
// promoted to weekdays: both vendors phrase the peak rule as Monday-Friday.
const CN_PUBLIC_HOLIDAYS: Record<number, ReadonlySet<string>> = {
  2026: new Set([
    "01-01", "01-02", "01-03",
    "02-15", "02-16", "02-17", "02-18", "02-19", "02-20", "02-21", "02-22", "02-23",
    "04-04", "04-05", "04-06",
    "05-01", "05-02", "05-03", "05-04", "05-05",
    "06-19", "06-20", "06-21",
    "09-25", "09-26", "09-27",
    "10-01", "10-02", "10-03", "10-04", "10-05", "10-06", "10-07",
  ]),
};

interface PricingRule {
  // [start, end) in minutes since Beijing midnight.
  peakSegments: ReadonlyArray<readonly [number, number]>;
  excludePublicHolidays: boolean;
  offPeakDiscountPercent: number;
  rule: string;
}

const DEEPSEEK_RULE: PricingRule = {
  peakSegments: [[9 * 60, 12 * 60], [14 * 60, 18 * 60]],
  excludePublicHolidays: true,
  offPeakDiscountPercent: 50,
  rule: "DeepSeek API: peak Mon-Fri 09:00-12:00 & 14:00-18:00 Asia/Shanghai excluding CN public holidays; off-peak 50% off",
};

const GLM_RULE: PricingRule = {
  peakSegments: [[14 * 60, 18 * 60]],
  excludePublicHolidays: false,
  offPeakDiscountPercent: 50,
  rule: "GLM Coding Plan: peak Mon-Fri 14:00-18:00 Asia/Shanghai; off-peak credits deducted at 50%",
};

interface BeijingParts {
  year: number;
  month: number;
  day: number;
  weekday: number;
  minutes: number;
}

function beijingParts(date: Date): BeijingParts {
  const shifted = new Date(date.getTime() + BEIJING_OFFSET_MINUTES * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

function beijingInstant(year: number, month: number, day: number, minutes: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 0, minutes - BEIJING_OFFSET_MINUTES));
}

export function isCnPublicHoliday(date: Date): boolean {
  const parts = beijingParts(date);
  const key = `${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  return CN_PUBLIC_HOLIDAYS[parts.year]?.has(key) ?? false;
}

function tierAt(rule: PricingRule, date: Date): PricingInfo["tier"] {
  const parts = beijingParts(date);
  if (parts.weekday === 0 || parts.weekday === 6) {
    return "off_peak";
  }
  if (rule.excludePublicHolidays && isCnPublicHoliday(date)) {
    return "off_peak";
  }
  const inPeak = rule.peakSegments.some(([start, end]) => parts.minutes >= start && parts.minutes < end);
  return inPeak ? "peak" : "off_peak";
}

// The tier can only flip at a segment edge or at midnight, so walking those
// instants day by day finds the next change without minute-level scanning.
function nextTierChange(rule: PricingRule, date: Date): Date {
  const current = tierAt(rule, date);
  const start = beijingParts(date);
  const edges = Array.from(new Set([0, ...rule.peakSegments.flatMap(([a, b]) => [a, b])]))
    .filter((m) => m < MINUTES_PER_DAY)
    .sort((a, b) => a - b);
  for (let offset = 0; offset <= LOOKAHEAD_DAYS; offset += 1) {
    for (const edge of edges) {
      const candidate = beijingInstant(start.year, start.month, start.day + offset, edge);
      if (candidate.getTime() <= date.getTime()) {
        continue;
      }
      if (tierAt(rule, candidate) !== current) {
        return candidate;
      }
    }
  }
  // Unreachable with the rules above (every week has weekdays); keep a sane bound.
  return beijingInstant(start.year, start.month, start.day + LOOKAHEAD_DAYS, 0);
}

function pricingFor(rule: PricingRule, date: Date): PricingInfo {
  const tier = tierAt(rule, date);
  return {
    tier,
    discountPercent: tier === "off_peak" ? rule.offPeakDiscountPercent : 0,
    until: nextTierChange(rule, date).toISOString(),
    timezone: "Asia/Shanghai",
    rule: rule.rule,
  };
}

export function deepseekPricing(now: Date = new Date()): PricingInfo {
  return pricingFor(DEEPSEEK_RULE, now);
}

export function glmPricing(now: Date = new Date()): PricingInfo {
  return pricingFor(GLM_RULE, now);
}

export function pricingLabel(pricing: PricingInfo, until: string): string {
  return pricing.tier === "off_peak"
    ? `Off-peak · ${pricing.discountPercent}% off until ${until}`
    : `Peak · full price until ${until}`;
}
