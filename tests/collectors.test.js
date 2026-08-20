import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { usageFromClaudeStatusLine } from "../dist/claude.js";
import { collectCodexUsage } from "../dist/codex.js";
import { collectKimiUsage, probeKimiAccessFrozen, readClaudeLanesKimiConfig, resolveKimiConfig, usageFromKimiUsages } from "../dist/kimi.js";
import { usageFromMinimaxQuota } from "../dist/minimax.js";
import { usageFromGlmQuota } from "../dist/glm.js";

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

test("usageFromKimiUsages derives used from limit - remaining when Kimi omits the zero-valued used field", () => {
  // Fresh billing cycle / fresh 5h window with no usage yet: Kimi (proto3 JSON)
  // omits zero-valued fields, so the response only carries limit + remaining.
  const usage = usageFromKimiUsages({
    user: { membership: { level: "LEVEL_INTERMEDIATE" } },
    usage: { limit: "100", remaining: "100", resetTime: "2026-08-23T02:38:49.743753Z" },
    limits: [
      {
        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
        detail: { limit: "100", remaining: "100", resetTime: "2026-08-19T08:38:49.743753Z" },
      },
    ],
  }, { source: "https://api.kimi.com/coding/v1/usages" });

  assert.ok(usage, "expected usage to be returned");
  const fiveHour = usage.windows.find((w) => w.name === "five_hour");
  const sevenDay = usage.windows.find((w) => w.name === "seven_day");
  assert.equal(fiveHour.usedPercent, 0, "5h used derived as limit - remaining = 0");
  assert.equal(sevenDay.usedPercent, 0, "7d used derived as limit - remaining = 0");
});

test("usageFromKimiUsages derives partial usage when used is omitted but quota is consumed", () => {
  const usage = usageFromKimiUsages({
    usage: { limit: "100", used: "2", remaining: "98", resetTime: "2026-08-23T02:38:49.743753Z" },
    limits: [
      {
        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
        detail: { limit: "100", remaining: "25", resetTime: "2026-08-19T08:38:49.743753Z" },
      },
    ],
  }, { source: "https://api.kimi.com/coding/v1/usages" });

  assert.ok(usage, "expected usage to be returned");
  const fiveHour = usage.windows.find((w) => w.name === "five_hour");
  assert.equal(fiveHour.usedPercent, 75, "5h used derived as (100 - 25) / 100 * 100");
});

test("usageFromKimiUsages still returns null when used is omitted and limit cannot anchor a ratio", () => {
  assert.equal(usageFromKimiUsages({
    usage: { limit: "100", used: "2", remaining: "98", resetTime: "2026-08-23T02:38:49.743753Z" },
    limits: [
      {
        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
        detail: { remaining: "90", resetTime: "2026-08-19T08:38:49.743753Z" },
      },
    ],
  }, { source: "https://api.kimi.com/coding/v1/usages" }), null, "used omitted with no limit has no real signal");
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

const KIMI_USAGES_BODY = JSON.stringify({
  user: { membership: { level: "LEVEL_INTERMEDIATE" } },
  usage: { limit: "100", used: "5", remaining: "95", resetTime: "2026-08-23T02:38:49.743753Z" },
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: { limit: "100", used: "25", remaining: "75", resetTime: "2026-08-17T06:38:49.743753Z" },
    },
  ],
});

const KIMI_FROZEN_BODY = JSON.stringify({
  error: {
    message: "You've reached your usage limit for this billing cycle.",
    type: "access_terminated_error",
  },
});

function withMockFetch(handlers, fn) {
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async (url, init) => {
    const handler = handlers[Math.min(call, handlers.length - 1)];
    call += 1;
    return handler(String(url), init);
  };
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = originalFetch;
  });
}

test("probeKimiAccessFrozen detects the billing-cycle 403 freeze", async () => {
  await withMockFetch([() => new Response(KIMI_FROZEN_BODY, { status: 403 })], async () => {
    assert.equal(await probeKimiAccessFrozen({ apiKey: "sk-kimi-test" }), true);
  });
});

test("probeKimiAccessFrozen returns false on model-not-found (healthy account)", async () => {
  await withMockFetch([
    () => new Response(JSON.stringify({ error: { type: "model_not_found_error" } }), { status: 404 }),
  ], async () => {
    assert.equal(await probeKimiAccessFrozen({ apiKey: "sk-kimi-test" }), false);
  });
});

test("probeKimiAccessFrozen returns false on unrelated 403 errors", async () => {
  await withMockFetch([
    () => new Response(JSON.stringify({ error: { type: "permission_error" } }), { status: 403 }),
  ], async () => {
    assert.equal(await probeKimiAccessFrozen({ apiKey: "sk-kimi-test" }), false);
  });
});

