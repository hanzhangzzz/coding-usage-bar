import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { usageFromClaudeStatusLine } from "../dist/claude.js";
import { collectCodexUsage } from "../dist/codex.js";
import { readClaudeLanesKimiConfig, resolveKimiConfig, usageFromKimiUsages } from "../dist/kimi.js";
import { usageFromMinimaxQuota } from "../dist/minimax.js";

test("usageFromClaudeStatusLine normalizes status line rate limits", () => {
  const usage = usageFromClaudeStatusLine({
    rate_limits: {
      five_hour: { used_percentage: 42, resets_at: "2026-05-08T02:00:00Z" },
      seven_day: { used_percentage: 18, resets_at: "2026-05-12T00:00:00Z" },
    },
  });

  assert.equal(usage.provider, "claude");
  assert.equal(usage.windows[0].usedPercent, 42);
  assert.equal(usage.windows[1].windowMinutes, 10080);
});

test("usageFromClaudeStatusLine rejects missing usage", () => {
  assert.throws(() => usageFromClaudeStatusLine({}), /rate_limits/);
});

test("collectCodexUsage reads latest payload.rate_limits from jsonl", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-codex-"));
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "sessions", "rollout.jsonl"),
    [
      JSON.stringify({
        timestamp: "2026-05-08T00:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            primary: { used_percent: 12, window_minutes: 300, resets_at: 1778205600 },
            secondary: { used_percent: 34, window_minutes: 10080, resets_at: 1778544000 },
            plan_type: "pro",
          },
        },
      }),
      "",
    ].join("\n"),
    "utf8",
  );

  const usage = collectCodexUsage(dir);
  assert.equal(usage.provider, "codex");
  assert.equal(usage.planType, "pro");
  assert.equal(usage.windows[0].usedPercent, 12);
});

test("collectCodexUsage prefers the latest 7d-only payload over an older dual-window payload", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-codex-"));
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "sessions", "rollout.jsonl"),
    [
      JSON.stringify({
        timestamp: "2026-07-13T01:28:26.961Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            primary: { used_percent: 49, window_minutes: 300, resets_at: 1783828214 },
            secondary: { used_percent: 8, window_minutes: 10080, resets_at: 1784511014 },
            plan_type: "prolite",
          },
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-14T01:50:43.493Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            primary: { used_percent: 52, window_minutes: 10080, resets_at: 1784510416 },
            secondary: null,
            plan_type: "prolite",
          },
        },
      }),
      "",
    ].join("\n"),
    "utf8",
  );

  const usage = collectCodexUsage(dir);
  assert.equal(usage.observedAt, "2026-07-14T01:50:43.493Z");
  assert.deepEqual(usage.windows.map((window) => window.name), ["seven_day"]);
  assert.equal(usage.windows[0].usedPercent, 52);
});

test("collectCodexUsage accepts numeric-string window_minutes from the latest payload", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-codex-"));
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "sessions", "rollout.jsonl"),
    `${JSON.stringify({
      timestamp: "2026-07-14T01:50:43.493Z",
      payload: {
        rate_limits: {
          primary: { used_percent: 52, window_minutes: "10080", resets_at: 1784510416 },
          secondary: null,
          plan_type: "prolite",
        },
      },
    })}\n`,
    "utf8",
  );

  const usage = collectCodexUsage(dir);
  assert.deepEqual(usage.windows.map((window) => window.name), ["seven_day"]);
  assert.equal(usage.windows[0].windowMinutes, 10080);
});

