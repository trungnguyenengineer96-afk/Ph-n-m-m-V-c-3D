/**
 * Reader for the SolidWorks "DisplayLists" stream: the tessellation SolidWorks
 * caches for every face, with the B-rep edge id of each boundary triangle edge
 * and (modern files) a surface record with the face's analytic surface type.
 *
 * Grammar follows the public research in github.com/blussyya/sldprt-converter
 * (docs/format/displaylists.md, MIT). Every typed array starts with a 16-byte
 * header [stride, kind, 2, count]. A face record is:
 *
 *   [4,8,2,S]   u32[S]      triangle-strip lengths
 *   [12,100,2,V] f32[V][3]  positions (metres)
 *   [12,100,2,V] f32[V][3]  normals
 *   [4,8,2,T]   u32[T]      Block1: per strip a control token (1) then one edge id per strip edge
 *   [4,8,2,S]   u32[S]      Block2: tokens per strip (= 2n-2)
 *   [1,8,2,T]   u8[T]       Block3
 *   132 bytes   bounding record (f64 centre/max/min/radius)
 *   surface record (modern only): ..., face id, direction, type tag, 8 f64 parameters, edge table
 */

export interface DlFace {
  positions: Float32Array; // metres
  normals: Float32Array;
  indices: Uint32Array;
  /** Boundary segments: pairs of local vertex indices with their B-rep edge id. */
  boundary: { a: number; b: number; id: number }[];
  faceId?: number;
  typeTag?: number;
  direction?: [number, number, number];
  parameters?: number[];
}

export interface DlResult {
  faces: DlFace[];
  rejected: number;
  warnings: string[];
}

const SIG = [4, 0, 0, 0, 8, 0, 0, 0, 2, 0, 0, 0];

class Reader {
  readonly dv: DataView;
  constructor(readonly b: Uint8Array) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  check(o: number, n: number) {
    if (o < 0 || n < 0 || o + n > this.b.length) throw new Error('out of bounds');
  }
  u32(o: number) {
    this.check(o, 4);
    return this.dv.getUint32(o, true);
  }
  f64(o: number) {
    this.check(o, 8);
    return this.dv.getFloat64(o, true);
  }
  /** Validates an array header; returns data offset, element count and end offset. */
  arr(o: number, stride: number, kind: number) {
    this.check(o, 16);
    const h0 = this.u32(o), h1 = this.u32(o + 4), h2 = this.u32(o + 8), count = this.u32(o + 12);
    if (h0 !== stride || h1 !== kind || h2 !== 2) throw new Error('unexpected array header');
    const end = o + 16 + stride * count;
    this.check(o + 16, stride * count);
    return { data: o + 16, count, end };
  }
  words(a: { data: number; count: number }): Uint32Array {
    const out = new Uint32Array(a.count);
    for (let i = 0; i < a.count; i++) out[i] = this.dv.getUint32(a.data + 4 * i, true);
    return out;
  }
  floats(a: { data: number; count: number }, comps: number): Float32Array {
    const n = a.count * comps;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = this.dv.getFloat32(a.data + 4 * i, true);
      if (!Number.isFinite(v)) throw new Error('non-finite float');
      out[i] = v;
    }
    return out;
  }
}

function findAll(b: Uint8Array, pat: number[]): number[] {
  const out: number[] = [];
  const first = pat[0];
  const lim = b.length - pat.length;
  outer: for (let i = 0; i <= lim; i++) {
    if (b[i] !== first) continue;
    for (let j = 1; j < pat.length; j++) if (b[i + j] !== pat[j]) continue outer;
    out.push(i);
  }
  return out;
}

const MAX_VERTICES = 4_000_000;

