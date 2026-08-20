import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { decodePNG, DecodedPNG } from "./png.js";
import { RuntimePaths } from "./types.js";

// Glyph atlases let the pure-JS card renderer draw native-looking SF text
// without ever spawning AppKit at render time. Baking runs osascript exactly
// once, at install time, on the user's own machine (the SF fonts live there;
// nothing font-derived ships in the npm package). Render-time consumers only
// read the baked PNG + metrics files; when they are missing the menu bar
// falls back to text-only rows, so a failed bake can never break rendering.

// All sizes are physical pixels (2x point sizes; the card renders at scale 2).
export const GLYPH_STYLES = [
  { key: "r22", px: 22, weight: "regular" },
  { key: "r24", px: 24, weight: "regular" },
  { key: "s22", px: 22, weight: "semibold" },
  { key: "s28", px: 28, weight: "semibold" },
  { key: "b20", px: 20, weight: "bold" },
  { key: "b24", px: 24, weight: "bold" },
  { key: "b26", px: 26, weight: "bold" },
  { key: "b38", px: 38, weight: "bold" },
] as const;

export type GlyphStyleKey = (typeof GLYPH_STYLES)[number]["key"];

// Printable ASCII plus the few extras the card actually renders.
export function glyphCharset(): string[] {
  const chars: string[] = [];
  for (let code = 32; code <= 126; code++) {
    chars.push(String.fromCharCode(code));
  }
  chars.push("¥", "·", "—", "…");
  return chars;
}

export interface GlyphCell {
  x: number;
  w: number;
  adv: number;
}

export interface GlyphStyleMetrics {
  px: number;
  weight: string;
  ascent: number;
  descent: number;
  pad: number;
  cellH: number;
  glyphs: Record<string, GlyphCell>;
}

export interface GlyphMetricsFile {
  version: number;
  styles: Record<string, GlyphStyleMetrics>;
}

export interface LoadedGlyphStyle {
  metrics: GlyphStyleMetrics;
  atlas: DecodedPNG;
}

export type GlyphSet = Record<string, LoadedGlyphStyle>;

export function glyphMetricsPath(paths: RuntimePaths) {
  return path.join(paths.glyphsDir, "metrics.json");
}

export function glyphAtlasPath(paths: RuntimePaths, styleKey: string) {
  return path.join(paths.glyphsDir, `${styleKey}.png`);
}

// JXA program executed by `osascript -l JavaScript`. It renders every charset
// glyph for every style into one horizontal PNG strip per style (white text on
// transparent, monospacedDigit variant so numbers stay tabular) and returns
// the metrics JSON on stdout. Kept dependency-free and side-effect-scoped to
// the output directory it is handed.
const BAKE_JXA = `
ObjC.import("Cocoa");
function run(argv) {
  const spec = JSON.parse(argv[0]);
  const weights = {
    regular: $.NSFontWeightRegular,
    semibold: $.NSFontWeightSemibold,
    bold: $.NSFontWeightBold,
  };
  const out = { version: 1, styles: {} };
  for (const style of spec.styles) {
    const font = $.NSFont.monospacedDigitSystemFontOfSizeWeight(style.px, weights[style.weight]);
    const attrs = $.NSDictionary.dictionaryWithObjectsForKeys(
      $([font, $.NSColor.whiteColor]),
      $([$.NSFontAttributeName, $.NSForegroundColorAttributeName]),
    );
    const ascent = Math.ceil(font.ascender);
    const descent = Math.ceil(Math.abs(font.descender));
    const pad = 2;
    const cellH = ascent + descent + pad * 2;
    const cells = [];
    let stripW = 0;
    for (const ch of spec.chars) {
      const adv = $(ch).sizeWithAttributes(attrs).width;
      const w = Math.ceil(adv) + pad * 2;
      cells.push({ ch, x: stripW, w, adv });
      stripW += w;
    }
    const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
      null, stripW, cellH, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0,
    );
    $.NSGraphicsContext.saveGraphicsState;
    $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
    for (const cell of cells) {
      $(cell.ch).drawAtPointWithAttributes($.NSMakePoint(cell.x + pad, pad), attrs);
    }
    $.NSGraphicsContext.restoreGraphicsState;
    const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
    png.writeToFileAtomically($(spec.outDir + "/" + style.key + ".png"), true);
    const glyphs = {};
    for (const cell of cells) {
      glyphs[cell.ch] = { x: cell.x, w: cell.w, adv: cell.adv };
    }
    out.styles[style.key] = {
      px: style.px,
      weight: style.weight,
      ascent, descent, pad, cellH,
      glyphs,
    };
  }
  return JSON.stringify(out);
}
`;

