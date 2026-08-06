import test from "node:test";
import assert from "node:assert/strict";

// Pin the timezone before exercising local-time formatting so the expected
// clock strings are deterministic on any machine. node --test runs each file
// in its own process, so this does not leak into other test files.
process.env.TZ = "Asia/Shanghai";

const { formatResetTime } = await import("../dist/format.js");

test("formatResetTime renders an absolute clock time for a same-day reset", () => {
  // 2026-05-08T03:00:00Z is 11:00 Asia/Shanghai; now is 09:00 the same day.
  assert.equal(
    formatResetTime("2026-05-08T03:00:00.000Z", new Date("2026-05-08T01:00:00.000Z")),
    "11:00",
  );
});

test("formatResetTime adds a day prefix for cross-day resets", () => {
  // 2026-05-12T00:00:00Z is 5/12 08:00 Asia/Shanghai.
  assert.equal(
    formatResetTime("2026-05-12T00:00:00.000Z", new Date("2026-05-08T01:00:00.000Z")),
    "5/12 08:00",
  );
});

test("formatResetTime reports due for elapsed or invalid timestamps", () => {
  assert.equal(formatResetTime("2026-05-08T03:00:00.000Z", new Date("2026-05-08T03:00:00.000Z")), "due");
  assert.equal(formatResetTime("2026-05-08T03:00:00.000Z", new Date("2026-05-09T00:00:00.000Z")), "due");
  assert.equal(formatResetTime("not-a-date", new Date("2026-05-08T00:00:00.000Z")), "due");
});

test("formatResetTime output does not drift while the reset is pending", () => {
  const early = formatResetTime("2026-05-08T03:00:00.000Z", new Date("2026-05-08T01:00:00.000Z"));
  const late = formatResetTime("2026-05-08T03:00:00.000Z", new Date("2026-05-08T01:01:30.000Z"));
  assert.equal(early, late);
});
