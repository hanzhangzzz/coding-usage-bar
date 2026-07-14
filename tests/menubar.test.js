import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { renderMenuBar, swiftBarStatusItemVisibilityKeys, readCompactMode, toggleCompactMode } from "../dist/menubar.js";
import { buildPaths } from "../dist/paths.js";

const codexProvider = {
  usage: {
    provider: "codex",
    source: "test",
    observedAt: "2026-05-08T00:00:00.000Z",
    windows: [
      { name: "five_hour", windowMinutes: 300, usedPercent: 0, resetsAt: "2026-05-08T03:00:00.000Z" },
      { name: "seven_day", windowMinutes: 10080, usedPercent: 35, resetsAt: "2026-05-12T00:00:00.000Z" },
    ],
  },
  analysis: {
    provider: "codex",
    state: "UNDER_BURN",
    profile: "low",
    observedAt: "2026-05-08T00:00:00.000Z",
    fiveHour: { name: "five_hour", windowMinutes: 300, usedPercent: 0, resetsAt: "2026-05-08T03:00:00.000Z" },
    sevenDay: { name: "seven_day", windowMinutes: 10080, usedPercent: 35, resetsAt: "2026-05-12T00:00:00.000Z" },
    target: {
      minPercent: 3,
      maxPercent: 4.2,
      recommendedPercent: 3.8,
      conversionRate: 1,
    },
    message: "Codex 5h usage is below target.",
  },
  meta: {
    source: "test",
    observedAt: "2026-05-08T00:00:00.000Z",
    ageSeconds: 10,
    stale: false,
  },
};

const claudeProvider = {
  usage: {
    provider: "claude",
    source: "test",
    observedAt: "2026-05-08T00:00:00.000Z",
    windows: [
      { name: "five_hour", windowMinutes: 300, usedPercent: 31, resetsAt: "2026-05-08T03:00:00.000Z" },
      { name: "seven_day", windowMinutes: 10080, usedPercent: 69, resetsAt: "2026-05-12T00:00:00.000Z" },
    ],
  },
  analysis: {
    provider: "claude",
    state: "OVER_BURN",
    profile: "low",
    observedAt: "2026-05-08T00:00:00.000Z",
    fiveHour: { name: "five_hour", windowMinutes: 300, usedPercent: 31, resetsAt: "2026-05-08T03:00:00.000Z" },
    sevenDay: { name: "seven_day", windowMinutes: 10080, usedPercent: 69, resetsAt: "2026-05-12T00:00:00.000Z" },
    target: {
      minPercent: 14,
      maxPercent: 20,
      recommendedPercent: 17,
      conversionRate: 1,
    },
    message: "Claude 5h usage is above target.",
  },
  meta: {
    source: "test",
    observedAt: "2026-05-08T00:00:00.000Z",
    ageSeconds: 10,
    stale: false,
  },
};

const snapshot = {
  generatedAt: "2026-05-08T00:00:00.000Z",
  profile: "low",
  providers: [
    claudeProvider,
    codexProvider,
  ],
  issues: [
    {
      provider: "claude",
      severity: "warning",
      code: "CLAUDE_INGEST_MISSING",
      message: "missing",
    },
  ],
};

