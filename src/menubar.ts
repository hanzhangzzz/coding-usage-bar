import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureDir, isFile } from "./fs-util.js";
import { formatDurationUntil, formatProviderLabel } from "./format.js";
import { buildPaths } from "./paths.js";
import { stableNodeExecutable } from "./node-runtime.js";
import { loadDisplayStatusSnapshot } from "./runtime.js";
import { BurnState, RuntimePaths, StatusSnapshot } from "./types.js";

const MARKER = "coding-usage-bar managed SwiftBar plugin";
const SWIFTBAR_APP_PATHS = ["/Applications/SwiftBar.app", path.join(process.env.HOME ?? "", "Applications", "SwiftBar.app")];

const STATE_LABEL: Record<BurnState, string> = {
  RAW: "Learning",
  UNDER_BURN: "Low",
  ON_TRACK: "On Track",
  OVER_BURN: "Fast",
  LIMIT_RISK: "Limit",
};

// Local provider marks keep SwiftBar rendering offline; see THIRD_PARTY_NOTICES.md.
const PROVIDER_ICON_ASSET: Record<string, string> = {
  claude: "provider-claude.png",
  codex: "provider-codex.png",
  glm: "provider-glm.png",
  deepseek: "provider-deepseek.png",
  minimax: "provider-minimax.png",
};

const PROVIDER_ICON_DARK_ASSET: Record<string, string> = {
  glm: "provider-glm-dark.png",
};

const PROVIDER_ICON_FALLBACK: Record<string, string> = {
  claude: "sparkles",
  codex: "curlybraces.square.fill",
  glm: "cpu",
  deepseek: "bubble.left.and.bubble.right",
  minimax: "waveform.path.ecg",
};

const TITLE_ICON_ASSET = "provider-marks.png";

const ALERT_COLOR = "#D97757,#E8956E";
const WARNING_COLOR = "#FF9F0A,#FFD60A";
const OK_COLOR = "#248A3D,#30D158";
const RAW_COLOR = "#248A3D,#30D158";

const STATE_COLOR: Record<BurnState, string> = {
  RAW: RAW_COLOR,
  UNDER_BURN: WARNING_COLOR,
  ON_TRACK: OK_COLOR,
  OVER_BURN: ALERT_COLOR,
  LIMIT_RISK: ALERT_COLOR,
};

const STATE_PRIORITY: Record<BurnState, number> = {
  LIMIT_RISK: 0,
  OVER_BURN: 1,
  UNDER_BURN: 2,
  RAW: 3,
  ON_TRACK: 4,
};

const TEXT_COLOR = "#111827,#F9FAFB";
const MUTED_COLOR = "#6B7280,#A1A1AA";
const ROW_FONT = "Menlo";
const TITLE_PROVIDER_ORDER = ["codex", "claude", "glm", "deepseek", "minimax"];
const TITLE_SEPARATOR = "│";
const METER_WIDTH = 12;
const ASSET_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "assets");
const imageCache = new Map<string, string | null>();
const TITLE_IMAGE_SCALE = 2;
const titleImageCache = new Map<string, { image: string; width: number; height: number } | null>();