export function bakeGlyphAtlases(paths: RuntimePaths, options: { dryRun?: boolean } = {}): string[] {
  if (process.platform !== "darwin") {
    return ["Glyph atlas baking requires macOS; menu bar card rendering will use the text fallback."];
  }
  if (options.dryRun) {
    return [`[dry-run] would bake ${GLYPH_STYLES.length} glyph atlases into ${paths.glyphsDir}`];
  }
  fs.mkdirSync(paths.glyphsDir, { recursive: true });
  const spec = {
    outDir: paths.glyphsDir,
    chars: glyphCharset(),
    styles: GLYPH_STYLES.map((style) => ({ key: style.key, px: style.px, weight: style.weight })),
  };
  const stdout = execFileSync("osascript", ["-l", "JavaScript", "-e", BAKE_JXA, JSON.stringify(spec)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  const metrics = JSON.parse(stdout.trim()) as GlyphMetricsFile;
  for (const style of GLYPH_STYLES) {
    if (!metrics.styles[style.key] || !fs.existsSync(glyphAtlasPath(paths, style.key))) {
      throw new Error(`Glyph bake incomplete: missing atlas for style ${style.key}`);
    }
  }
  fs.writeFileSync(glyphMetricsPath(paths), `${JSON.stringify(metrics)}\n`, "utf8");
  return [`Baked ${GLYPH_STYLES.length} glyph atlases: ${paths.glyphsDir}`];
}

// Returns null when any piece is missing or unreadable; callers treat null as
// "use the text-only fallback", never as an error.
export function loadGlyphSet(paths: RuntimePaths): GlyphSet | null {
  let metrics: GlyphMetricsFile;
  try {
    metrics = JSON.parse(fs.readFileSync(glyphMetricsPath(paths), "utf8")) as GlyphMetricsFile;
  } catch {
    return null;
  }
  const set: GlyphSet = {};
  for (const style of GLYPH_STYLES) {
    const styleMetrics = metrics.styles?.[style.key];
    if (!styleMetrics) {
      return null;
    }
    try {
      const atlas = decodePNG(fs.readFileSync(glyphAtlasPath(paths, style.key)));
      set[style.key] = { metrics: styleMetrics, atlas };
    } catch {
      return null;
    }
  }
  return set;
}

export function measureText(style: LoadedGlyphStyle, text: string): number {
  let width = 0;
  for (const ch of text) {
    const cell = style.metrics.glyphs[ch] ?? style.metrics.glyphs["?"];
    if (cell) {
      width += cell.adv;
    }
  }
  return width;
}

// Trims `text` with a trailing ellipsis so it fits within maxWidth pixels.
export function ellipsize(style: LoadedGlyphStyle, text: string, maxWidth: number): string {
  if (measureText(style, text) <= maxWidth) {
    return text;
  }
  const ellipsis = "…";
  const ellipsisWidth = measureText(style, ellipsis);
  let result = "";
  let width = 0;
  for (const ch of text) {
    const cell = style.metrics.glyphs[ch] ?? style.metrics.glyphs["?"];
    const adv = cell ? cell.adv : 0;
    if (width + adv + ellipsisWidth > maxWidth) {
      break;
    }
    result += ch;
    width += adv;
  }
  return `${result.trimEnd()}${ellipsis}`;
}
