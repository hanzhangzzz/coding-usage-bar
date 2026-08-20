import { Canvas, Rgb, parseHex, loadIcon } from "./menubar-render.js";
import { GlyphSet, LoadedGlyphStyle, measureText, ellipsize } from "./glyphs.js";

// Draws the whole dropdown as ONE composite card image (light + dark). The
// point of the single card: SwiftBar's menu rebuild cost scales with the
// number of image-bearing menu items, not their byte size — 17 small images
// caused a 6-8s WindowServer storm on every data change, while title + one
// card measured as a <2s single-sample blip. Keep every provider visual in
// here; interactive rows stay plain text items in menubar.ts.

export interface CardBarRow {
  label: string;
  pct: number;
  resetLabel: string;
}

export interface CardProviderBlock {
  name: string;
  iconPath: string | null;
  iconPathDark: string | null;
  stateLabel: string;
  lightColor: string;
  darkColor: string;
  headline: string;
  rows: CardBarRow[];
  note: string | null;
  message: string | null;
}

export interface UsageCardPayload {
  profile: string;
  updatedLabel: string;
  providers: CardProviderBlock[];
  scale: number;
}

interface CardVariant {
  bg: Rgb;
  bgAlpha: number;
  text: Rgb;
  muted: Rgb;
  msg: Rgb;
  track: Rgb;
  trackAlpha: number;
  sep: Rgb;
  sepAlpha: number;
}

const LIGHT: CardVariant = {
  bg: parseHex("F5F5F7"),
  bgAlpha: 0.88,
  text: parseHex("111827"),
  muted: parseHex("6B7280"),
  msg: parseHex("8E8E93"),
  track: parseHex("000000"),
  trackAlpha: 0.08,
  sep: parseHex("000000"),
  sepAlpha: 0.07,
};

const DARK: CardVariant = {
  bg: parseHex("232326"),
  bgAlpha: 0.88,
  text: parseHex("F9FAFB"),
  muted: parseHex("A1A1AA"),
  msg: parseHex("7C7C82"),
  track: parseHex("FFFFFF"),
  trackAlpha: 0.10,
  sep: parseHex("FFFFFF"),
  sepAlpha: 0.08,
};

// Layout in points (multiplied by payload.scale when drawing).
const W = 460;
const PAD_X = 16;
const TOP_PAD = 14;
const HEADER_H = 18;
const HEADER_GAP = 12;
const BLOCK_PAD_Y = 10;
const HEAD_H = 24;
const ROW_H = 21;
const MSG_GAP = 6;
const MSG_H = 14;
const BOTTOM_PAD = 8;
const RIGHT_EDGE = W - PAD_X;
const RESET_COL_W = 104;
const PCT_COL_W = 36;
const COL_GAP = 8;
const TRACK_X = PAD_X + 18 + 16;
const PILL_H = 16;
const PILL_PAD_X = 7;
const PILL_RADIUS = 8;

function blockHeight(block: CardProviderBlock): number {
  let h = BLOCK_PAD_Y * 2 + HEAD_H;
  h += block.rows.length * ROW_H;
  if (block.note) {
    h += ROW_H;
  }
  if (block.message) {
    h += MSG_GAP + MSG_H;
  }
  return h;
}

function cardHeight(payload: UsageCardPayload): number {
  let h = TOP_PAD + HEADER_H + HEADER_GAP;
  payload.providers.forEach((block, idx) => {
    h += blockHeight(block);
    if (idx < payload.providers.length - 1) {
      h += 1;
    }
  });
  return h + BOTTOM_PAD;
}

interface DrawContext {
  canvas: Canvas;
  glyphs: GlyphSet;
  scale: number;
  heightPt: number;
}

function style(ctx: DrawContext, key: string): LoadedGlyphStyle {
  const loaded = ctx.glyphs[key];
  if (!loaded) {
    throw new Error(`Glyph style missing from atlas set: ${key}`);
  }
  return loaded;
}

// `baselineTopPt` is the distance from the card's top edge to the text
// baseline, in points; conversion to the canvas' bottom-left origin happens
// here so the layout code can think strictly top-down.
function drawText(ctx: DrawContext, styleKey: string, text: string, xPt: number, baselineTopPt: number, color: Rgb, alpha = 1): number {
  const loaded = style(ctx, styleKey);
  const { atlas, metrics } = loaded;
  const s = ctx.scale;
  const cellBottom = ctx.heightPt * s - (baselineTopPt * s + metrics.descent + metrics.pad);
  let cursor = xPt * s;
  for (const ch of text) {
    const cell = metrics.glyphs[ch] ?? metrics.glyphs["?"];
    if (!cell) {
      continue;
    }
    ctx.canvas.drawGlyphCell(atlas, cell.x, cell.w, cursor - metrics.pad, cellBottom, color, alpha);
    cursor += cell.adv;
  }
  return cursor / s;
}

function textWidthPt(ctx: DrawContext, styleKey: string, text: string): number {
  return measureText(style(ctx, styleKey), text) / ctx.scale;
}

