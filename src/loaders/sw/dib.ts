/** Decode the headerless Windows DIB stored in SolidWorks "Preview" streams to RGBA. */
export function decodeDib(data: Uint8Array): { width: number; height: number; rgba: Uint8ClampedArray } | null {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // Some files prefix the BITMAPINFOHEADER with a u32 length.
  let o = -1;
  for (const cand of [0, 4, 8]) {
    if (cand + 40 <= data.length && dv.getUint32(cand, true) === 40) {
      o = cand;
      break;
    }
  }
  if (o < 0) return null;
  const width = dv.getInt32(o + 4, true);
  let height = dv.getInt32(o + 8, true);
  const bpp = dv.getUint16(o + 14, true);
  const compression = dv.getUint32(o + 16, true);
  let clrUsed = dv.getUint32(o + 32, true);
  if (width <= 0 || width > 8192 || Math.abs(height) > 8192) return null;
  if (compression !== 0 && !(compression === 1 && bpp === 8)) return null;
  const topDown = height < 0;
  height = Math.abs(height);
  let p = o + 40;
  let palette: Uint8Array | null = null;
  if (bpp <= 8) {
    if (!clrUsed) clrUsed = 1 << bpp;
    palette = data.subarray(p, p + clrUsed * 4);
    p += clrUsed * 4;
  } else if (bpp !== 24 && bpp !== 32) return null;
  const rgba = new Uint8ClampedArray(width * height * 4);
  if (compression === 1 && palette) {
    decodeRle8(data, p, width, height, topDown, palette, rgba);
    return { width, height, rgba };
  }
  const stride = ((width * bpp + 31) >> 5) << 2;
  if (p + stride * height > data.length) return null;
  for (let y = 0; y < height; y++) {
    const row = p + (topDown ? y : height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const d = (y * width + x) * 4;
      if (bpp === 24 || bpp === 32) {
        const s = row + x * (bpp / 8);
        rgba[d] = data[s + 2];
        rgba[d + 1] = data[s + 1];
        rgba[d + 2] = data[s];
      } else if (palette) {
        const bitPos = x * bpp;
        const byte = data[row + (bitPos >> 3)];
        const idx = (byte >> (8 - bpp - (bitPos & 7))) & ((1 << bpp) - 1);
        rgba[d] = palette[idx * 4 + 2];
        rgba[d + 1] = palette[idx * 4 + 1];
        rgba[d + 2] = palette[idx * 4];
      }
      rgba[d + 3] = 255;
    }
  }
  return { width, height, rgba };
}

/** BI_RLE8 run-length decoding (Windows bitmap compression 1). */
function decodeRle8(data: Uint8Array, p: number, width: number, height: number, topDown: boolean, palette: Uint8Array, rgba: Uint8ClampedArray) {
  let x = 0, y = 0;
  const put = (idx: number) => {
    if (x < width && y < height) {
      const row = topDown ? y : height - 1 - y;
      const d = (row * width + x) * 4;
      rgba[d] = palette[idx * 4 + 2];
      rgba[d + 1] = palette[idx * 4 + 1];
      rgba[d + 2] = palette[idx * 4];
      rgba[d + 3] = 255;
    }
    x++;
  };
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  while (p + 1 < data.length) {
    const count = data[p++], val = data[p++];
    if (count > 0) for (let k = 0; k < count; k++) put(val);
    else if (val === 0) { x = 0; y++; }
    else if (val === 1) break;
    else if (val === 2) { x += data[p++]; y += data[p++]; }
    else {
      for (let k = 0; k < val; k++) put(data[p++]);
      if (val & 1) p++; // word alignment
    }
  }
}
