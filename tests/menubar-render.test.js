import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodePNG, decodePNG } from "../dist/png.js";
import { renderTitleImage, renderDropdownBars } from "../dist/menubar-render.js";

const ASSET_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "assets");

function decodeB64(b64) {
  return decodePNG(Buffer.from(b64, "base64"));
}
function pixel(img, x, y) {
  const i = (y * img.width + x) * 4;
  return { r: img.data[i], g: img.data[i + 1], b: img.data[i + 2], a: img.data[i + 3] };
}

test("png encode/decode roundtrip preserves pixels", () => {
  const w = 5, h = 3;
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37) % 256;
  const decoded = decodePNG(encodePNG(rgba, w, h));
  assert.equal(decoded.width, w);
  assert.equal(decoded.height, h);
  assert.deepEqual([...decoded.data], [...rgba]);
});

test("decodePNG reads a real 18x18 RGBA provider icon", () => {
  const icon = decodePNG(fs.readFileSync(path.join(ASSET_DIR, "provider-codex.png")));
  assert.equal(icon.width, 18);
  assert.equal(icon.height, 18);
  assert.equal(icon.data.length, 18 * 18 * 4);
});

const DROP_BASE = {
  scale: 2,
  barWidth: 80,
  barHeight: 10,
  barRadius: 3,
  light: { barBgColor: "000000", barBgAlpha: 0.15 },
  dark: { barBgColor: "FFFFFF", barBgAlpha: 0.2 },
};

test("renderDropdownBars: count, dimensions, and reported logical size", () => {
  const out = renderDropdownBars({
    ...DROP_BASE,
    bars: [
      { pct: 0, lightColor: "#248A3D", darkColor: "#30D158" },
      { pct: 50, lightColor: "#248A3D", darkColor: "#30D158" },
    ],
  });
  assert.equal(out.images.length, 2);
  assert.equal(out.width, 80);
  assert.equal(out.height, 10);
  const [light] = out.images[0].split(",");
  const img = decodeB64(light);
  assert.equal(img.width, 160); // barWidth * scale
  assert.equal(img.height, 20); // barHeight * scale
});

test("renderDropdownBars: 100% fills the whole bar with the fill color", () => {
  const out = renderDropdownBars({ ...DROP_BASE, bars: [{ pct: 100, lightColor: "#248A3D", darkColor: "#30D158" }] });
  const [light] = out.images[0].split(",");
  const img = decodeB64(light);
  const p = pixel(img, 80, 10); // center
  assert.ok(Math.abs(p.r - 0x24) <= 4, `r=${p.r}`);
  assert.ok(Math.abs(p.g - 0x8a) <= 4, `g=${p.g}`);
  assert.ok(Math.abs(p.b - 0x3d) <= 4, `b=${p.b}`);
  assert.ok(p.a >= 250, `a=${p.a}`);
});

test("renderDropdownBars: 0% shows only the translucent background", () => {
  const out = renderDropdownBars({ ...DROP_BASE, bars: [{ pct: 0, lightColor: "#248A3D", darkColor: "#30D158" }] });
  const [light] = out.images[0].split(",");
  const img = decodeB64(light);
  const p = pixel(img, 80, 10);
  // bg is black at alpha 0.15 -> ~38/255
  assert.ok(p.a >= 30 && p.a <= 46, `a=${p.a}`);
  assert.ok(p.r <= 6 && p.g <= 6 && p.b <= 6, `rgb=${p.r},${p.g},${p.b}`);
});

test("renderDropdownBars: 50% fills left half, leaves right as background", () => {
  const out = renderDropdownBars({ ...DROP_BASE, bars: [{ pct: 50, lightColor: "#248A3D", darkColor: "#30D158" }] });
  const [light] = out.images[0].split(",");
  const img = decodeB64(light);
  const left = pixel(img, 40, 10);
  const right = pixel(img, 130, 10);
  assert.ok(left.a >= 250 && Math.abs(left.g - 0x8a) <= 6, `left=${JSON.stringify(left)}`);
  assert.ok(right.a <= 46, `right alpha=${right.a}`); // background only
});

test("renderTitleImage: reported size and valid light/dark PNGs", () => {
  const payload = {
    segments: [
      {
        provider: "codex",
        bars: [
          { pct: 37, lightColor: "#248A3D", darkColor: "#30D158" },
          { pct: 82, lightColor: "#248A3D", darkColor: "#30D158" },
        ],
        iconPath: path.join(ASSET_DIR, "provider-codex.png"),
        iconPathDark: null,
      },
    ],
    scale: 2, height: 22, minWidth: 1, paddingX: 0, iconSize: 16, iconBarGap: 4, segmentGap: 8,
    barWidth: 48, barHeight: 4, barGap: 3, barRadius: 2, barMinFill: 6,
    light: { dividerColor: "000000", dividerAlpha: 0.25, barBgColor: "000000", barBgAlpha: 0.3 },
    dark: { dividerColor: "FFFFFF", dividerAlpha: 0.3, barBgColor: "FFFFFF", barBgAlpha: 0.25 },
  };
  const out = renderTitleImage(payload);
  // width = (iconSize*scale + iconBarGap*scale + barWidth*scale) / scale = 16+4+48 = 68
  assert.equal(out.light.width, 68);
  assert.equal(out.light.height, 22);
  const light = decodeB64(out.light.image);
  assert.equal(light.width, 136); // 68 * scale
  assert.equal(light.height, 44); // 22 * scale
  // The image must contain some fully-opaque colored pixels (icon + bars).
  let opaque = 0;
  for (let i = 0; i < light.width * light.height; i++) {
    if (light.data[i * 4 + 3] >= 250) opaque++;
  }
  assert.ok(opaque > 100, `expected opaque pixels, got ${opaque}`);
});

test("renderTitleImage: multi-segment width accounts for dividers", () => {
  const seg = (provider, iconPath) => ({
    provider,
    bars: [{ pct: 40, lightColor: "#248A3D", darkColor: "#30D158" }],
    iconPath,
    iconPathDark: null,
  });
  const payload = {
    segments: [seg("codex", path.join(ASSET_DIR, "provider-codex.png")), seg("claude", path.join(ASSET_DIR, "provider-claude.png"))],
    scale: 2, height: 22, minWidth: 1, paddingX: 0, iconSize: 16, iconBarGap: 4, segmentGap: 8,
    barWidth: 48, barHeight: 4, barGap: 3, barRadius: 2, barMinFill: 6,
    light: { dividerColor: "000000", dividerAlpha: 0.25, barBgColor: "000000", barBgAlpha: 0.3 },
    dark: { dividerColor: "FFFFFF", dividerAlpha: 0.3, barBgColor: "FFFFFF", barBgAlpha: 0.25 },
  };
  const out = renderTitleImage(payload);
  // per segment 16+4+48=68; plus divider gap 8+1+8=17 => (68*2 + 17) = 153
  assert.equal(out.light.width, 153);
});
