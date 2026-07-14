import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildPaths } from "../dist/paths.js";
import { iconForAnalysis, markNotified, shouldNotify } from "../dist/notifier.js";
import { notificationCardSvg } from "../dist/card.js";

const analysis = {
  provider: "claude",
  state: "UNDER_BURN",
  profile: "low",
  observedAt: "2026-05-08T00:00:00.000Z",
  fiveHour: { name: "five_hour", windowMinutes: 300, usedPercent: 10, resetsAt: "2026-05-08T02:00:00.000Z" },
  sevenDay: { name: "seven_day", windowMinutes: 10080, usedPercent: 20, resetsAt: "2026-05-12T00:00:00.000Z" },
  message: "test",
};

test("notification cooldown suppresses repeated notifications", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-home-"));
  const paths = buildPaths(home);
  assert.equal(shouldNotify(analysis, paths, new Date("2026-05-08T00:00:00.000Z")), true);
  markNotified(analysis, paths, new Date("2026-05-08T00:00:00.000Z"));
  assert.equal(shouldNotify(analysis, paths, new Date("2026-05-08T00:10:00.000Z")), false);
  assert.equal(shouldNotify(analysis, paths, new Date("2026-05-08T00:31:00.000Z")), true);
});

test("notification cooldown resets when 5h window changes", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-home-"));
  const paths = buildPaths(home);
  markNotified(analysis, paths, new Date("2026-05-08T00:00:00.000Z"));
  const nextWindow = {
    ...analysis,
    fiveHour: { ...analysis.fiveHour, resetsAt: "2026-05-08T07:00:00.000Z" },
  };
  assert.equal(shouldNotify(nextWindow, paths, new Date("2026-05-08T00:05:00.000Z")), true);
});

test("7d-only limit risk remains eligible for notification", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-home-"));
  const paths = buildPaths(home);
  const weeklyLimitRisk = {
    ...analysis,
    provider: "codex",
    state: "LIMIT_RISK",
    fiveHour: undefined,
    sevenDay: { ...analysis.sevenDay, usedPercent: 95 },
  };
  assert.equal(shouldNotify(weeklyLimitRisk, paths, new Date("2026-07-14T01:51:00.000Z")), true);
});

test("iconForAnalysis selects state-specific icon", () => {
  assert.match(iconForAnalysis(analysis), /coding-usage-bar-under\.png$/);
  assert.match(iconForAnalysis({ ...analysis, state: "OVER_BURN" }), /coding-usage-bar-over\.png$/);
  assert.match(iconForAnalysis({ ...analysis, state: "LIMIT_RISK" }), /coding-usage-bar-limit\.png$/);
});

test("notificationCardSvg renders concrete burn data instead of symbolic-only icon", () => {
  const svg = notificationCardSvg({
    ...analysis,
    target: {
      minPercent: 35,
      maxPercent: 48,
      recommendedPercent: 42,
      conversionRate: 0.1,
    },
  });
  assert.match(svg, /Claude 5h/);
  assert.match(svg, /10%/);
  assert.match(svg, /target 35-48%/);
  assert.match(svg, /BURN LOW/);
});
