import test from "node:test";
import assert from "node:assert/strict";
import { analyzeUsage, estimateConversionRate } from "../dist/burn.js";

const baseUsage = {
  provider: "claude",
  source: "test",
  observedAt: "2026-05-08T00:00:00.000Z",
  planType: null,
  windows: [
    { name: "five_hour", windowMinutes: 300, usedPercent: 30, resetsAt: "2026-05-08T02:00:00.000Z" },
    { name: "seven_day", windowMinutes: 10080, usedPercent: 35, resetsAt: "2026-05-12T00:00:00.000Z" },
  ],
};

const samples = [
  {
    ...baseUsage,
    observedAt: "2026-05-07T22:00:00.000Z",
    windows: [
      { name: "five_hour", windowMinutes: 300, usedPercent: 10, resetsAt: "2026-05-08T02:00:00.000Z" },
      { name: "seven_day", windowMinutes: 10080, usedPercent: 33, resetsAt: "2026-05-12T00:00:00.000Z" },
    ],
  },
  {
    ...baseUsage,
    observedAt: "2026-05-07T23:00:00.000Z",
    windows: [
      { name: "five_hour", windowMinutes: 300, usedPercent: 20, resetsAt: "2026-05-08T02:00:00.000Z" },
      { name: "seven_day", windowMinutes: 10080, usedPercent: 34, resetsAt: "2026-05-12T00:00:00.000Z" },
    ],
  },
  baseUsage,
];

test("estimateConversionRate learns 7d delta per 5h delta", () => {
  assert.equal(estimateConversionRate(samples), 0.1);
});

test("analyzeUsage returns RAW during cold start", () => {
  const analysis = analyzeUsage(baseUsage, [baseUsage], "low", new Date("2026-05-08T00:00:00.000Z"));
  assert.equal(analysis.state, "RAW");
});

test("analyzeUsage keeps current 7d data when Codex no longer reports 5h usage", () => {
  const usage = {
    provider: "codex",
    source: "test",
    observedAt: "2026-07-14T01:50:43.493Z",
    planType: "prolite",
    windows: [
      { name: "seven_day", windowMinutes: 10080, usedPercent: 52, resetsAt: "2026-07-20T01:46:56.000Z" },
    ],
  };

  const analysis = analyzeUsage(usage, [usage], "low", new Date("2026-07-14T01:51:00.000Z"));
  assert.equal(analysis.state, "RAW");
  assert.equal(analysis.fiveHour, undefined);
  assert.equal(analysis.sevenDay?.usedPercent, 52);
  assert.equal(analysis.message, "Codex 5h usage unavailable; showing 7d only.");
});

test("analyzeUsage preserves limit risk when only the 7d window is available", () => {
  const usage = {
    provider: "codex",
    source: "test",
    observedAt: "2026-07-14T01:50:43.493Z",
    planType: "prolite",
    windows: [
      { name: "seven_day", windowMinutes: 10080, usedPercent: 95, resetsAt: "2026-07-20T01:46:56.000Z" },
    ],
  };

  const analysis = analyzeUsage(usage, [usage], "low", new Date("2026-07-14T01:51:00.000Z"));
  assert.equal(analysis.state, "LIMIT_RISK");
  assert.equal(analysis.fiveHour, undefined);
  assert.equal(analysis.sevenDay?.usedPercent, 95);
});

test("analyzeUsage marks limit risk before dynamic advice", () => {
  const usage = {
    ...baseUsage,
    windows: [
      { name: "five_hour", windowMinutes: 300, usedPercent: 91, resetsAt: "2026-05-08T02:00:00.000Z" },
      { name: "seven_day", windowMinutes: 10080, usedPercent: 35, resetsAt: "2026-05-12T00:00:00.000Z" },
    ],
  };
  const analysis = analyzeUsage(usage, samples, "high", new Date("2026-05-08T00:00:00.000Z"));
  assert.equal(analysis.state, "LIMIT_RISK");
});

