import zlib from "node:zlib";

// Minimal zero-dependency PNG codec, scoped to 8-bit RGBA, non-interlaced images.
// That is the only format this tool renders (menu bar strips) and the only
// format its provider icon assets use (all 18x18 RGBA8). Keeping the codec tiny
// preserves the package's zero-runtime-dependency property.

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

export function encodePNG(rgba: Uint8Array, width: number, height: number): Buffer {
  const stride = width * 4;
  // One filter byte (0 = None) per scanline, followed by the raw RGBA row.
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const dst = y * (stride + 1);
    raw[dst] = 0;
    for (let i = 0; i < stride; i++) {
      raw[dst + 1 + i] = rgba[y * stride + i];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export interface DecodedPNG {
  width: number;
  height: number;
  data: Uint8Array; // RGBA, top-left origin
}

export function decodePNG(buffer: Buffer): DecodedPNG {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("decodePNG: not a PNG file");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  const idatParts: Buffer[] = [];
  while (offset < buffer.length) {
    const len = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const data = buffer.subarray(dataStart, dataStart + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      const interlace = data[12];
      if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
        throw new Error(`decodePNG: unsupported PNG (bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}); only 8-bit RGBA non-interlaced is supported`);
      }
    } else if (type === "IDAT") {
      idatParts.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    offset = dataStart + len + 4; // skip data + CRC
  }
  const inflated = zlib.inflateSync(Buffer.concat(idatParts));
  const bpp = 4;
  const stride = width * bpp;
  const out = new Uint8Array(width * height * bpp);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filterType = inflated[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const rawByte = inflated[rowStart + i];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let value: number;
      switch (filterType) {
        case 0: value = rawByte; break;
        case 1: value = rawByte + a; break;
        case 2: value = rawByte + b; break;
        case 3: value = rawByte + ((a + b) >> 1); break;
        case 4: value = rawByte + paeth(a, b, c); break;
        default: throw new Error(`decodePNG: unknown filter type ${filterType}`);
      }
      cur[i] = value & 0xff;
    }
    out.set(cur, y * stride);
    prev = cur;
  }
  return { width, height, data: out };
}
