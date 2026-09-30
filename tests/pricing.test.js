import test from "node:test";
import assert from "node:assert/strict";
import { deepseekPricing, glmPricing, isCnPublicHoliday, pricingLabel } from "../dist/pricing.js";

// Helpers build instants from Beijing wall-clock time (UTC+8, no DST).
const bj = (y, m, d, hh, mm = 0) => new Date(Date.UTC(y, m - 1, d, hh - 8, mm));
const bjIso = (y, m, d, hh, mm = 0) => bj(y, m, d, hh, mm).toISOString();

test("deepseek: weekday morning and afternoon peak windows in Beijing time", () => {
  // 2026-09-30 is a Wednesday.
  assert.equal(deepseekPricing(bj(2026, 9, 30, 10, 0)).tier, "peak");
  assert.equal(deepseekPricing(bj(2026, 9, 30, 15, 30)).tier, "peak");
  assert.equal(deepseekPricing(bj(2026, 9, 30, 12, 0)).tier, "off_peak");
  assert.equal(deepseekPricing(bj(2026, 9, 30, 13, 59)).tier, "off_peak");
  assert.equal(deepseekPricing(bj(2026, 9, 30, 18, 0)).tier, "off_peak");
  assert.equal(deepseekPricing(bj(2026, 9, 30, 8, 59)).tier, "off_peak");
});

test("deepseek: off-peak carries the 50% discount and the next flip instant", () => {
  const morning = deepseekPricing(bj(2026, 9, 30, 10, 0));
  assert.equal(morning.discountPercent, 0);
  assert.equal(morning.until, bjIso(2026, 9, 30, 12, 0));
  assert.equal(morning.timezone, "Asia/Shanghai");

  const lunch = deepseekPricing(bj(2026, 9, 30, 12, 30));
  assert.equal(lunch.tier, "off_peak");
  assert.equal(lunch.discountPercent, 50);
  assert.equal(lunch.until, bjIso(2026, 9, 30, 14, 0));

});

test("deepseek: weekends are off-peak all day and flip at Monday 09:00", () => {
  // 2026-10-10 is a Saturday (an adjusted working day nationally, still weekend for the rule).
  const sat = deepseekPricing(bj(2026, 10, 10, 15, 0));
  assert.equal(sat.tier, "off_peak");
  assert.equal(sat.until, bjIso(2026, 10, 12, 9, 0));
});

test("deepseek: Chinese public holidays are off-peak even on weekdays", () => {
  // 2026-10-01 (Thursday) opens the National Day holiday through 10-07 (Wednesday).
  assert.equal(isCnPublicHoliday(bj(2026, 10, 1, 10, 0)), true);
  assert.equal(isCnPublicHoliday(bj(2026, 10, 8, 10, 0)), false);
  const holiday = deepseekPricing(bj(2026, 10, 1, 10, 0));
  assert.equal(holiday.tier, "off_peak");
  assert.equal(holiday.until, bjIso(2026, 10, 8, 9, 0));
  // The evening before the holiday already points past the whole break.
  const eve = deepseekPricing(bj(2026, 9, 30, 20, 0));
  assert.equal(eve.until, bjIso(2026, 10, 8, 9, 0));
});

test("glm: single weekday afternoon peak, no holiday exclusion", () => {
  assert.equal(glmPricing(bj(2026, 9, 30, 10, 0)).tier, "off_peak");
  assert.equal(glmPricing(bj(2026, 9, 30, 14, 0)).tier, "peak");
  assert.equal(glmPricing(bj(2026, 9, 30, 17, 59)).tier, "peak");
  assert.equal(glmPricing(bj(2026, 9, 30, 18, 0)).tier, "off_peak");
  // The vendor page states the rule as Mon-Fri only, so 10-01 (Thursday) stays peak here.
  assert.equal(glmPricing(bj(2026, 10, 1, 15, 0)).tier, "peak");
  assert.equal(glmPricing(bj(2026, 10, 3, 15, 0)).tier, "off_peak");
});

test("glm: until points at the next segment edge", () => {
  const peak = glmPricing(bj(2026, 9, 30, 14, 30));
  assert.equal(peak.discountPercent, 0);
  assert.equal(peak.until, bjIso(2026, 9, 30, 18, 0));
  const night = glmPricing(bj(2026, 9, 30, 21, 0));
  assert.equal(night.discountPercent, 50);
  assert.equal(night.until, bjIso(2026, 10, 1, 14, 0));
  const friday = glmPricing(bj(2026, 10, 9, 19, 0));
  assert.equal(friday.until, bjIso(2026, 10, 12, 14, 0));
});

test("pricingLabel renders both tiers", () => {
  assert.equal(pricingLabel({ tier: "off_peak", discountPercent: 50, until: "", timezone: "Asia/Shanghai", rule: "" }, "14:00"), "Off-peak · 50% off until 14:00");
  assert.equal(pricingLabel({ tier: "peak", discountPercent: 0, until: "", timezone: "Asia/Shanghai", rule: "" }, "18:00"), "Peak · full price until 18:00");
});