test("collectKimiUsage marks blocked while keeping 5h/7d window numbers", async () => {
  const calls = [];
  await withMockFetch([
    (url) => {
      calls.push(url);
      return new Response(KIMI_USAGES_BODY, { status: 200 });
    },
    (url, init) => {
      calls.push(url);
      const body = JSON.parse(init.body);
      assert.equal(body.model, "coding-usage-bar-access-probe");
      assert.equal(body.max_tokens, 1);
      return new Response(KIMI_FROZEN_BODY, { status: 403 });
    },
  ], async () => {
    const usage = await collectKimiUsage({ apiKey: "sk-kimi-test" });
    assert.equal(usage.provider, "kimi");
    assert.ok(usage.blocked, "blocked marker is set");
    assert.match(usage.blocked.reason, /monthly quota/);
    assert.equal(usage.windows.find((w) => w.name === "five_hour").usedPercent, 25);
    assert.equal(usage.windows.find((w) => w.name === "seven_day").usedPercent, 5);
    assert.deepEqual(calls, [
      "https://api.kimi.com/coding/v1/usages",
      "https://api.kimi.com/coding/v1/chat/completions",
    ]);
  });
});

test("collectKimiUsage stays unblocked when the probe request errors", async () => {
  await withMockFetch([
    () => new Response(KIMI_USAGES_BODY, { status: 200 }),
    () => {
      throw new Error("network down");
    },
  ], async () => {
    const usage = await collectKimiUsage({ apiKey: "sk-kimi-test" });
    assert.equal(usage.blocked, undefined);
    assert.equal(usage.windows.find((w) => w.name === "five_hour").usedPercent, 25);
  });
});

test("collectKimiUsage stays unblocked when the probe reports a healthy account", async () => {
  await withMockFetch([
    () => new Response(KIMI_USAGES_BODY, { status: 200 }),
    () => new Response(JSON.stringify({ error: { type: "model_not_found_error" } }), { status: 404 }),
  ], async () => {
    const usage = await collectKimiUsage({ apiKey: "sk-kimi-test" });
    assert.equal(usage.blocked, undefined);
    assert.equal(usage.windows.find((w) => w.name === "five_hour").usedPercent, 25);
  });
});

test("usageFromGlmQuota keeps a fresh zero-usage window whose nextResetTime is omitted", () => {
  // Regression: GLM omits nextResetTime for a fresh window with zero usage
  // (observed live 2026-08-20). The old code hit
  // new Date(undefined).toISOString() -> RangeError("Invalid time value"),
  // failing the whole live collection and forcing the cache fallback. The
  // zero percentage is a real signal: keep the window, fall back to
  // observedAt for the reset time (renders as "reset due").
  const usage = usageFromGlmQuota({
    success: true,
    data: {
      level: "max",
      limits: [
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 0 },
        { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 9, nextResetTime: Date.parse("2026-08-25T21:37:35.998Z") },
        { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 1, nextResetTime: Date.parse("2026-08-30T21:37:35.998Z") },
      ],
    },
  }, { source: "test", observedAt: "2026-08-20T08:00:00.000Z" });
  assert.ok(usage, "zero-usage window must not fail the collection");
  assert.equal(usage.windows[0].name, "five_hour");
  assert.equal(usage.windows[0].usedPercent, 0);
  assert.equal(usage.windows[0].resetsAt, "2026-08-20T08:00:00.000Z");
  assert.equal(usage.windows[1].name, "seven_day");
  assert.equal(usage.windows[1].usedPercent, 9);
  assert.equal(usage.windows[1].resetsAt, "2026-08-25T21:37:35.998Z");
});

test("usageFromGlmQuota identifies windows by unit/number shape, not reset order", () => {
  // The weekly entry deliberately resets EARLIER than the five-hour entry:
  // a pure reset-time sort would swap them.
  const usage = usageFromGlmQuota({
    success: true,
    data: {
      level: "max",
      limits: [
        { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 9, nextResetTime: Date.parse("2026-08-20T10:00:00Z") },
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 42, nextResetTime: Date.parse("2026-08-21T10:00:00Z") },
      ],
    },
  }, { source: "test" });
  assert.ok(usage);
  assert.equal(usage.windows[0].name, "five_hour");
  assert.equal(usage.windows[0].usedPercent, 42);
  assert.equal(usage.windows[1].usedPercent, 9);
});

test("usageFromGlmQuota still returns null when token windows are missing", () => {
  const usage = usageFromGlmQuota({
    success: true,
    data: {
      level: "max",
      limits: [
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 0 },
        { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 1, nextResetTime: Date.parse("2026-08-30T21:37:35.998Z") },
      ],
    },
  }, { source: "test" });
  assert.equal(usage, null);
});
