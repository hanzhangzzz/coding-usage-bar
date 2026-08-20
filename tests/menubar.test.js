import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { renderMenuBar, swiftBarStatusItemVisibilityKeys, readCompactMode, toggleCompactMode, resetGlyphSetCache } from "../dist/menubar.js";
import { buildPaths } from "../dist/paths.js";
import { encodePNG } from "../dist/png.js";
import { GLYPH_STYLES } from "../dist/glyphs.js";

function freshPaths() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-menubar-"));
  return buildPaths(home);
}

// Minimal glyph fixture: every style resolves every character to the same
// white cell via the "?" fallback, which is enough for structural assertions
// (card emitted, byte-stable) without running the osascript bake.
function writeFixtureGlyphs(paths) {
  fs.mkdirSync(paths.glyphsDir, { recursive: true });
  const cellH = 8;
  const rgba = new Uint8Array(8 * cellH * 4);
  for (let i = 0; i < 8 * cellH; i++) {
    rgba[i * 4] = 255;
    rgba[i * 4 + 1] = 255;
    rgba[i * 4 + 2] = 255;
    rgba[i * 4 + 3] = 200;
  }
  const png = encodePNG(rgba, 8, cellH);
  const styles = {};
  for (const style of GLYPH_STYLES) {
    fs.writeFileSync(path.join(paths.glyphsDir, `${style.key}.png`), png);
    styles[style.key] = {
      px: style.px,
      weight: style.weight,
      ascent: 5,
      descent: 1,
      pad: 2,
      cellH,
      glyphs: { "?": { x: 0, w: 8, adv: 4 } },
    };
  }
  fs.writeFileSync(path.join(paths.glyphsDir, "metrics.json"), JSON.stringify({ version: 1, styles }));
}

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
  const output = renderMenuBar(snapshot, freshPaths());

  assert.match(output, /^ \| image=[A-Za-z0-9+/=]+,[A-Za-z0-9+/=]+ width=\d+ height=22 dropdown=false tooltip=5H:0%,7D:35%\\ │\\ 5H:31%,7D:69%/);
  assert.match(output, /\n---\n/);
  assert.match(output, /Coding Usage Bar \| color=#111827,#F9FAFB size=15 sfimage=flame\.fill/);
  assert.match(output, /Codex  Low \| sfimage=[a-z.]+ color=#111827,#F9FAFB size=14/);
  assert.match(output, /Claude  Fast \| sfimage=[a-z.]+ color=#111827,#F9FAFB size=14/);
  assert.match(output, /5h[^\n]*0%[^\n]*reset/);
  assert.match(output, /7d[^\n]*35%[^\n]*reset/);
  assert.match(output, /WARNING  Claude not connected \| color=#FF9F0A,#FFD60A size=13 sfimage=exclamationmark\.triangle\.fill/);
  assert.match(output, /Refresh now \| refresh=true color=#111827,#F9FAFB sfimage=arrow\.clockwise/);
  assert.doesNotMatch(output, /shortcut=/);
});

test("renderMenuBar title keeps provider icons scoped to their usage segments", () => {
  const output = renderMenuBar(snapshot, freshPaths());
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

  const output = renderMenuBar(weeklyOnly, freshPaths());
  assert.match(output, /tooltip=7D:52%/);
  assert.match(output, /Codex  Learning/);
  assert.match(output, /7d[^\n]*52%[^\n]*reset/);
  assert.doesNotMatch(output, /\n5h\s/);
  assert.match(output, /Codex 5h usage unavailable; showing 7d only\./);
});

test("renderMenuBar output is byte-identical across renders while the snapshot is unchanged", () => {
  // The two render times are 90s apart and cross a minute boundary: any
  // countdown or wall-clock age text that sneaks back into the output makes
  // these renders differ, which defeats SwiftBar's unchanged-content guard and
  // repaints the menu bar every minute (WindowServer spikes) even though the
  // usage data is unchanged.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-render-"));
  const paths = buildPaths(home);
  const first = renderMenuBar(snapshot, paths, new Date("2026-05-08T01:00:00.000Z"));
  const second = renderMenuBar(snapshot, paths, new Date("2026-05-08T01:01:30.000Z"));
  assert.equal(first, second);
  assert.doesNotMatch(first, /Data age/);
  assert.match(first, /Data fresh/);
});

test("renderMenuBar marks elapsed reset windows as due instead of a countdown", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-render-"));
  const paths = buildPaths(home);
  const output = renderMenuBar(snapshot, paths, new Date("2026-05-20T00:00:00.000Z"));
  assert.match(output, /reset due/);
  assert.doesNotMatch(output, /reset \d+m/);
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
  const output = renderMenuBar(snapshot, freshPaths());
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

const blockedKimiProvider = {
  usage: {
    provider: "kimi",
    source: "test",
    observedAt: "2026-08-17T05:44:09.817Z",
    blocked: { reason: "monthly quota exhausted; access frozen until the next billing cycle" },
    windows: [
      { name: "five_hour", windowMinutes: 300, usedPercent: 25, resetsAt: "2026-08-17T06:38:49.743753Z" },
      { name: "seven_day", windowMinutes: 10080, usedPercent: 5, resetsAt: "2026-08-23T02:38:49.743753Z" },
    ],
  },
  analysis: {
    provider: "kimi",
    state: "OVER_BURN",
    profile: "low",
    observedAt: "2026-08-17T05:44:09.817Z",
    fiveHour: { name: "five_hour", windowMinutes: 300, usedPercent: 25, resetsAt: "2026-08-17T06:38:49.743753Z" },
    sevenDay: { name: "seven_day", windowMinutes: 10080, usedPercent: 5, resetsAt: "2026-08-23T02:38:49.743753Z" },
    message: "Kimi 5h usage is above target.",
  },
  meta: {
    source: "test",
    observedAt: "2026-08-17T05:44:09.817Z",
    ageSeconds: 0,
    stale: false,
  },
};

test("renderMenuBar shows Blocked for a frozen kimi account and keeps window numbers", () => {
  const output = renderMenuBar({
    ...snapshot,
    providers: [...snapshot.providers, blockedKimiProvider],
  }, freshPaths());
  assert.match(output, /Kimi  Blocked/);
  assert.match(output, /badge=Frozen/);
  assert.match(output, /Blocked  monthly quota exhausted; access frozen until the next billing cycle/);
  // Window rows must stay untouched: same numbers, same reset labels.
  assert.match(output, /5h[^\n]* 25%/);
  assert.match(output, /7d[^\n]* {2}5%/);
});

test("renderMenuBar keeps the burn-state label for unblocked providers", () => {
  const output = renderMenuBar(snapshot, freshPaths());
  assert.doesNotMatch(output, /badge=Frozen/);
  assert.doesNotMatch(output, /monthly quota exhausted/);
});

// Regression guard for the WindowServer repaint storm: SwiftBar's menu
// rebuild cost scales with the number of image-bearing menu items, so the
// dropdown must never carry more than the single composite card image.
test("renderMenuBar renders the dropdown as a single card image when glyph atlases exist", () => {
  const paths = freshPaths();
  writeFixtureGlyphs(paths);
  resetGlyphSetCache();
  try {
    const output = renderMenuBar(snapshot, paths, new Date("2026-05-08T01:00:00.000Z"));
    const dropdownImageLines = output.split("\n").slice(1).filter((entry) => / image=/.test(entry));
    assert.equal(dropdownImageLines.length, 1, "dropdown must contain exactly one card image item");
    assert.match(dropdownImageLines[0], /^ \| image=[A-Za-z0-9+/=]+,[A-Za-z0-9+/=]+ width=460 height=\d+/);
    // Provider text rows collapse into the card; interactive rows stay text.
    assert.doesNotMatch(output, /Codex {2}Low \|/);
    assert.match(output, /Refresh now \| refresh=true/);
    // Staleness lives in the card's per-provider "updated" labels now; the
    // wide warning text rows would stretch the menu past the card width.
    assert.doesNotMatch(output, /WARNING/);
    const withError = renderMenuBar({
      ...snapshot,
      issues: [
        ...snapshot.issues,
        { provider: "glm", severity: "error", code: "GLM_API_KEY_MISSING", message: "GLM API key missing" },
      ],
    }, paths, new Date("2026-05-08T01:00:00.000Z"));
    assert.match(withError, /ERROR {2}GLM API key not set/);
    assert.doesNotMatch(withError, /WARNING/);
    const second = renderMenuBar(snapshot, paths, new Date("2026-05-08T01:01:30.000Z"));
    assert.equal(output, second, "card output must stay byte-identical while the snapshot is unchanged");
  } finally {
    resetGlyphSetCache();
  }
});

test("renderMenuBar dropdown stays image-free without glyph atlases", () => {
  const paths = freshPaths();
  resetGlyphSetCache();
  try {
    const output = renderMenuBar(snapshot, paths);
    const dropdownImageLines = output.split("\n").slice(1).filter((entry) => / image=/.test(entry));
    assert.equal(dropdownImageLines.length, 0, "text fallback must not emit any dropdown images");
    assert.match(output, /Codex {2}Low \| sfimage=/);
  } finally {
    resetGlyphSetCache();
  }
});