const TITLE_IMAGE_SCRIPT = `
ObjC.import('AppKit');
ObjC.import('CoreGraphics');

function drawImage(payload, variant, mode) {
  var scale = payload.scale || 1;
  var height = payload.height * scale;
  var iconSize = payload.iconSize * scale;
  var paddingX = payload.paddingX * scale;
  var iconBarGap = payload.iconBarGap * scale;
  var segmentGap = payload.segmentGap * scale;
  var barWidth = payload.barWidth * scale;
  var barHeight = payload.barHeight * scale;
  var barGap = payload.barGap * scale;
  var barRadius = payload.barRadius * scale;
  var barMinFill = (payload.barMinFill || barRadius * 2) * scale;
  var dividerW = 1 * scale;

  var width = paddingX * 2;
  payload.segments.forEach(function(seg, idx) {
    if (idx > 0) width += segmentGap + dividerW + segmentGap;
    width += (seg.iconPath ? iconSize + iconBarGap : 0) + barWidth;
  });
  width = Math.max(payload.minWidth * scale, width);

  var rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBitmapFormatBytesPerRowBitsPerPixel(
    null, width, height, 8, 4, true, false, $.NSDeviceRGBColorSpace, $.NSBitmapFormatAlphaPremultipliedLast, 0, 0
  );
  var nsctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);
  $.NSGraphicsContext.setCurrentContext(nsctx);
  nsctx.setShouldAntialias(true);
  nsctx.setImageInterpolation($.NSImageInterpolationHigh);
  var cg = nsctx.CGContext;

  function setFill(hex, alpha) {
    var v = hex.replace('#', '');
    $.CGContextSetRGBFillColor(cg,
      parseInt(v.slice(0, 2), 16) / 255,
      parseInt(v.slice(2, 4), 16) / 255,
      parseInt(v.slice(4, 6), 16) / 255,
      alpha !== undefined ? alpha : 1);
  }

  function fillRoundedRect(rx, ry, rw, rh, rr) {
    var p = $.CGPathCreateWithRoundedRect($.CGRectMake(rx, ry, rw, rh), rr, rr, null);
    $.CGContextAddPath(cg, p);
    $.CGContextFillPath(cg);
  }

  var x = paddingX;
  var iconY = Math.floor((height - iconSize) / 2);

  payload.segments.forEach(function(seg, idx) {
    if (idx > 0) {
      x += segmentGap;
      setFill(variant.dividerColor, variant.dividerAlpha);
      $.CGContextFillRect(cg, $.CGRectMake(x, Math.floor(height * 0.2), dividerW, Math.floor(height * 0.6)));
      x += dividerW + segmentGap;
    }
    var iconFile = (mode === 'dark' && seg.iconPathDark) ? seg.iconPathDark : seg.iconPath;
    if (iconFile) {
      var icon = $.NSImage.alloc.initWithContentsOfFile($(iconFile));
      if (icon) {
        icon.drawInRectFromRectOperationFraction(
          $.NSMakeRect(x, iconY, iconSize, iconSize),
          $.NSZeroRect, $.NSCompositingOperationSourceOver, 1
        );
      }
      x += iconSize + iconBarGap;
    }
    var bars = seg.bars || [];
    var totalH = bars.length * barHeight + Math.max(0, bars.length - 1) * barGap;
    var barY = Math.floor((height + totalH) / 2) - barHeight;
    for (var i = 0; i < bars.length; i++) {
      setFill(variant.barBgColor, variant.barBgAlpha);
      fillRoundedRect(x, barY, barWidth, barHeight, barRadius);
      if (bars[i].pct > 0) {
        var pct = Math.min(bars[i].pct, 100);
        var fw = Math.max(barMinFill, Math.round(barWidth * pct / 100));
        setFill(bars[i][mode + 'Color'], 1);
        fillRoundedRect(x, barY, fw, barHeight, barRadius);
      }
      barY -= barHeight + barGap;
    }
    x += barWidth;
  });

  var png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.alloc.init);
  return {
    image: ObjC.unwrap(png.base64EncodedStringWithOptions(0)),
    width: Math.ceil(width / scale),
    height: payload.height,
  };
}

function run(argv) {
  var payload = JSON.parse(argv[0]);
  return JSON.stringify({
    light: drawImage(payload, payload.light, 'light'),
    dark: drawImage(payload, payload.dark, 'dark'),
  });
}
`;

const DROPDOWN_BAR_SCRIPT = `
ObjC.import('AppKit');
ObjC.import('CoreGraphics');

function parseHex(hex) {
  var v = hex.replace('#', '');
  return [parseInt(v.slice(0,2),16)/255, parseInt(v.slice(2,4),16)/255, parseInt(v.slice(4,6),16)/255];
}

function makeBar(bw, bh, br, pct, fc, bgHex, bgAlpha) {
  var rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBitmapFormatBytesPerRowBitsPerPixel(
    null, bw, bh, 8, 4, true, false, $.NSDeviceRGBColorSpace, $.NSBitmapFormatAlphaPremultipliedLast, 0, 0);
  var nsctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);
  $.NSGraphicsContext.setCurrentContext(nsctx);
  nsctx.setShouldAntialias(true);
  var cg = nsctx.CGContext;
  var bg = parseHex(bgHex);
  $.CGContextSetRGBFillColor(cg, bg[0], bg[1], bg[2], bgAlpha);
  var bp = $.CGPathCreateWithRoundedRect($.CGRectMake(0,0,bw,bh), br, br, null);
  $.CGContextAddPath(cg, bp); $.CGContextFillPath(cg);
  if (pct > 0) {
    var fw = Math.max(br*2, Math.round(bw * Math.min(pct,100) / 100));
    $.CGContextSetRGBFillColor(cg, fc[0], fc[1], fc[2], 1);
    var fp = $.CGPathCreateWithRoundedRect($.CGRectMake(0,0,fw,bh), br, br, null);
    $.CGContextAddPath(cg, fp); $.CGContextFillPath(cg);
  }
  var png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.alloc.init);
  return ObjC.unwrap(png.base64EncodedStringWithOptions(0));
}

function run(argv) {
  var p = JSON.parse(argv[0]);
  var s = p.scale || 2;
  var bw = p.barWidth * s, bh = p.barHeight * s, br = p.barRadius * s;
  var results = [];
  for (var i = 0; i < p.bars.length; i++) {
    var bar = p.bars[i];
    var lc = parseHex(bar.lightColor), dc = parseHex(bar.darkColor);
    var li = makeBar(bw, bh, br, bar.pct, lc, p.light.barBgColor, p.light.barBgAlpha);
    var di = makeBar(bw, bh, br, bar.pct, dc, p.dark.barBgColor, p.dark.barBgAlpha);
    results.push(li + ',' + di);
  }
  return JSON.stringify({images: results, width: p.barWidth, height: p.barHeight});
}
`;