test("analyzeUsage uses different low/high target ranges", () => {
  const low = analyzeUsage(baseUsage, samples, "low", new Date("2026-05-08T00:00:00.000Z"));
  const high = analyzeUsage(baseUsage, samples, "high", new Date("2026-05-08T00:00:00.000Z"));
  assert.ok(low.target.maxPercent < high.target.maxPercent);
});

test("estimateConversionRate ignores cross-session anomalies before a 7d drop", () => {
  const noisy = [
    {
      provider: "codex",
      source: "test",
      observedAt: "2026-05-07T18:00:00.000Z",
      planType: null,
      windows: [
        { name: "five_hour", windowMinutes: 300, usedPercent: 5, resetsAt: "2026-05-07T22:00:00.000Z" },
        { name: "seven_day", windowMinutes: 10080, usedPercent: 50, resetsAt: "2026-05-12T00:00:00.000Z" },
      ],
    },
    // Cross-session anomaly: 7d drops sharply, then the next batch is the real
    // sequence we want to learn from.
    {
      provider: "codex",
      source: "test",
      observedAt: "2026-05-07T19:00:00.000Z",
      planType: null,
      windows: [
        { name: "five_hour", windowMinutes: 300, usedPercent: 0, resetsAt: "2026-05-08T00:00:00.000Z" },
        { name: "seven_day", windowMinutes: 10080, usedPercent: 0, resetsAt: "2026-05-12T00:00:00.000Z" },
      ],
    },
    {
      provider: "codex",
      source: "test",
      observedAt: "2026-05-07T20:00:00.000Z",
      planType: null,
      windows: [
        { name: "five_hour", windowMinutes: 300, usedPercent: 10, resetsAt: "2026-05-08T00:00:00.000Z" },
        { name: "seven_day", windowMinutes: 10080, usedPercent: 56, resetsAt: "2026-05-12T00:00:00.000Z" },
      ],
    },
    {
      provider: "codex",
      source: "test",
      observedAt: "2026-05-07T21:00:00.000Z",
      planType: null,
      windows: [
        { name: "five_hour", windowMinutes: 300, usedPercent: 20, resetsAt: "2026-05-08T00:00:00.000Z" },
        { name: "seven_day", windowMinutes: 10080, usedPercent: 58, resetsAt: "2026-05-12T00:00:00.000Z" },
      ],
    },
    {
      provider: "codex",
      source: "test",
      observedAt: "2026-05-07T22:00:00.000Z",
      planType: null,
      windows: [
        { name: "five_hour", windowMinutes: 300, usedPercent: 30, resetsAt: "2026-05-08T00:00:00.000Z" },
        { name: "seven_day", windowMinutes: 10080, usedPercent: 60, resetsAt: "2026-05-12T00:00:00.000Z" },
      ],
    },
  ];
  // Honest rate within the stable tail is (60-56)/(30-10) = 0.2.
  // The pre-drop pair would otherwise inflate the rate to ~3.0.
  assert.equal(estimateConversionRate(noisy), 0.2);
});

test("estimateConversionRate returns null when accumulated 5h delta is too small", () => {
  const sparse = [
    {
      provider: "codex",
      source: "test",
      observedAt: "2026-05-07T22:00:00.000Z",
      planType: null,
      windows: [
        { name: "five_hour", windowMinutes: 300, usedPercent: 10, resetsAt: "2026-05-08T02:00:00.000Z" },
        { name: "seven_day", windowMinutes: 10080, usedPercent: 33, resetsAt: "2026-05-12T00:00:00.000Z" },
      ],
    },
    {
      provider: "codex",
      source: "test",
      observedAt: "2026-05-07T23:00:00.000Z",
      planType: null,
      windows: [
        { name: "five_hour", windowMinutes: 300, usedPercent: 12, resetsAt: "2026-05-08T02:00:00.000Z" },
        { name: "seven_day", windowMinutes: 10080, usedPercent: 33, resetsAt: "2026-05-12T00:00:00.000Z" },
      ],
    },
  ];
  assert.equal(estimateConversionRate(sparse), null);
});