test("collectCodexUsage ignores non-session jsonl files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-codex-"));
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".tmp", "plugins"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".tmp", "plugins", "fixture.jsonl"),
    `${JSON.stringify({
      timestamp: "2026-05-09T00:00:00.000Z",
      payload: {
        rate_limits: {
          primary: { used_percent: 99, window_minutes: 300, resets_at: 1778205600 },
          secondary: { used_percent: 99, window_minutes: 10080, resets_at: 1778544000 },
        },
      },
    })}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, "sessions", "rollout.jsonl"),
    `${JSON.stringify({
      timestamp: "2026-05-08T00:00:00.000Z",
      payload: {
        rate_limits: {
          primary: { used_percent: 12, window_minutes: 300, resets_at: 1778205600 },
          secondary: { used_percent: 34, window_minutes: 10080, resets_at: 1778544000 },
        },
      },
    })}\n`,
    "utf8",
  );

  const usage = collectCodexUsage(dir);
  assert.equal(usage.windows[0].usedPercent, 12);
});

test("usageFromMinimaxQuota derives percent from remaining when total_count is 0", () => {
  // Real MiniMax /v1/token_plan/remains response shape: `general` model has
  // total_count=0 (credit-based plan) and exposes remaining_percent only.
  const usage = usageFromMinimaxQuota({
    model_remains: [
      {
        model_name: "general",
        start_time: 1780297200000,
        end_time: 1780315200000,
        remains_time: 16138310,
        current_interval_total_count: 0,
        current_interval_usage_count: 0,
        current_interval_remaining_percent: 98,
        current_weekly_total_count: 0,
        current_weekly_usage_count: 0,
        current_weekly_remaining_percent: 99,
        weekly_start_time: 1780243200000,
        weekly_end_time: 1780848000000,
        weekly_remains_time: 548938310,
      },
      {
        model_name: "video",
        start_time: 1780243200000,
        end_time: 1780329600000,
        remains_time: 30538310,
        current_interval_total_count: 3,
        current_interval_usage_count: 0,
        current_weekly_total_count: 21,
        current_weekly_usage_count: 0,
        current_weekly_remaining_percent: 100,
        weekly_start_time: 1780243200000,
        weekly_end_time: 1780848000000,
        weekly_remains_time: 548938310,
      },
    ],
    base_resp: { status_code: 0, status_msg: "success" },
  }, { source: "https://api.minimaxi.com/v1/token_plan/remains" });

  assert.ok(usage, "expected usage to be returned");
  assert.equal(usage.provider, "minimax");
  assert.equal(usage.planType, "general", "should pick `general` over first model");
  const fiveHour = usage.windows.find((w) => w.name === "five_hour");
  const sevenDay = usage.windows.find((w) => w.name === "seven_day");
  assert.equal(fiveHour.usedPercent, 2, "5h used = 100 - 98");
  assert.equal(sevenDay.usedPercent, 1, "7d used = 100 - 99");
});

test("usageFromMinimaxQuota uses count ratio when total_count > 0", () => {
  // A subscription that does report counts (e.g. a free tier with a call cap).
  const usage = usageFromMinimaxQuota({
    model_remains: [
      {
        model_name: "general",
        start_time: 1780297200000,
        end_time: 1780315200000,
        remains_time: 16138310,
        current_interval_total_count: 10,
        current_interval_usage_count: 4,
        current_interval_remaining_percent: 60,
        current_weekly_total_count: 100,
        current_weekly_usage_count: 25,
        current_weekly_remaining_percent: 75,
        weekly_start_time: 1780243200000,
        weekly_end_time: 1780848000000,
        weekly_remains_time: 548938310,
      },
    ],
    base_resp: { status_code: 0, status_msg: "success" },
  }, { source: "https://api.minimaxi.com/v1/token_plan/remains" });

  const fiveHour = usage.windows.find((w) => w.name === "five_hour");
  const sevenDay = usage.windows.find((w) => w.name === "seven_day");
  assert.equal(fiveHour.usedPercent, 40, "5h used = 4/10 * 100, count takes precedence");
  assert.equal(sevenDay.usedPercent, 25, "7d used = 25/100 * 100");
});

test("usageFromMinimaxQuota falls back to 0 when neither count nor percent is reported", () => {
  const usage = usageFromMinimaxQuota({
    model_remains: [
      {
        model_name: "general",
        start_time: 1780297200000,
        end_time: 1780315200000,
        remains_time: 16138310,
        current_interval_total_count: 0,
        current_interval_usage_count: 0,
        current_weekly_total_count: 0,
        current_weekly_usage_count: 0,
        weekly_start_time: 1780243200000,
        weekly_end_time: 1780848000000,
        weekly_remains_time: 548938310,
      },
    ],
    base_resp: { status_code: 0, status_msg: "success" },
  }, { source: "https://api.minimaxi.com/v1/token_plan/remains" });

  const fiveHour = usage.windows.find((w) => w.name === "five_hour");
  const sevenDay = usage.windows.find((w) => w.name === "seven_day");
  assert.equal(fiveHour.usedPercent, 0);
  assert.equal(sevenDay.usedPercent, 0);
});

test("usageFromMinimaxQuota rejects empty model_remains", () => {
  const usage = usageFromMinimaxQuota({
    model_remains: [],
    base_resp: { status_code: 0, status_msg: "success" },
  }, { source: "https://api.minimaxi.com/v1/token_plan/remains" });

  assert.equal(usage, null);
});

test("usageFromKimiUsages maps 300-minute window to 5h and top-level usage to 7d", () => {
  // Real Kimi /coding/v1/usages response shape: all quota values are strings.
  const usage = usageFromKimiUsages({
    user: { membership: { level: "LEVEL_INTERMEDIATE" } },
    usage: { limit: "100", used: "2", remaining: "98", resetTime: "2026-07-26T02:38:49.743753Z" },
    limits: [
      {
        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
        detail: { limit: "100", used: "10", remaining: "90", resetTime: "2026-07-20T03:38:49.743753Z" },
      },
    ],
  }, { source: "https://api.kimi.com/coding/v1/usages" });

  assert.ok(usage, "expected usage to be returned");
  assert.equal(usage.provider, "kimi");
  assert.equal(usage.planType, "LEVEL_INTERMEDIATE");
  const fiveHour = usage.windows.find((w) => w.name === "five_hour");
  const sevenDay = usage.windows.find((w) => w.name === "seven_day");
  assert.equal(fiveHour.usedPercent, 10);
  assert.equal(fiveHour.windowMinutes, 300);
  assert.equal(sevenDay.usedPercent, 2);
  assert.equal(sevenDay.windowMinutes, 10080);
  assert.equal(sevenDay.resetsAt, "2026-07-26T02:38:49.743753Z");
});

test("usageFromKimiUsages accepts numeric quota values and derives total from used + remaining", () => {
  const usage = usageFromKimiUsages({
    usage: { limit: 0, used: 3, remaining: 7, resetTime: "2026-07-26T02:38:49.743753Z" },
    limits: [
      {
        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
        detail: { limit: 50, used: 25, remaining: 25, resetTime: "2026-07-20T03:38:49.743753Z" },
      },
    ],
  }, { source: "https://api.kimi.com/coding/v1/usages" });

  assert.ok(usage, "expected usage to be returned");
  const fiveHour = usage.windows.find((w) => w.name === "five_hour");
  const sevenDay = usage.windows.find((w) => w.name === "seven_day");
  assert.equal(fiveHour.usedPercent, 50, "5h used = 25/50 * 100");
  assert.equal(sevenDay.usedPercent, 30, "7d used = 3/(3+7) * 100 when limit is 0");
});

test("usageFromKimiUsages falls back to the shortest window when no 300-minute entry exists", () => {
  const usage = usageFromKimiUsages({
    usage: { limit: "100", used: "1", remaining: "99", resetTime: "2026-07-26T02:38:49.743753Z" },
    limits: [
      {
        window: { duration: 1440, timeUnit: "TIME_UNIT_MINUTE" },
        detail: { limit: "100", used: "40", remaining: "60", resetTime: "2026-07-21T03:38:49.743753Z" },
      },
      {
        window: { duration: 60, timeUnit: "TIME_UNIT_MINUTE" },
        detail: { limit: "100", used: "5", remaining: "95", resetTime: "2026-07-20T04:38:49.743753Z" },
      },
    ],
  }, { source: "https://api.kimi.com/coding/v1/usages" });

  assert.ok(usage, "expected usage to be returned");
  const fiveHour = usage.windows.find((w) => w.name === "five_hour");
  assert.equal(fiveHour.usedPercent, 5, "picks the shortest window as the short-window signal");
});

test("usageFromKimiUsages returns null when a window signal is missing", () => {
  assert.equal(usageFromKimiUsages({
    usage: { limit: "100", used: "2", remaining: "98", resetTime: "2026-07-26T02:38:49.743753Z" },
    limits: [],
  }, { source: "https://api.kimi.com/coding/v1/usages" }), null);

  assert.equal(usageFromKimiUsages({
    limits: [
      {
        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
        detail: { limit: "100", used: "10", remaining: "90", resetTime: "2026-07-20T03:38:49.743753Z" },
      },
    ],
  }, { source: "https://api.kimi.com/coding/v1/usages" }), null);

  assert.equal(usageFromKimiUsages({
    usage: { resetTime: "2026-07-26T02:38:49.743753Z" },
    limits: [
      {
        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
        detail: { limit: "100", used: "10", remaining: "90", resetTime: "2026-07-20T03:38:49.743753Z" },
      },
    ],
  }, { source: "https://api.kimi.com/coding/v1/usages" }), null);
});

test("readClaudeLanesKimiConfig finds the kimi.com lane regardless of index", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-kimi-lanes-"));
  const file = path.join(dir, "config.env");
  fs.writeFileSync(
    file,
    [
      "# Claude Code 模型配置",
      "CONFIG_0_BASE_URL=https://api.minimaxi.com/anthropic",
      "CONFIG_0_AUTH_TOKEN=sk-cp-minimax",
      "",
      "CONFIG_3_BASE_URL=https://api.kimi.com/coding/",
      "CONFIG_3_AUTH_TOKEN=sk-kimi-test",
      "CONFIG_3_MODEL=k3[1m]",
      "# CONFIG_4_BASE_URL=https://api.kimi.com/coding/",
      "# CONFIG_4_AUTH_TOKEN=sk-kimi-commented",
    ].join("\n"),
    "utf8",
  );

  assert.deepEqual(readClaudeLanesKimiConfig(file), {
    baseUrl: "https://api.kimi.com/coding/",
    apiKey: "sk-kimi-test",
  });
});

test("readClaudeLanesKimiConfig returns null without a kimi lane or file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-kimi-lanes-"));
  const file = path.join(dir, "config.env");
  fs.writeFileSync(
    file,
    "CONFIG_0_BASE_URL=https://api.minimaxi.com/anthropic\nCONFIG_0_AUTH_TOKEN=sk-cp-minimax\n",
    "utf8",
  );

  assert.equal(readClaudeLanesKimiConfig(file), null);
  assert.equal(readClaudeLanesKimiConfig(path.join(dir, "missing.env")), null);
});

test("resolveKimiConfig prefers config.json key and falls back to claude-lanes", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-kimi-resolve-"));
  const lanesDir = path.join(home, ".config", "claude-lanes");
  fs.mkdirSync(lanesDir, { recursive: true });
  fs.writeFileSync(
    path.join(lanesDir, "config.env"),
    "CONFIG_3_BASE_URL=https://api.kimi.com/coding/\nCONFIG_3_AUTH_TOKEN=sk-kimi-lanes\n",
    "utf8",
  );

  assert.deepEqual(resolveKimiConfig({ apiKey: "" }, home), {
    baseUrl: "https://api.kimi.com/coding/",
    apiKey: "sk-kimi-lanes",
  });
  assert.deepEqual(resolveKimiConfig({ apiKey: "sk-kimi-config" }, home), {
    baseUrl: "https://api.kimi.com/coding/",
    apiKey: "sk-kimi-config",
  });
  assert.deepEqual(resolveKimiConfig(undefined, home), {
    baseUrl: "https://api.kimi.com/coding/",
    apiKey: "sk-kimi-lanes",
  });
});