const dropdownBarCache = new Map<string, { images: string[]; width: number; height: number } | null>();

function renderDropdownBarImages(bars: Array<{ pct: number; lightColor: string; darkColor: string }>) {
  if (bars.length === 0) {
    return [];
  }
  const payload = {
    bars,
    scale: TITLE_IMAGE_SCALE,
    barWidth: 80,
    barHeight: 10,
    barRadius: 3,
    light: { barBgColor: "000000", barBgAlpha: 0.15 },
    dark: { barBgColor: "FFFFFF", barBgAlpha: 0.2 },
  };
  const cacheKey = JSON.stringify(payload);
  if (dropdownBarCache.has(cacheKey)) {
    const cached = dropdownBarCache.get(cacheKey);
    return cached ? cached.images.map((img) => ({ image: img, width: cached.width, height: cached.height })) : [];
  }
  try {
    const output = execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", DROPDOWN_BAR_SCRIPT, cacheKey], {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    const result = JSON.parse(output) as { images: string[]; width: number; height: number };
    dropdownBarCache.set(cacheKey, result);
    return result.images.map((img) => ({ image: img, width: result.width, height: result.height }));
  } catch {
    dropdownBarCache.set(cacheKey, null);
    return [];
  }
}

function appCliPath(paths: RuntimePaths) {
  return path.join(paths.stateDir, "app", "dist", "cli.js");
}

const COMPACT_MODE_FILE = "compact-mode";

function compactModeFilePath(paths: RuntimePaths) {
  return path.join(paths.stateDir, COMPACT_MODE_FILE);
}

export function readCompactMode(paths: RuntimePaths = buildPaths()): boolean {
  try {
    return fs.existsSync(compactModeFilePath(paths));
  } catch {
    return false;
  }
}

export function toggleCompactMode(paths: RuntimePaths = buildPaths()): boolean {
  const filePath = compactModeFilePath(paths);
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
    return false;
  }
  ensureDir(paths.stateDir);
  fs.writeFileSync(filePath, "");
  return true;
}

function configuredSwiftBarPluginDir(paths: RuntimePaths) {
  // Isolation escape hatch: an explicit CODING_USAGE_BAR_PLUGIN_DIR always wins and never
  // reads the global SwiftBar config. Tests set this to a temp dir so running the
  // suite (which exercises uninstall) can never delete the developer's live plugin.
  const override = process.env.CODING_USAGE_BAR_PLUGIN_DIR?.trim();
  if (override) {
    return override;
  }
  try {
    const configured = execFileSync("defaults", ["read", "com.ameba.SwiftBar", "PluginDirectory"], {
      encoding: "utf8",
    }).trim();
    return configured || paths.swiftBarPluginDir;
  } catch {
    return paths.swiftBarPluginDir;
  }
}

export function swiftBarPluginPath(paths: RuntimePaths = buildPaths()) {
  const pluginDir = configuredSwiftBarPluginDir(paths);
  return {
    dir: pluginDir,
    file: path.join(pluginDir, "coding-usage-bar.1m.js"),
  };
}

export function isSwiftBarInstalled() {
  return SWIFTBAR_APP_PATHS.some((appPath) => appPath && fs.existsSync(appPath));
}

function swiftBarAppPath() {
  return SWIFTBAR_APP_PATHS.find((appPath) => appPath && fs.existsSync(appPath)) ?? null;
}