function pngInfoFromBase64(value) {
  const buffer = Buffer.from(value, "base64");
  const chunks = new Map();
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    chunks.set(type, buffer.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const header = chunks.get("IHDR");
  assert.ok(header, "PNG image is missing IHDR");
  return {
    width: header.readUInt32BE(0),
    height: header.readUInt32BE(4),
  };
}

test("renderMenuBar outputs SwiftBar-compatible status text", () => {
  const output = renderMenuBar(snapshot);

  assert.match(output, /^ \| image=[A-Za-z0-9+/=]+,[A-Za-z0-9+/=]+ width=\d+ height=22 dropdown=false tooltip=5H:0%,7D:35%\\ │\\ 5H:31%,7D:69%/);
  assert.match(output, /\n---\n/);
  assert.match(output, /Coding Usage Bar \| color=#111827,#F9FAFB size=15 sfimage=flame\.fill/);
  assert.match(output, /Codex  Low \| image=[A-Za-z0-9+/=]+ color=#111827,#F9FAFB size=14/);
  assert.match(output, /Claude  Fast \| image=[A-Za-z0-9+/=]+ color=#111827,#F9FAFB size=14/);
  assert.match(output, /5h[^\n]*0%[^\n]*reset/);
  assert.match(output, /7d[^\n]*35%[^\n]*reset/);
  assert.match(output, /WARNING  Claude not connected \| color=#FF9F0A,#FFD60A size=13 sfimage=exclamationmark\.triangle\.fill/);
  assert.match(output, /Refresh now \| refresh=true color=#111827,#F9FAFB sfimage=arrow\.clockwise/);
  assert.doesNotMatch(output, /shortcut=/);
});

test("renderMenuBar title keeps provider icons scoped to their usage segments", () => {
  const output = renderMenuBar(snapshot);
  const titleLine = output.split("\n")[0];
  const imageParam = titleLine.match(/image=([^ ]+)/)?.[1];
  assert.ok(imageParam, "title line should include a composite image");

  assert.match(titleLine, /^ \| image=/);
  assert.match(titleLine, / width=\d+ height=22 dropdown=false /);
  assert.match(titleLine, /tooltip=5H:0%,7D:35%\\ │\\ 5H:31%,7D:69%/);
  for (const encodedImage of imageParam.split(",")) {
    const image = pngInfoFromBase64(encodedImage);
    assert.equal(image.height, 44);
    assert.ok(image.width > 240, "title image should include both provider segments at 2x");
    assert.ok(image.width < 520, "title image should stay within normal menu bar width at 2x");
  }
});

test("renderMenuBar shows current Codex 7d usage without a synthetic 5h row", () => {
  const weeklyOnly = {
    generatedAt: "2026-07-14T01:51:00.000Z",
    profile: "low",
    providers: [
      {
        usage: {
          provider: "codex",
          source: "test",
          observedAt: "2026-07-14T01:50:43.493Z",
          planType: "prolite",
          windows: [
            { name: "seven_day", windowMinutes: 10080, usedPercent: 52, resetsAt: "2026-07-20T01:46:56.000Z" },
          ],
        },
        analysis: {
          provider: "codex",
          state: "RAW",
          profile: "low",
          observedAt: "2026-07-14T01:50:43.493Z",
          sevenDay: { name: "seven_day", windowMinutes: 10080, usedPercent: 52, resetsAt: "2026-07-20T01:46:56.000Z" },
          message: "Codex 5h usage unavailable; showing 7d only.",
        },
        meta: {
          source: "test",
          observedAt: "2026-07-14T01:50:43.493Z",
          ageSeconds: 17,
          stale: false,
        },
      },
    ],
    issues: [],
  };

  const output = renderMenuBar(weeklyOnly);
  assert.match(output, /tooltip=7D:52%/);
  assert.match(output, /Codex  Learning/);
  assert.match(output, /7d\s+52%\s+reset/);
  assert.doesNotMatch(output, /\n5h\s/);
  assert.match(output, /Codex 5h usage unavailable; showing 7d only\./);
});

test("swiftBarStatusItemVisibilityKeys finds hidden status item cache keys", () => {
  const output = `{
    MakePluginExecutable = 1;
    "NSStatusItem Visible Item-0" = 0;
    "NSStatusItem Visible Item-1" = 1;
    "NSStatusItem Preferred Position com.example.one" = 12;
    PluginDirectory = "/tmp/swiftbar";
  }`;

  assert.deepEqual(swiftBarStatusItemVisibilityKeys(output), [
    "NSStatusItem Visible Item-0",
    "NSStatusItem Visible Item-1",
  ]);
});

test("toggleCompactMode creates and removes compact mode file", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-menubar-"));
  const paths = buildPaths(home);
  const compactFile = path.join(paths.stateDir, "compact-mode");
  assert.equal(readCompactMode(paths), false);

  const firstToggle = toggleCompactMode(paths);
  assert.equal(firstToggle, true);
  assert.equal(readCompactMode(paths), true);
  assert.ok(fs.existsSync(compactFile));

  const secondToggle = toggleCompactMode(paths);
  assert.equal(secondToggle, false);
  assert.equal(readCompactMode(paths), false);
  assert.ok(!fs.existsSync(compactFile));
});

test("renderMenuBar shows Collapse toggle in full mode", () => {
  const output = renderMenuBar(snapshot);
  assert.match(output, /Collapse \| bash=.* param1=.* param2=menubar param3=toggle-compact terminal=false refresh=true/);
  assert.doesNotMatch(output, /Expand \| bash=.* param1=.* param2=menubar param3=toggle-compact/);
});

test("renderMenuBar shows Expand toggle in compact mode", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-menubar-"));
  const paths = buildPaths(home);
  // Enable compact mode
  toggleCompactMode(paths);
  try {
    assert.equal(readCompactMode(paths), true);
    const output = renderMenuBar(snapshot, paths);
    assert.match(output, /Expand \| bash=.* param1=.* param2=menubar param3=toggle-compact terminal=false refresh=true/);
    assert.doesNotMatch(output, /Collapse \| bash=.* param1=.* param2=menubar param3=toggle-compact/);
    // Compact title should have sfimage=flame.fill without image= or wide text
    const titleLine = output.split("\n")[0];
    assert.match(titleLine, /sfimage=flame\.fill/);
    assert.doesNotMatch(titleLine, /image=[A-Za-z0-9+/=]+,[A-Za-z0-9+/=]+/);
  } finally {
    // Restore full mode
    toggleCompactMode(paths);
  }
});
