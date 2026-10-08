/**
 * SolidWorks container readers.
 *
 * Two container generations exist:
 *  - Legacy (≤ SW2014): an OLE2 / Compound File Binary document.
 *  - Modern (SW2015+): a flat sequence of DEFLATE-compressed streams. Each stream
 *    has a 30-byte header whose layout coincides with a ZIP local file header:
 *
 *      +0  u32 per-file signature    +4 u16 20   +6 u16 6   +8 u16 8 (deflate)
 *      +14 u32 CRC-32 of inflated data
 *      +18 u32 compressed size        +22 u32 inflated size
 *      +26 u16 name length            +28 u16 extra length
 *      +30 name (each byte rotated left by (file byte 7 & 7) bits), then raw DEFLATE
 *
 * Layout as documented by the open format research projects
 * github.com/blussyya/sldprt-converter and github.com/KenM76/swformat (MIT).
 */
import { inflate, inflateRaw } from 'pako';
import * as CFB from 'cfb';

export interface SwStream {
  name: string;
  data: Uint8Array;
}

export interface SwContainer {
  format: 'modern' | 'ole2';
  streams: SwStream[];
  warnings: string[];
}

const MARKER = [0x14, 0x00, 0x06, 0x00, 0x08, 0x00];
const MAX_STREAM = 256 * 1024 * 1024;

let crcTable: Uint32Array | null = null;
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function isOle2(b: Uint8Array): boolean {
  return b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;
}

function rol(b: number, s: number): number {
  s &= 7;
  return s ? ((b << s) | (b >>> (8 - s))) & 0xff : b;
}

function inflateAny(data: Uint8Array): Uint8Array | null {
  try {
    return inflateRaw(data);
  } catch {
    try {
      return inflate(data);
    } catch {
      return null;
    }
  }
}

/** Read every stream of a modern (SW2015+) file. First occurrence of a name wins. */
export function readModern(buf: Uint8Array): SwContainer {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const key = buf[7];
  const streams: SwStream[] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];
  const n = buf.length;
  let i = 4;
  while (i + MARKER.length <= n) {
    // Fast scan for the marker.
    if (buf[i] !== 0x14 || buf[i + 1] !== 0 || buf[i + 2] !== 6 || buf[i + 3] !== 0 || buf[i + 4] !== 8 || buf[i + 5] !== 0) {
      i++;
      continue;
    }
    const si = i - 4;
    if (si + 30 > n) break;
    const crc = dv.getUint32(si + 14, true);
    const csz = dv.getUint32(si + 18, true);
    const nameLen = dv.getUint16(si + 26, true);
    const extra = dv.getUint16(si + 28, true);
    const nameStart = si + 30;
    const dataStart = nameStart + nameLen + extra;
    const dataEnd = dataStart + csz;
    if (nameLen === 0 || nameLen > 1024 || csz === 0 || csz > MAX_STREAM || dataEnd > n || crc < 65536) {
      i++;
      continue;
    }
    let name = '';
    let printable = true;
    for (let k = 0; k < nameLen; k++) {
      const c = rol(buf[nameStart + k], key);
      if (c < 0x20 || c > 0x7e) {
        printable = false;
        break;
      }
      name += String.fromCharCode(c);
    }
    if (!printable) {
      i++;
      continue;
    }
    const data = inflateAny(buf.subarray(dataStart, dataEnd));
    if (!data) {
      i++;
      continue;
    }
    if (crc32(data) !== crc) {
      warnings.push(`Luồng "${name}" sai CRC — bỏ qua`);
      i++;
      continue;
    }
    if (!seen.has(name)) {
      seen.add(name);
      streams.push({ name, data });
    }
    // Skip the payload: the marker can occur by chance inside compressed data.
    i = dataEnd;
  }
  return { format: 'modern', streams, warnings };
}

/** Read every stream of a legacy OLE2 compound file. Names are full paths without the root. */
export function readOle(buf: Uint8Array): SwContainer {
  const cfb = CFB.read(buf, { type: 'buffer' });
  const streams: SwStream[] = [];
  for (let k = 0; k < cfb.FileIndex.length; k++) {
    const e = cfb.FileIndex[k];
    if (e.type !== 2 || !e.content) continue;
    const full = cfb.FullPaths[k].replace(/^[^/]*\//, '').replace(/\/$/, '');
    const content = e.content as unknown as Uint8Array | number[];
    streams.push({ name: full, data: content instanceof Uint8Array ? content : Uint8Array.from(content) });
  }
  return { format: 'ole2', streams, warnings: [] };
}

export function readContainer(buf: Uint8Array): SwContainer {
  return isOle2(buf) ? readOle(buf) : readModern(buf);
}

/**
 * Legacy "DisplayLists__ZLB" streams are wrapped: a 16-byte magic, u32 inflated
 * size at +16, u32 packed size at +20, zlib data at +24.
 */
export function unwrapLegacyZlb(raw: Uint8Array): Uint8Array {
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (raw.length < 32) throw new Error('DisplayLists__ZLB quá ngắn');
  const packed = dv.getUint32(20, true);
  const data = raw.subarray(24, Math.min(raw.length, 24 + packed));
  const out = inflateAny(data);
  if (!out) throw new Error('Không giải nén được DisplayLists__ZLB');
  return out;
}

export function textOf(data: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(data);
}