function brewPath() {
  const candidates = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found) {
    return found;
  }
  try {
    return execFileSync("which", ["brew"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export function ensureSwiftBarInstalled(options: { dryRun?: boolean } = {}) {
  const dryRun = options.dryRun ?? false;
  if (isSwiftBarInstalled()) {
    return ["SwiftBar already installed."];
  }

  const brew = brewPath();
  if (!brew) {
    return ["SwiftBar is missing and Homebrew is unavailable; install SwiftBar manually, then run coding-usage-bar menubar install."];
  }

  if (dryRun) {
    return [`[dry-run] would install SwiftBar with ${brew} install --cask swiftbar`];
  }

  execFileSync(brew, ["install", "--cask", "swiftbar"], {
    env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1" },
    stdio: "inherit",
  });
  return ["Installed SwiftBar with Homebrew cask."];
}

export function openSwiftBar() {
  const appPath = swiftBarAppPath();
  if (!appPath) {
    return ["SwiftBar is not installed; skipping launch."];
  }
  try {
    execFileSync("osascript", ["-e", 'quit app "SwiftBar"'], { stdio: "ignore" });
  } catch {
    // SwiftBar may not be running yet.
  }
  try {
    execFileSync("open", [appPath], { stdio: "ignore" });
    execFileSync("sleep", ["1"], { stdio: "ignore" });
    return ["Opened SwiftBar.", ...clearSwiftBarStatusItemVisibility()];
  } catch (error) {
    return [`SwiftBar installed, but launch failed: ${error instanceof Error ? error.message : String(error)}`];
  }
}

export function addSwiftBarToLoginItems(options: { dryRun?: boolean } = {}) {
  const dryRun = options.dryRun ?? false;
  const appPath = swiftBarAppPath();
  if (!appPath) {
    return ["SwiftBar is not installed; skipping login item."];
  }

  try {
    const result = execFileSync("osascript", [
      "-e", 'tell application "System Events" to get the name of every login item',
    ], { encoding: "utf8" });
    if (result.includes("SwiftBar")) {
      return ["SwiftBar already in login items."];
    }
  } catch {
    // Permission or access issue; try to add anyway.
  }

  if (dryRun) {
    return [`[dry-run] would add SwiftBar to login items: ${appPath}`];
  }

  try {
    execFileSync("osascript", [
      "-e", `tell application "System Events" to make login item at end with properties {name:"SwiftBar", path:${JSON.stringify(appPath)}, hidden:false}`,
    ]);
    return ["Added SwiftBar to login items (auto-starts on login)."];
  } catch (error) {
    return [`Failed to add SwiftBar to login items: ${error instanceof Error ? error.message : String(error)}. Add manually in System Settings → General → Login Items.`];
  }
}

function swiftBarEscape(value: string) {
  return value.replaceAll("|", "\\|");
}

function swiftBarParamValue(value: string | number | boolean) {
  return String(value).replaceAll(" ", "\\ ");
}

function line(title: string, params: Record<string, string | number | boolean | undefined> = {}) {
  const renderedParams = Object.entries(params)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${swiftBarParamValue(value)}`);
  if (renderedParams.length === 0) {
    return swiftBarEscape(title);
  }
  return `${swiftBarEscape(title)} | ${renderedParams.join(" ")}`;
}

function imageAssetBase64(name: string) {
  if (imageCache.has(name)) {
    return imageCache.get(name);
  }
  try {
    const encoded = fs.readFileSync(path.join(ASSET_DIR, name)).toString("base64");
    imageCache.set(name, encoded);
    return encoded;
  } catch {
    imageCache.set(name, null);
    return null;
  }
}

function titleProviders(snapshot: StatusSnapshot) {
  return [...snapshot.providers].sort((left, right) => {
    const leftIndex = TITLE_PROVIDER_ORDER.indexOf(left.usage.provider);
    const rightIndex = TITLE_PROVIDER_ORDER.indexOf(right.usage.provider);
    const leftRank = leftIndex === -1 ? TITLE_PROVIDER_ORDER.length : leftIndex;
    const rightRank = rightIndex === -1 ? TITLE_PROVIDER_ORDER.length : rightIndex;
    return leftRank - rightRank;
  });
}

function titleSegment(provider: StatusSnapshot["providers"][number]) {
  const usage = provider.usage;
  if (usage.balance && usage.windows.length === 0) {
    const currency = usage.balance.currency === "CNY" ? "¥" : "$";
    return `${currency}${usage.balance.total}`;
  }
  const fiveHour = provider.analysis.fiveHour;
  const sevenDay = provider.analysis.sevenDay;
  const parts: string[] = [];
  if (fiveHour) {
    parts.push(`5H:${Math.round(fiveHour.usedPercent)}%`);
  }
  if (sevenDay) {
    parts.push(`7D:${Math.round(sevenDay.usedPercent)}%`);
  }
  return parts.join(",");
}

function titleBars(provider: StatusSnapshot["providers"][number]) {
  if (provider.usage.balance && provider.usage.windows.length === 0) {
    const isAvailable = provider.usage.balance.isAvailable;
    const [lightColor, darkColor] = (isAvailable ? OK_COLOR : ALERT_COLOR).split(",");
    return [{ pct: isAvailable ? 100 : 0, lightColor, darkColor }];
  }
  const state = provider.analysis.state;
  const [lightColor, darkColor] = STATE_COLOR[state].split(",");
  const fiveHour = provider.analysis.fiveHour;
  const sevenDay = provider.analysis.sevenDay;
  const bars: Array<{ pct: number; lightColor: string; darkColor: string }> = [];
  if (fiveHour) {
    bars.push({ pct: Math.round(fiveHour.usedPercent), lightColor, darkColor });
  }
  if (sevenDay) {
    bars.push({ pct: Math.round(sevenDay.usedPercent), lightColor, darkColor });
  }
  if (bars.length === 0) {
    bars.push({ pct: 0, lightColor, darkColor });
  }
  return bars;
}

function providerIconPath(provider: string) {
  const asset = PROVIDER_ICON_ASSET[provider];
  if (!asset) {
    return null;
  }
  const iconPath = path.join(ASSET_DIR, asset);
  return fs.existsSync(iconPath) ? iconPath : null;
}

function titleImageValue(providers: StatusSnapshot["providers"]) {
  const segments = providers.map((provider) => {
    const p = provider.usage.provider;
    const darkAsset = PROVIDER_ICON_DARK_ASSET[p];
    const darkPath = darkAsset ? path.join(ASSET_DIR, darkAsset) : null;
    return {
      provider: p,
      bars: titleBars(provider),
      iconPath: providerIconPath(p),
      iconPathDark: darkPath && fs.existsSync(darkPath) ? darkPath : null,
    };
  });
  if (segments.length === 0) {
    return null;
  }

  const payload = {
    segments,
    scale: TITLE_IMAGE_SCALE,
    height: 22,
    minWidth: 1,
    paddingX: 0,
    iconSize: 16,
    iconBarGap: 4,
    segmentGap: 8,
    barWidth: 48,
    barHeight: 4,
    barGap: 3,
    barRadius: 2,
    barMinFill: 6,
    light: {
      dividerColor: "000000",
      dividerAlpha: 0.25,
      barBgColor: "000000",
      barBgAlpha: 0.3,
    },
    dark: {
      dividerColor: "FFFFFF",
      dividerAlpha: 0.3,
      barBgColor: "FFFFFF",
      barBgAlpha: 0.25,
    },
  };
  const cacheKey = JSON.stringify(payload);
  if (titleImageCache.has(cacheKey)) {
    return titleImageCache.get(cacheKey);
  }

  try {
    const output = execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", TITLE_IMAGE_SCRIPT, cacheKey], {
      encoding: "utf8",
      timeout: 2500,
    }).trim();
    const images = JSON.parse(output) as {
      light?: { image?: string; width?: number; height?: number };
      dark?: { image?: string; width?: number; height?: number };
    };
    const value = images.light?.image && images.dark?.image && images.light.width && images.light.height
      ? {
        image: `${images.light.image},${images.dark.image}`,
        width: images.light.width,
        height: images.light.height,
      }
      : null;
    titleImageCache.set(cacheKey, value);
    return value;
  } catch {
    titleImageCache.set(cacheKey, null);
    return null;
  }
}

function targetLabel(provider: StatusSnapshot["providers"][number]) {
  const target = provider.analysis.target;
  if (!target) {
    return "Target learning baseline";
  }
  return `Target ${target.minPercent.toFixed(1)}-${target.maxPercent.toFixed(1)}%`;
}

function windowByName(provider: StatusSnapshot["providers"][number], name: "five_hour" | "seven_day") {
  return provider.usage.windows.find((window) => window.name === name);
}

function muted(text: string) {
  return line(text, { color: MUTED_COLOR, size: 12 });
}

function ansiRGB(hexPair: string, text: string) {
  const hex = (hexPair.split(",")[1] || hexPair).replace("#", "");
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

function coloredMeter(usedPercent: number, fillColor: string, width = METER_WIDTH) {
  const filled = Math.max(0, Math.min(width, Math.round((usedPercent / 100) * width)));
  const empty = width - filled;
  return (filled > 0 ? ansiRGB(fillColor, "█".repeat(filled)) : "")
    + (empty > 0 ? ansiRGB(MUTED_COLOR, "░".repeat(empty)) : "");
}

function usageLine(label: "5h" | "7d", usedPercent: number, resetsAt: string, color: string, barImage?: { image: string; width: number; height: number }) {
  const percent = `${Math.round(usedPercent).toString().padStart(3)}%`;
  if (barImage) {
    return line(`${label}  ${percent}  reset ${formatDurationUntil(resetsAt)}`, {
      image: barImage.image,
      width: barImage.width,
      height: barImage.height,
      color,
      font: ROW_FONT,
      size: 12,
    });
  }
  const bar = coloredMeter(usedPercent, color);
  return line(`${label}  ${bar}  ${ansiRGB(color, percent)}  reset ${formatDurationUntil(resetsAt)}`, {
    ansi: true,
    font: ROW_FONT,
    size: 12,
  });
}

function providerBadge(provider: StatusSnapshot["providers"][number]) {
  const fiveHour = provider.analysis.fiveHour;
  if (!fiveHour) {
    return STATE_LABEL[provider.analysis.state];
  }
  return `${Math.round(fiveHour.usedPercent)}%`;
}

function providerIconParams(provider: string) {
  const image = imageAssetBase64(PROVIDER_ICON_ASSET[provider] ?? "");
  if (image) {
    return { image };
  }
  return { sfimage: PROVIDER_ICON_FALLBACK[provider] ?? "terminal.fill" };
}

function titleIconParams() {
  const image = imageAssetBase64(TITLE_ICON_ASSET);
  if (image) {
    return { image };
  }
  return { sfimage: "flame.fill", sfcolor: RAW_COLOR };
}

function maxProviderAge(snapshot: StatusSnapshot) {
  return Math.max(0, ...snapshot.providers.map((item) => item.meta.ageSeconds));
}

function issueLabel(code: string) {
  if (code === "CLAUDE_INGEST_MISSING") {
    return "Claude not connected";
  }
  if (code === "GLM_API_KEY_MISSING") {
    return "GLM API key not set";
  }
  if (code === "DEEPSEEK_API_KEY_MISSING") {
    return "DeepSeek API key not set";
  }
  if (code === "MINIMAX_API_KEY_MISSING") {
    return "MiniMax API key not set";
  }
  if (code === "USAGE_STALE") {
    return "Usage data is stale";
  }
  if (code === "STATUS_MISSING") {
    return "Status not ready";
  }
  return code.replaceAll("_", " ").toLowerCase();
}

export function renderMenuBar(snapshot: StatusSnapshot = loadDisplayStatusSnapshot(), paths: RuntimePaths = buildPaths()) {
  const compact = readCompactMode(paths);
  const providers = titleProviders(snapshot);
  const title = providers.map(titleSegment).join(` ${TITLE_SEPARATOR} `);
  const toggleParams = {
    bash: stableNodeExecutable(),
    param1: appCliPath(paths),
    param2: "menubar",
    param3: "toggle-compact",
    terminal: false,
    refresh: true,
    color: TEXT_COLOR,
    sfimage: compact ? "rectangle.expand.vertical" : "rectangle.compress.vertical",
  };
  if (!title) {
    return [
      line("Coding Usage Bar  No Usage", { sfimage: "flame.fill", sfcolor: RAW_COLOR }),
      "---",
      line("No provider usage available", { color: MUTED_COLOR }),
      line(compact ? "Expand" : "Collapse", toggleParams),
      line("Refresh now", { refresh: true, color: TEXT_COLOR, sfimage: "arrow.clockwise" }),
    ].join("\n");
  }

  const topState = [...providers].sort((left, right) => (
    STATE_PRIORITY[left.analysis.state] - STATE_PRIORITY[right.analysis.state]
  ))[0]?.analysis.state
    ?? "RAW";
  const titleImage = titleImageValue(providers);
  const lines = [
    compact
      ? line("", {
        sfimage: "flame.fill",
        sfcolor: STATE_COLOR[topState],
        dropdown: false,
        tooltip: title,
      })
      : titleImage
      ? line("", {
        image: titleImage.image,
        width: titleImage.width,
        height: titleImage.height,
        dropdown: false,
        tooltip: title,
      })
      : line(title, {
        ...titleIconParams(),
        dropdown: false,
      }),
    "---",
    line("Coding Usage Bar", {
      color: TEXT_COLOR,
      size: 15,
      sfimage: "flame.fill",
      sfcolor: STATE_COLOR[topState],
      badge: snapshot.profile.toUpperCase(),
    }),
    muted(`Data age ${maxProviderAge(snapshot)}s`),
    "---",
  ];

  const barDataList: Array<{ pct: number; lightColor: string; darkColor: string }> = [];
  for (const item of providers) {
    if (item.usage.balance && item.usage.windows.length === 0) {
      continue;
    }
    const [lc, dc] = STATE_COLOR[item.analysis.state].split(",");
    const f = windowByName(item, "five_hour");
    const s = windowByName(item, "seven_day");
    if (f) {
      barDataList.push({ pct: Math.round(f.usedPercent), lightColor: lc, darkColor: dc });
    }
    if (s) {
      barDataList.push({ pct: Math.round(s.usedPercent), lightColor: lc, darkColor: dc });
    }
  }
  const dropdownBars = renderDropdownBarImages(barDataList);
  let barIdx = 0;

  for (const item of providers) {
    const color = STATE_COLOR[item.analysis.state];
    const five = windowByName(item, "five_hour");
    const seven = windowByName(item, "seven_day");

    if (item.usage.balance && item.usage.windows.length === 0) {
      const currency = item.usage.balance.currency === "CNY" ? "¥" : "$";
      const balanceText = `${currency}${item.usage.balance.total}`;
      const availableLabel = item.usage.balance.isAvailable ? "Available" : "Depleted";
      lines.push(line(`${formatProviderLabel(item.usage.provider)}  ${availableLabel}`, {
        ...providerIconParams(item.usage.provider),
        color: TEXT_COLOR,
        size: 14,
        badge: balanceText,
      }));
      lines.push(line(`Balance  ${balanceText}`, {
        color: TEXT_COLOR,
        font: ROW_FONT,
        size: 12,
      }));
      lines.push(line(item.analysis.message, { color: MUTED_COLOR, size: 12, length: 84 }));
      lines.push("---");
      continue;
    }

    lines.push(line(`${formatProviderLabel(item.usage.provider)}  ${STATE_LABEL[item.analysis.state]}`, {
      ...providerIconParams(item.usage.provider),
      color: TEXT_COLOR,
      size: 14,
      badge: providerBadge(item),
    }));
    if (five) {
      lines.push(usageLine("5h", five.usedPercent, five.resetsAt, TEXT_COLOR, dropdownBars[barIdx++]));
    }
    if (seven) {
      lines.push(usageLine("7d", seven.usedPercent, seven.resetsAt, TEXT_COLOR, dropdownBars[barIdx++]));
    }
    lines.push(muted(targetLabel(item)));
    lines.push(line(item.analysis.message, { color: MUTED_COLOR, size: 12, length: 84 }));
    lines.push("---");
  }

  for (const issue of snapshot.issues) {
    const color = issue.severity === "error" ? ALERT_COLOR : WARNING_COLOR;
    lines.push(line(`${issue.severity.toUpperCase()}  ${issueLabel(issue.code)}`, {
      color,
      size: 13,
      sfimage: "exclamationmark.triangle.fill",
      sfcolor: color,
    }));
    lines.push(muted(issue.message));
  }

  if (snapshot.issues.length > 0) {
    lines.push("---");
  }
  lines.push(line(compact ? "Expand" : "Collapse", toggleParams));
  lines.push(line("Refresh now", {
    refresh: true,
    color: TEXT_COLOR,
    sfimage: "arrow.clockwise",
  }));
  lines.push(line("Exit Coding Usage Bar", {
    bash: stableNodeExecutable(),
    param1: appCliPath(buildPaths()),
    param2: "menubar",
    param3: "uninstall",
    terminal: false,
    color: MUTED_COLOR,
    sfimage: "xmark.circle",
  }));
  return lines.join("\n");
}

function pluginScript(paths: RuntimePaths) {
  const node = stableNodeExecutable();
  return `#!${node}
// ${MARKER}
// <swiftbar.title>Coding Usage Bar</swiftbar.title>
// <swiftbar.version>v0.1.0</swiftbar.version>
// <swiftbar.author>Coding Usage Bar</swiftbar.author>
// <swiftbar.desc>Local Claude Code and Codex burn-rate monitor.</swiftbar.desc>
// <swiftbar.hideSwiftBar>true</swiftbar.hideSwiftBar>
// <swiftbar.hideAbout>true</swiftbar.hideAbout>
// <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
// <swiftbar.hideLastUpdated>true</swiftbar.hideLastUpdated>
// <swiftbar.hideDisablePlugin>true</swiftbar.hideDisablePlugin>
// <swiftbar.refreshOnOpen>false</swiftbar.refreshOnOpen>
const { spawnSync } = require("node:child_process");
const result = spawnSync(${JSON.stringify(node)}, [${JSON.stringify(appCliPath(paths))}, "menubar", "render"], {
  encoding: "utf8",
});
if (result.error) {
  console.log("Usage ERR");
  console.log("---");
  console.log(result.error.message);
  process.exit(0);
}
if (result.status !== 0) {
  console.log("Usage ERR");
  console.log("---");
  console.log(result.stderr || result.stdout || "coding-usage-bar menubar render failed");
  process.exit(0);
}
process.stdout.write(result.stdout);
`;
}

function isManagedPlugin(paths: RuntimePaths) {
  const plugin = swiftBarPluginPath(paths);
  try {
    return fs.readFileSync(plugin.file, "utf8").includes(MARKER);
  } catch {
    return false;
  }
}

export function swiftBarStatusItemVisibilityKeys(defaultsOutput: string) {
  return defaultsOutput
    .split("\n")
    .map((line) => line.match(/^\s*"?((?:NSStatusItem Visible)[^"=]*)"?\s*=/)?.[1]?.trim())
    .filter((key): key is string => Boolean(key));
}

function clearSwiftBarStatusItemVisibility(options: { dryRun?: boolean } = {}) {
  let keys: string[];
  try {
    keys = swiftBarStatusItemVisibilityKeys(execFileSync("defaults", ["read", "com.ameba.SwiftBar"], {
      encoding: "utf8",
    }));
  } catch {
    return [];
  }

  if (keys.length === 0) {
    return [];
  }

  if (options.dryRun) {
    return [`[dry-run] would clear SwiftBar hidden status item cache: ${keys.join(", ")}`];
  }

  for (const key of keys) {
    try {
      execFileSync("defaults", ["delete", "com.ameba.SwiftBar", key], { stdio: "ignore" });
    } catch {
      // Ignore races with SwiftBar rewriting or deleting the same key.
    }
  }
  return [`Cleared SwiftBar hidden status item cache: ${keys.join(", ")}`];
}

export function installMenuBar(options: { dryRun?: boolean } = {}) {
  const dryRun = options.dryRun ?? false;
  const paths = buildPaths();
  const plugin = swiftBarPluginPath(paths);
  if (dryRun) {
    return [
      `[dry-run] would write SwiftBar plugin: ${plugin.file}`,
      ...clearSwiftBarStatusItemVisibility({ dryRun }),
    ];
  }
  if (isFile(plugin.file) && !isManagedPlugin(paths)) {
    return [`SwiftBar plugin already exists and is not managed by coding-usage-bar: ${plugin.file}`];
  }
  ensureDir(plugin.dir);
  fs.writeFileSync(plugin.file, pluginScript(paths), { mode: 0o755 });
  return [
    `Installed SwiftBar plugin: ${plugin.file}`,
    ...clearSwiftBarStatusItemVisibility(),
    "Open SwiftBar and set its plugin folder to the Coding Usage Bar plugin directory if it is not already configured.",
    `Plugin directory: ${plugin.dir}`,
  ];
}

export function uninstallMenuBar(options: { dryRun?: boolean } = {}) {
  const dryRun = options.dryRun ?? false;
  const paths = buildPaths();
  const plugin = swiftBarPluginPath(paths);
  if (!isFile(plugin.file)) {
    return ["No Coding Usage Bar SwiftBar plugin installed."];
  }
  if (!isManagedPlugin(paths)) {
    return [`SwiftBar plugin is user-managed; leaving it unchanged: ${plugin.file}`];
  }
  if (dryRun) {
    return [`[dry-run] would remove SwiftBar plugin: ${plugin.file}`];
  }
  fs.rmSync(plugin.file, { force: true });
  return [`Removed SwiftBar plugin: ${plugin.file}`];
}