function fillRect(ctx: DrawContext, xPt: number, topPt: number, wPt: number, hPt: number, radiusPt: number, color: Rgb, alpha: number) {
  const s = ctx.scale;
  ctx.canvas.fillRoundedRect(xPt * s, (ctx.heightPt - topPt - hPt) * s, wPt * s, hPt * s, radiusPt * s, color, alpha);
}

function drawPill(ctx: DrawContext, xPt: number, topPt: number, text: string, color: Rgb): number {
  const textW = textWidthPt(ctx, "b20", text);
  const pillW = textW + PILL_PAD_X * 2;
  fillRect(ctx, xPt, topPt, pillW, PILL_H, PILL_RADIUS, color, 0.13);
  drawText(ctx, "b20", text, xPt + PILL_PAD_X, topPt + 11.5, color);
  return pillW;
}

function drawProviderBlock(ctx: DrawContext, block: CardProviderBlock, topPt: number, mode: "light" | "dark", variant: CardVariant) {
  const color = parseHex(mode === "dark" ? block.darkColor : block.lightColor);
  let y = topPt + BLOCK_PAD_Y;

  const iconFile = mode === "dark" && block.iconPathDark ? block.iconPathDark : block.iconPath;
  if (iconFile) {
    const icon = loadIcon(iconFile);
    if (icon) {
      const s = ctx.scale;
      ctx.canvas.drawIcon(icon, PAD_X * s, (ctx.heightPt - (y + 3) - 18) * s, 18 * s);
    }
  }
  const nameEnd = drawText(ctx, "s28", block.name, PAD_X + 26, y + 17, variant.text);
  drawPill(ctx, nameEnd + 8, y + 4, block.stateLabel, color);
  const headlineW = textWidthPt(ctx, "b38", block.headline);
  drawText(ctx, "b38", block.headline, RIGHT_EDGE - headlineW, y + 19, color);
  y += HEAD_H;

  for (const row of block.rows) {
    const baseline = y + 14;
    drawText(ctx, "s22", row.label, PAD_X, baseline, variant.muted);
    const trackW = RIGHT_EDGE - RESET_COL_W - COL_GAP - PCT_COL_W - COL_GAP - TRACK_X;
    const trackTop = y + 7.5;
    fillRect(ctx, TRACK_X, trackTop, trackW, 6, 3, variant.track, variant.trackAlpha);
    const pct = Math.max(0, Math.min(100, row.pct));
    if (pct > 0) {
      const fillW = Math.max(6, (trackW * pct) / 100);
      fillRect(ctx, TRACK_X, trackTop, fillW, 6, 3, color, 1);
    }
    const pctText = `${Math.round(pct)}%`;
    const pctW = textWidthPt(ctx, "b24", pctText);
    drawText(ctx, "b24", pctText, RIGHT_EDGE - RESET_COL_W - COL_GAP - pctW, baseline, color);
    const resetW = textWidthPt(ctx, "r22", row.resetLabel);
    drawText(ctx, "r22", row.resetLabel, RIGHT_EDGE - resetW, baseline, variant.muted);
    y += ROW_H;
  }

  if (block.note) {
    drawText(ctx, "r24", block.note, PAD_X, y + 14, variant.muted);
    y += ROW_H;
  }

  if (block.message) {
    const fitted = ellipsize(style(ctx, "r22"), block.message, (W - PAD_X * 2) * ctx.scale);
    drawText(ctx, "r22", fitted, PAD_X, y + MSG_GAP + 11, variant.msg);
  }
}

function drawCard(payload: UsageCardPayload, glyphs: GlyphSet, mode: "light" | "dark") {
  const variant = mode === "dark" ? DARK : LIGHT;
  const heightPt = cardHeight(payload);
  const s = payload.scale || 2;
  const canvas = new Canvas(Math.round(W * s), Math.round(heightPt * s));
  const ctx: DrawContext = { canvas, glyphs, scale: s, heightPt };

  fillRect(ctx, 0, 0, W, heightPt, 14, variant.bg, variant.bgAlpha);

  const titleEnd = drawText(ctx, "b26", "Coding Usage Bar", PAD_X, TOP_PAD + 14, variant.text);
  drawPill(ctx, titleEnd + 8, TOP_PAD + 1, payload.profile, variant.muted);
  const updatedW = textWidthPt(ctx, "r22", payload.updatedLabel);
  drawText(ctx, "r22", payload.updatedLabel, RIGHT_EDGE - updatedW, TOP_PAD + 13, variant.muted);

  let top = TOP_PAD + HEADER_H + HEADER_GAP;
  payload.providers.forEach((block, idx) => {
    drawProviderBlock(ctx, block, top, mode, variant);
    top += blockHeight(block);
    if (idx < payload.providers.length - 1) {
      fillRect(ctx, PAD_X, top, W - PAD_X * 2, 0.5, 0, variant.sep, variant.sepAlpha * 2);
      top += 1;
    }
  });

  return {
    image: canvas.toPNGBase64(),
    width: W,
    height: Math.round(heightPt),
  };
}

export function renderUsageCard(payload: UsageCardPayload, glyphs: GlyphSet) {
  return {
    light: drawCard(payload, glyphs, "light"),
    dark: drawCard(payload, glyphs, "dark"),
  };
}