export function parseDisplayLists(dl: Uint8Array, legacy: boolean): DlResult {
  const r = new Reader(dl);
  const faces: (DlFace & { geometryEnd: number; offset: number })[] = [];
  const warnings: string[] = [];
  let rejected = 0;
  let totalVertices = 0;

  for (const off of findAll(dl, SIG)) {
    let pre, pos;
    try {
      pre = r.arr(off, 4, 8);
      pos = r.arr(pre.end, 12, 100);
    } catch {
      continue; // not a face record
    }
    try {
      const nor = r.arr(pos.end, 12, 100);
      const b1 = r.arr(nor.end, 4, 8);
      const b2 = r.arr(b1.end, 4, 8);
      const b3 = r.arr(b2.end, 1, 8);
      const strips = r.words(pre);
      const tokens = r.words(b1);
      const lens = r.words(b2);
      const vc = pos.count;
      let sum = 0;
      for (const s of strips) {
        if (s < 3) throw new Error('strip too short');
        sum += s;
      }
      if (!strips.length || sum !== vc) throw new Error('invalid strip partition');
      if (nor.count !== vc || lens.length !== strips.length) throw new Error('count mismatch');
      let tsum = 0;
      for (let k = 0; k < strips.length; k++) {
        if (lens[k] !== 2 * strips[k] - 2) throw new Error('invalid block2');
        tsum += lens[k];
      }
      if (tsum !== tokens.length || b3.count !== tokens.length) throw new Error('invalid block1');
      totalVertices += vc;
      if (totalVertices > MAX_VERTICES) throw new Error('model too large');

      const positions = r.floats(pos, 3);
      const normals = r.floats(nor, 3);
      const idx: number[] = [];
      const boundary: { a: number; b: number; id: number }[] = [];
      let v = 0;
      let t = 0;
      for (const n of strips) {
        if (tokens[t++] !== 1) throw new Error('unsupported strip control');
        const edge = (a: number, b: number) => {
          const id = tokens[t++];
          if (id !== 0) boundary.push({ a, b, id });
        };
        edge(v, v + 1);
        for (let i = 2; i < n; i++) {
          if (i % 2 === 0) idx.push(v + i - 2, v + i - 1, v + i);
          else idx.push(v + i - 1, v + i - 2, v + i);
          edge(v + i - 2, v + i);
          edge(v + i - 1, v + i);
        }
        v += n;
      }
      faces.push({ offset: off, geometryEnd: b3.end, positions, normals, indices: new Uint32Array(idx), boundary });
    } catch {
      rejected++;
    }
  }

  if (!legacy) {
    for (let i = 0; i < faces.length; i++) {
      const f = faces[i];
      const limit = i + 1 < faces.length ? faces[i + 1].offset : dl.length;
      try {
        const start = f.geometryEnd;
        const a8 = r.arr(start + 132, 8, 100);
        const p = r.arr(a8.end + 4, 12, 100);
        const nn = r.arr(p.end, 12, 100);
        let o = nn.end;
        const scalarFlag = r.u32(o);
        o += 4;
        if (scalarFlag === 1) {
          for (let k = 0; k < 2; k++) o = r.arr(o, 4, 100).end;
        } else if (scalarFlag !== 0) throw new Error('unknown scalar flag');
        o += 12; // reserved
        const faceId = r.u32(o);
        const direction: [number, number, number] = [r.f64(o + 4), r.f64(o + 12), r.f64(o + 20)];
        o += 28;
        const typeTag = r.u32(o);
        const parameters = Array.from({ length: 8 }, (_, k) => r.f64(o + 4 + k * 8));
        const count = r.u32(o + 68);
        if (o + 72 + count * 8 > limit) throw new Error('surface record overlaps next face');
        if (![...direction, ...parameters].every(Number.isFinite)) throw new Error('non-finite surface');
        f.faceId = faceId;
        f.typeTag = typeTag;
        f.direction = direction;
        f.parameters = parameters;
      } catch {
        // Surface record is optional for display; geometry is still valid.
      }
    }
  }
  if (rejected) warnings.push(`${rejected} bản ghi mặt không hợp lệ đã bị bỏ qua — hình có thể thiếu mặt`);
  return { faces, rejected, warnings };
}
