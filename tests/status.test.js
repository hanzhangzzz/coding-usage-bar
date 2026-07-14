import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildPaths } from "../dist/paths.js";
import { formatStatusRows } from "../dist/format.js";
import { loadDisplayStatusSnapshot } from "../dist/runtime.js";
import {
  createStatusSnapshot,
  loadStatusSnapshot,
  refreshStatusSnapshotFreshness,
  saveStatusSnapshot,
} from "../dist/status.js";

const usage = {
  provider: "codex",
  source: "test",
  observedAt: "2026-05-08T00:00:00.000Z",
  planType: "pro",
  windows: [
    { name: "five_hour", windowMinutes: 300, usedPercent: 92, resetsAt: "2026-05-08T02:00:00.000Z" },
    { name: "seven_day", windowMinutes: 10080, usedPercent: 41, resetsAt: "2026-05-12T00:00:00.000Z" },
  ],
};

test("createStatusSnapshot stores usage and analysis together", () => {
  const snapshot = createStatusSnapshot([usage], "low", {
    generatedAt: new Date("2026-05-08T00:00:00.000Z"),
    fixtureSamples: new Map([["codex", []]]),
    issues: [
      {
        provider: "claude",
        severity: "error",
        code: "CLAUDE_INGEST_MISSING",
        message: "missing",
      },
    ],
  });

  assert.equal(snapshot.profile, "low");
  assert.equal(snapshot.providers.length, 1);
  assert.equal(snapshot.providers[0].usage.provider, "codex");
  assert.equal(snapshot.providers[0].analysis.state, "LIMIT_RISK");
  assert.equal(snapshot.providers[0].meta.ageSeconds, 0);
  assert.equal(snapshot.providers[0].meta.stale, false);
  assert.equal(snapshot.issues[0].code, "CLAUDE_INGEST_MISSING");
});

test("formatStatusRows shows explicit usage bars", () => {
  const rows = formatStatusRows([usage], [{ provider: "codex", state: "RAW", profile: "low", observedAt: usage.observedAt, message: "raw" }]);

  assert.match(rows, /Provider\s+Period\s+Usage/);
  assert.match(rows, /\[#/);
  assert.match(rows, /92%/);
});

test("createStatusSnapshot marks stale provider data", () => {
  const snapshot = createStatusSnapshot([usage], "low", {
    generatedAt: new Date("2026-05-08T00:15:01.000Z"),
    fixtureSamples: new Map([["codex", []]]),
    staleAfterSeconds: 900,
  });

  assert.equal(snapshot.providers[0].meta.ageSeconds, 901);
  assert.equal(snapshot.providers[0].meta.stale, true);
  assert.equal(snapshot.issues[0].code, "USAGE_STALE");
});

test("refreshStatusSnapshotFreshness updates age without recollecting usage", () => {
  const snapshot = createStatusSnapshot([usage], "low", {
    generatedAt: new Date("2026-05-08T00:00:00.000Z"),
    fixtureSamples: new Map([["codex", []]]),
  });

  const refreshed = refreshStatusSnapshotFreshness(snapshot, {
    now: new Date("2026-05-08T00:20:00.000Z"),
    staleAfterSeconds: 600,
  });

  assert.equal(refreshed.generatedAt, snapshot.generatedAt);
  assert.equal(refreshed.providers[0].usage.source, "test");
  assert.equal(refreshed.providers[0].meta.ageSeconds, 1200);
  assert.equal(refreshed.providers[0].meta.stale, true);
  assert.equal(refreshed.issues.at(-1).code, "USAGE_STALE");
});

test("saveStatusSnapshot writes the stable status.json entry point", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-status-"));
  const paths = buildPaths(home);
  const snapshot = createStatusSnapshot([usage], "high", {
    generatedAt: new Date("2026-05-08T00:00:00.000Z"),
    fixtureSamples: new Map([["codex", []]]),
  });

  saveStatusSnapshot(snapshot, paths);

  const loaded = loadStatusSnapshot(paths);
  assert.equal(loaded.profile, "high");
  assert.equal(loaded.providers[0].usage.provider, "codex");
});

test("loadDisplayStatusSnapshot does not collect raw sources when status is missing", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-display-"));
  const paths = buildPaths(home);

  const snapshot = loadDisplayStatusSnapshot({ paths });

  assert.equal(snapshot.providers.length, 0);
  assert.equal(snapshot.issues[0].code, "STATUS_MISSING");
});
