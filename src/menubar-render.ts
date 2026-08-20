import fs from "node:fs";
import { encodePNG, decodePNG, DecodedPNG } from "./png.js";

// Pure-JS reimplementation of the menu bar image rendering that previously ran
// through `osascript -l JavaScript` + AppKit. Spawning AppKit-linked processes
// connects to the WindowServer and stalls the whole display for 1-2s on every
// SwiftBar refresh; drawing the pixels in-process here never touches the
// WindowServer, so there is zero UI freeze. Geometry, colors and the y-up
// (bottom-left origin) coordinate system mirror the old AppKit code exactly so
// the rendered images stay visually identical.

const SUPERSAMPLE = 4; // 4x4 coverage sampling for anti-aliased rounded corners

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function parseHex(hex: string): Rgb {
  const v = hex.replace("#", "");
  return {
    r: parseInt(v.slice(0, 2), 16) / 255,
    g: parseInt(v.slice(2, 4), 16) / 255,
    b: parseInt(v.slice(4, 6), 16) / 255,
  };
}

export class Canvas {
  readonly width: number;
  readonly height: number;
  private readonly data: Float32Array; // straight-alpha RGBA, 0..1

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Float32Array(width * height * 4);
  }

  // Source-over compositing of a single pixel using straight alpha.
  private composite(px: number, py: number, color: Rgb, alpha: number): void {
    if (alpha <= 0 || px < 0 || py < 0 || px >= this.width || py >= this.height) {
      return;
    }
    const idx = (py * this.width + px) * 4;
    const dr = this.data[idx];
    const dg = this.data[idx + 1];
    const db = this.data[idx + 2];
    const da = this.data[idx + 3];
    const outA = alpha + da * (1 - alpha);
    if (outA <= 0) {
      this.data[idx] = this.data[idx + 1] = this.data[idx + 2] = this.data[idx + 3] = 0;
      return;
    }
    this.data[idx] = (color.r * alpha + dr * da * (1 - alpha)) / outA;
    this.data[idx + 1] = (color.g * alpha + dg * da * (1 - alpha)) / outA;
    this.data[idx + 2] = (color.b * alpha + db * da * (1 - alpha)) / outA;
    this.data[idx + 3] = outA;
  }

  // Fill a rounded rectangle expressed in AppKit coordinates (origin bottom-left,
  // y increases upward). r is clamped to half the smaller side, matching
  // CGPathCreateWithRoundedRect.
  fillRoundedRect(ax: number, ay: number, aw: number, ah: number, radius: number, color: Rgb, alpha: number): void {
    const r = Math.min(radius, aw / 2, ah / 2);
    const cx = ax + aw / 2;
    const cy = ay + ah / 2;
    const halfW = aw / 2 - r;
    const halfH = ah / 2 - r;
    const H = this.height;
    const pxMin = Math.max(0, Math.floor(ax));
    const pxMax = Math.min(this.width, Math.ceil(ax + aw));
    const pyMin = Math.max(0, Math.floor(H - (ay + ah)));
    const pyMax = Math.min(H, Math.ceil(H - ay));
    const sdf = (sx: number, sy: number) => {
      const qx = Math.abs(sx - cx) - halfW;
      const qy = Math.abs(sy - cy) - halfH;
      const dxo = Math.max(qx, 0);
      const dyo = Math.max(qy, 0);
      return Math.sqrt(dxo * dxo + dyo * dyo) + Math.min(Math.max(qx, qy), 0) - r;
    };
    for (let py = pyMin; py < pyMax; py++) {
      for (let px = pxMin; px < pxMax; px++) {
        // Fast path keeps large fills (the full card background) cheap:
        // supersample only within one pixel of the shape edge.
        const center = sdf(px + 0.5, H - (py + 0.5));
        if (center <= -0.71) {
          this.composite(px, py, color, alpha);
          continue;
        }
        if (center >= 0.71) {
          continue;
        }
        let hits = 0;
        for (let j = 0; j < SUPERSAMPLE; j++) {
          for (let i = 0; i < SUPERSAMPLE; i++) {
            const sx = px + (i + 0.5) / SUPERSAMPLE;
            const sPngY = py + (j + 0.5) / SUPERSAMPLE;
            if (sdf(sx, H - sPngY) <= 0) hits++;
          }
        }
        if (hits > 0) {
          this.composite(px, py, color, alpha * (hits / (SUPERSAMPLE * SUPERSAMPLE)));
        }
      }
    }
  }

  // Blit one glyph cell from a baked atlas 1:1, tinting the (white, alpha
  // anti-aliased) glyph pixels with `color`. AppKit coords: `ax`/`ay` place
  // the cell's bottom-left corner.
  drawGlyphCell(atlas: DecodedPNG, srcX: number, srcW: number, ax: number, ay: number, color: Rgb, alpha: number): void {
    const H = this.height;
    const cellH = atlas.height;
    const x0 = Math.round(ax);
    const y0 = Math.round(ay);
    for (let sy = 0; sy < cellH; sy++) {
      // Atlas rows are top-down; canvas rows are addressed top-down too, but
      // the destination rect is expressed y-up from `ay`.
      const py = H - (y0 + cellH) + sy;
      if (py < 0 || py >= H) continue;
      for (let sx = 0; sx < srcW; sx++) {
        const px = x0 + sx;
        if (px < 0 || px >= this.width) continue;
        const a = atlas.data[(sy * atlas.width + (srcX + sx)) * 4 + 3] / 255;
        if (a > 0) {
          this.composite(px, py, color, a * alpha);
        }
      }
    }
  }

  // Draw an RGBA source image upright into an AppKit-space rect (bottom-left
  // origin), bilinearly scaled to `size` x `size`. Mirrors NSImage.drawInRect.
  drawIcon(icon: DecodedPNG, ax: number, ay: number, size: number): void {
    const H = this.height;
    const pxMin = Math.max(0, Math.floor(ax));
    const pxMax = Math.min(this.width, Math.ceil(ax + size));
    const pyMin = Math.max(0, Math.floor(H - (ay + size)));
    const pyMax = Math.min(H, Math.ceil(H - ay));
    const iw = icon.width;
    const ih = icon.height;
    for (let py = pyMin; py < pyMax; py++) {
      for (let px = pxMin; px < pxMax; px++) {
        const cxA = px + 0.5;
        const cyA = H - (py + 0.5);
        const u = (cxA - ax) / size; // 0..1 left -> right
        const v = (ay + size - cyA) / size; // 0..1 top -> bottom
        if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
        const sample = bilinear(icon.data, iw, ih, u * iw - 0.5, v * ih - 0.5);
        if (sample.a > 0) {
          this.composite(px, py, { r: sample.r, g: sample.g, b: sample.b }, sample.a);
        }
      }
    }
  }

  toPNGBase64(): string {
    const out = new Uint8Array(this.width * this.height * 4);
    for (let i = 0; i < this.width * this.height; i++) {
      out[i * 4] = Math.round(clamp01(this.data[i * 4]) * 255);
      out[i * 4 + 1] = Math.round(clamp01(this.data[i * 4 + 1]) * 255);
      out[i * 4 + 2] = Math.round(clamp01(this.data[i * 4 + 2]) * 255);
      out[i * 4 + 3] = Math.round(clamp01(this.data[i * 4 + 3]) * 255);
    }
    return encodePNG(out, this.width, this.height).toString("base64");
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function bilinear(data: Uint8Array, w: number, h: number, fx: number, fy: number): { r: number; g: number; b: number; a: number } {
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (x: number, y: number) => {
    const cx = x < 0 ? 0 : x >= w ? w - 1 : x;
    const cy = y < 0 ? 0 : y >= h ? h - 1 : y;
    const idx = (cy * w + cx) * 4;
    return {
      r: data[idx] / 255,
      g: data[idx + 1] / 255,
      b: data[idx + 2] / 255,
      a: data[idx + 3] / 255,
    };
  };
  const c00 = at(x0, y0);
  const c10 = at(x0 + 1, y0);
  const c01 = at(x0, y0 + 1);
  const c11 = at(x0 + 1, y0 + 1);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  return {
    r: lerp(lerp(c00.r, c10.r, tx), lerp(c01.r, c11.r, tx), ty),
    g: lerp(lerp(c00.g, c10.g, tx), lerp(c01.g, c11.g, tx), ty),
    b: lerp(lerp(c00.b, c10.b, tx), lerp(c01.b, c11.b, tx), ty),
    a: lerp(lerp(c00.a, c10.a, tx), lerp(c01.a, c11.a, tx), ty),
  };
}

const iconCache = new Map<string, DecodedPNG | null>();

export function loadIcon(iconPath: string): DecodedPNG | null {
  if (iconCache.has(iconPath)) {
    return iconCache.get(iconPath) ?? null;
  }
  let decoded: DecodedPNG | null = null;
  try {
    decoded = decodePNG(fs.readFileSync(iconPath));
  } catch {
    decoded = null;
  }
  iconCache.set(iconPath, decoded);
  return decoded;
}

export interface TitleSegment {
  provider: string;
  bars: Array<{ pct: number; lightColor: string; darkColor: string }>;
  iconPath: string | null;
  iconPathDark: string | null;
}

export interface TitleVariant {
  dividerColor: string;
  dividerAlpha: number;
  barBgColor: string;
  barBgAlpha: number;
}

export interface TitlePayload {
  segments: TitleSegment[];
  scale: number;
  height: number;
  minWidth: number;
  paddingX: number;
  iconSize: number;
  iconBarGap: number;
  segmentGap: number;
  barWidth: number;
  barHeight: number;
  barGap: number;
  barRadius: number;
  barMinFill: number;
  light: TitleVariant;
  dark: TitleVariant;
}

interface RenderedImage {
  image: string;
  width: number;
  height: number;
}

function drawTitle(payload: TitlePayload, variant: TitleVariant, mode: "light" | "dark"): RenderedImage {
  const scale = payload.scale || 1;
  const height = payload.height * scale;
  const iconSize = payload.iconSize * scale;
  const paddingX = payload.paddingX * scale;
  const iconBarGap = payload.iconBarGap * scale;
  const segmentGap = payload.segmentGap * scale;
  const barWidth = payload.barWidth * scale;
  const barHeight = payload.barHeight * scale;
  const barGap = payload.barGap * scale;
  const barRadius = payload.barRadius * scale;
  const barMinFill = (payload.barMinFill || barRadius * 2) * scale;
  const dividerW = 1 * scale;

  let width = paddingX * 2;
  payload.segments.forEach((seg, idx) => {
    if (idx > 0) width += segmentGap + dividerW + segmentGap;
    width += (seg.iconPath ? iconSize + iconBarGap : 0) + barWidth;
  });
  width = Math.max(payload.minWidth * scale, width);

  const canvas = new Canvas(Math.round(width), Math.round(height));
  const dividerColor = parseHex(variant.dividerColor);

  let x = paddingX;
  const iconY = Math.floor((height - iconSize) / 2);

  payload.segments.forEach((seg, idx) => {
    if (idx > 0) {
      x += segmentGap;
      canvas.fillRoundedRect(x, Math.floor(height * 0.2), dividerW, Math.floor(height * 0.6), 0, dividerColor, variant.dividerAlpha);
      x += dividerW + segmentGap;
    }
    const iconFile = mode === "dark" && seg.iconPathDark ? seg.iconPathDark : seg.iconPath;
    if (iconFile) {
      const icon = loadIcon(iconFile);
      if (icon) {
        canvas.drawIcon(icon, x, iconY, iconSize);
      }
      x += iconSize + iconBarGap;
    }
    const bars = seg.bars || [];
    const totalH = bars.length * barHeight + Math.max(0, bars.length - 1) * barGap;
    let barY = Math.floor((height + totalH) / 2) - barHeight;
    const barBgColor = parseHex(variant.barBgColor);
    for (let i = 0; i < bars.length; i++) {
      canvas.fillRoundedRect(x, barY, barWidth, barHeight, barRadius, barBgColor, variant.barBgAlpha);
      if (bars[i].pct > 0) {
        const pct = Math.min(bars[i].pct, 100);
        const fw = Math.max(barMinFill, Math.round((barWidth * pct) / 100));
        const fillColor = parseHex(mode === "dark" ? bars[i].darkColor : bars[i].lightColor);
        canvas.fillRoundedRect(x, barY, fw, barHeight, barRadius, fillColor, 1);
      }
      barY -= barHeight + barGap;
    }
    x += barWidth;
  });

  return {
    image: canvas.toPNGBase64(),
    width: Math.ceil(width / scale),
    height: payload.height,
  };
}

export function renderTitleImage(payload: TitlePayload): { light: RenderedImage; dark: RenderedImage } {
  return {
    light: drawTitle(payload, payload.light, "light"),
    dark: drawTitle(payload, payload.dark, "dark"),
  };
}

export interface DropdownPayload {
  bars: Array<{ pct: number; lightColor: string; darkColor: string }>;
  scale: number;
  barWidth: number;
  barHeight: number;
  barRadius: number;
  light: { barBgColor: string; barBgAlpha: number };
  dark: { barBgColor: string; barBgAlpha: number };
}

function makeBar(bw: number, bh: number, br: number, pct: number, fill: Rgb, bgColor: Rgb, bgAlpha: number): string {
  const canvas = new Canvas(bw, bh);
  canvas.fillRoundedRect(0, 0, bw, bh, br, bgColor, bgAlpha);
  if (pct > 0) {
    const fw = Math.max(br * 2, Math.round((bw * Math.min(pct, 100)) / 100));
    canvas.fillRoundedRect(0, 0, fw, bh, br, fill, 1);
  }
  return canvas.toPNGBase64();
}

export function renderDropdownBars(payload: DropdownPayload): { images: string[]; width: number; height: number } {
  const s = payload.scale || 2;
  const bw = payload.barWidth * s;
  const bh = payload.barHeight * s;
  const br = payload.barRadius * s;
  const lightBg = parseHex(payload.light.barBgColor);
  const darkBg = parseHex(payload.dark.barBgColor);
  const images = payload.bars.map((bar) => {
    const light = makeBar(bw, bh, br, bar.pct, parseHex(bar.lightColor), lightBg, payload.light.barBgAlpha);
    const dark = makeBar(bw, bh, br, bar.pct, parseHex(bar.darkColor), darkBg, payload.dark.barBgAlpha);
    return `${light},${dark}`;
  });
  return { images, width: payload.barWidth, height: payload.barHeight };
}
