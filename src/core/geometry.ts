/** Geometry helpers: edge chaining, surface/edge classification, fitting. Pure math, no three.js. */
import type { BodyData, EdgeInfo, FaceInfo, SurfaceInfo, Vec3 } from './types';

// ---------- small vector helpers ----------
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export function norm(a: Vec3): Vec3 {
  const l = len(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}
export function pointAt(arr: ArrayLike<number>, i: number): Vec3 {
  return [arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]];
}

// ---------- symmetric 3x3 eigen decomposition (Jacobi) ----------
/** Returns eigenvalues ascending and matching unit eigenvectors. m is row-major 3x3. */
export function eigenSym3(m: number[]): { values: number[]; vectors: Vec3[] } {
  const a = [
    [m[0], m[1], m[2]],
    [m[3], m[4], m[5]],
    [m[6], m[7], m[8]],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-15 * (Math.abs(a[0][0]) + Math.abs(a[1][1]) + Math.abs(a[2][2]) + 1e-300)) break;
    for (let p = 0; p < 2; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
  return {
    values: order.map((i) => a[i][i]),
    vectors: order.map((i) => norm([v[0][i], v[1][i], v[2][i]])),
  };
}

/** Best-fit plane through points: centroid and normal (smallest-variance direction). */
export function fitPlane(pts: Vec3[]): { origin: Vec3; normal: Vec3; rms: number } {
  const n = pts.length;
  const c: Vec3 = [0, 0, 0];
  for (const p of pts) {
    c[0] += p[0] / n;
    c[1] += p[1] / n;
    c[2] += p[2] / n;
  }
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const p of pts) {
    const d = sub(p, c);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i * 3 + j] += d[i] * d[j];
  }
  const e = eigenSym3(m);
  return { origin: c, normal: e.vectors[0], rms: Math.sqrt(Math.max(0, e.values[0]) / n) };
}

/** Orthonormal basis (u, v) perpendicular to n. */
export function basis(n: Vec3): [Vec3, Vec3] {
  const t: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = norm(cross(n, t));
  return [u, cross(n, u)];
}

/** Algebraic (Kåsa) circle fit in 2D, refined by a few Gauss-Newton steps. */
export function fitCircle2D(xs: number[], ys: number[]): { cx: number; cy: number; r: number; rms: number } | null {
  const n = xs.length;
  if (n < 3) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i] / n;
    my += ys[i] / n;
  }
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (let i = 0; i < n; i++) {
    const u = xs[i] - mx, v = ys[i] - my;
    suu += u * u; svv += v * v; suv += u * v;
    suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-18) return null;
  const b1 = 0.5 * (suuu + suvv), b2 = 0.5 * (svvv + svuu);
  let uc = (b1 * svv - b2 * suv) / det;
  let vc = (b2 * suu - b1 * suv) / det;
  let cx = uc + mx, cy = vc + my;
  let r = 0;
  for (let i = 0; i < n; i++) r += Math.hypot(xs[i] - cx, ys[i] - cy) / n;
  // Geometric refinement.
  for (let it = 0; it < 10; it++) {
    let j00 = 0, j01 = 0, j02 = 0, j11 = 0, j12 = 0, j22 = 0, g0 = 0, g1 = 0, g2 = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - cx, dy = ys[i] - cy;
      const d = Math.hypot(dx, dy) || 1e-12;
      const res = d - r;
      const a = -dx / d, b = -dy / d, c = -1;
      j00 += a * a; j01 += a * b; j02 += a * c; j11 += b * b; j12 += b * c; j22 += c * c;
      g0 += a * res; g1 += b * res; g2 += c * res;
    }
    const M = [j00, j01, j02, j01, j11, j12, j02, j12, j22];
    const s = solve3(M, [-g0, -g1, -g2]);
    if (!s) break;
    cx += s[0]; cy += s[1]; r += s[2];
    if (Math.abs(s[0]) + Math.abs(s[1]) + Math.abs(s[2]) < 1e-12 * (Math.abs(r) + 1)) break;
  }
  let rms = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(xs[i] - cx, ys[i] - cy) - r;
    rms += d * d;
  }
  return { cx, cy, r: Math.abs(r), rms: Math.sqrt(rms / n) };
}

export function solve3(m: number[], b: number[]): number[] | null {
  const det =
    m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  if (Math.abs(det) < 1e-30) return null;
  const inv = [
    m[4] * m[8] - m[5] * m[7], m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
    m[5] * m[6] - m[3] * m[8], m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
    m[3] * m[7] - m[4] * m[6], m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3],
  ];
  return [0, 1, 2].map((i) => (inv[i * 3] * b[0] + inv[i * 3 + 1] * b[1] + inv[i * 3 + 2] * b[2]) / det);
}

/** Fit a 3D circle through points: returns centre, plane normal and radius when the fit is good. */
export function fitCircle3D(pts: Vec3[], tol: number) {
  if (pts.length < 3) return null;
  const pl = fitPlane(pts);
  if (pl.rms > tol) return null;
  const [u, v] = basis(pl.normal);
  const xs = pts.map((p) => dot(sub(p, pl.origin), u));
  const ys = pts.map((p) => dot(sub(p, pl.origin), v));
  const c = fitCircle2D(xs, ys);
  if (!c || c.rms > tol || c.r < tol) return null;
  const center = add(pl.origin, add(scale(u, c.cx), scale(v, c.cy)));
  return { center, normal: pl.normal, radius: c.r };
}

// ---------- edge chaining ----------
const keyOf = (x: number, y: number, z: number) => `${x},${y},${z}`;

/**
 * Chains unordered segments (flattened xyz pairs) into polylines. Coincidence
 * uses exact coordinates, which holds for tessellations that share edge nodes.
 */
export function chainSegments(seg: number[]): { points: Float32Array; closed: boolean }[] {
  const nSeg = seg.length / 6;
  const nodes = new Map<string, number>();
  const nodePos: number[] = [];
  const segNodes: number[] = [];
  const nodeId = (x: number, y: number, z: number) => {
    const k = keyOf(x, y, z);
    let id = nodes.get(k);
    if (id === undefined) {
      id = nodePos.length / 3;
      nodes.set(k, id);
      nodePos.push(x, y, z);
    }
    return id;
  };
  for (let s = 0; s < nSeg; s++) {
    const o = s * 6;
    const a = nodeId(seg[o], seg[o + 1], seg[o + 2]);
    const b = nodeId(seg[o + 3], seg[o + 4], seg[o + 5]);
    segNodes.push(a, b);
  }
  const nNodes = nodePos.length / 3;
  const adj: number[][] = Array.from({ length: nNodes }, () => []);
  const usedSeg = new Uint8Array(nSeg);
  const seenPair = new Set<string>();
  for (let s = 0; s < nSeg; s++) {
    const a = segNodes[s * 2], b = segNodes[s * 2 + 1];
    if (a === b) {
      usedSeg[s] = 1;
      continue;
    }
    const pk = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (seenPair.has(pk)) {
      usedSeg[s] = 1; // duplicate segment
      continue;
    }
    seenPair.add(pk);
    adj[a].push(s);
    adj[b].push(s);
  }
  const other = (s: number, n: number) => (segNodes[s * 2] === n ? segNodes[s * 2 + 1] : segNodes[s * 2]);
  const out: { points: Float32Array; closed: boolean }[] = [];
  const walk = (start: number) => {
    const chain = [start];
    let cur = start;
    for (;;) {
      if (adj[cur].length !== 2 && cur !== start) break;
      const next = adj[cur].find((s) => !usedSeg[s]);
      if (next === undefined) break;
      usedSeg[next] = 1;
      cur = other(next, cur);
      chain.push(cur);
      if (cur === start) break;
      if (adj[cur].length !== 2) break;
    }
    return chain;
  };
  const emit = (chain: number[]) => {
    if (chain.length < 2) return;
    const closed = chain.length > 2 && chain[0] === chain[chain.length - 1];
    const ids = closed ? chain.slice(0, -1) : chain;
    const pts = new Float32Array(ids.length * 3);
    ids.forEach((id, i) => pts.set(nodePos.slice(id * 3, id * 3 + 3), i * 3));
    out.push({ points: pts, closed });
  };
  // Open chains start at nodes whose degree is not 2.
  for (let n = 0; n < nNodes; n++) {
    if (adj[n].length === 2) continue;
    while (adj[n].some((s) => !usedSeg[s])) emit(walk(n));
  }
  // Remaining segments are closed loops.
  for (let n = 0; n < nNodes; n++) {
    while (adj[n].some((s) => !usedSeg[s])) emit(walk(n));
  }
  return out;
}

/**
 * Derive B-rep edges for a body whose faces are contiguous triangle ranges
 * (OpenCascade output): segments on the boundary of exactly one face's
 * triangulation, grouped by the pair of faces they separate.
 */
export function edgesFromFaces(positions: Float32Array, indices: Uint32Array, faces: FaceInfo[]): EdgeInfo[] {
  const owner = new Map<string, { face: number; seg: number[]; count: number }>();
  const groups = new Map<string, number[]>();
  const vk = (i: number) => keyOf(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
  faces.forEach((f, fi) => {
    const local = new Map<string, { count: number; a: number; b: number }>();
    for (let t = f.triStart; t < f.triStart + f.triCount; t++) {
      for (let e = 0; e < 3; e++) {
        const a = indices[t * 3 + e], b = indices[t * 3 + ((e + 1) % 3)];
        const ka = vk(a), kb = vk(b);
        if (ka === kb) continue;
        const k = ka < kb ? ka + '|' + kb : kb + '|' + ka;
        const rec = local.get(k);
        if (rec) rec.count++;
        else local.set(k, { count: 1, a, b });
      }
    }
    for (const [k, rec] of local) {
      if (rec.count !== 1) continue; // interior or seam edge
      const prev = owner.get(k);
      if (prev) {
        prev.count++;
        const gk = `${Math.min(prev.face, fi)}_${Math.max(prev.face, fi)}`;
        let g = groups.get(gk);
        if (!g) groups.set(gk, (g = []));
        g.push(...prev.seg);
        owner.delete(k);
      } else {
        owner.set(k, { face: fi, seg: [...pointAt(positions, rec.a), ...pointAt(positions, rec.b)], count: 1 });
      }
    }
  });
  // Unshared boundary (open shells, free edges).
  for (const rec of owner.values()) {
    const gk = `${rec.face}_free`;
    let g = groups.get(gk);
    if (!g) groups.set(gk, (g = []));
    g.push(...rec.seg);
  }
  const edges: EdgeInfo[] = [];
  for (const seg of groups.values()) for (const c of chainSegments(seg)) edges.push({ points: c.points, closed: c.closed });
  return edges;
}

/** Feature edges by dihedral angle, for plain meshes (STL/OBJ) without B-rep faces. */
export function featureEdges(positions: Float32Array, indices: Uint32Array, angleDeg = 30): EdgeInfo[] {
  const cosT = Math.cos((angleDeg * Math.PI) / 180);
  const vk = (i: number) => keyOf(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
  const triN = (t: number): Vec3 => {
    const a = pointAt(positions, indices[t * 3]), b = pointAt(positions, indices[t * 3 + 1]), c = pointAt(positions, indices[t * 3 + 2]);
    return norm(cross(sub(b, a), sub(c, a)));
  };
  const map = new Map<string, { t: number; a: number; b: number; done: boolean }>();
  const seg: number[] = [];
  const nt = indices.length / 3;
  for (let t = 0; t < nt; t++) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t * 3 + e], b = indices[t * 3 + ((e + 1) % 3)];
      const ka = vk(a), kb = vk(b);
      if (ka === kb) continue;
      const k = ka < kb ? ka + '|' + kb : kb + '|' + ka;
      const rec = map.get(k);
      if (!rec) map.set(k, { t, a, b, done: false });
      else if (!rec.done) {
        rec.done = true;
        if (dot(triN(rec.t), triN(t)) < cosT) seg.push(...pointAt(positions, a), ...pointAt(positions, b));
      }
    }
  }
  for (const rec of map.values()) if (!rec.done) seg.push(...pointAt(positions, rec.a), ...pointAt(positions, rec.b));
  return chainSegments(seg).map((c) => ({ points: c.points, closed: c.closed }));
}

// ---------- classification ----------
export function polylineLength(pts: Float32Array, closed: boolean): number {
  let L = 0;
  const n = pts.length / 3;
  for (let i = 1; i < n; i++) L += dist(pointAt(pts, i - 1), pointAt(pts, i));
  if (closed && n > 2) L += dist(pointAt(pts, n - 1), pointAt(pts, 0));
  return L;
}

/** Fill kind/length/center/radius of an edge. tol is an absolute model tolerance (mm). */
export function analyseEdge(e: EdgeInfo, tol: number): EdgeInfo {
  if (e.kind) return e;
  const n = e.points.length / 3;
  const pts: Vec3[] = [];
  for (let i = 0; i < n; i++) pts.push(pointAt(e.points, i));
  e.length = polylineLength(e.points, e.closed);
  if (n === 2 && !e.closed) {
    e.kind = 'line';
    return e;
  }
  // Line test: all points near the chord.
  const a = pts[0], b = pts[n - 1];
  const dir = norm(sub(b, a));
  if (!e.closed && len(sub(b, a)) > tol) {
    let maxd = 0;
    for (const p of pts) maxd = Math.max(maxd, len(cross(sub(p, a), dir)));
    if (maxd < tol) {
      e.kind = 'line';
      e.length = dist(a, b);
      return e;
    }
  }
  if (n >= 3) {
    const c = fitCircle3D(pts, tol * 2);
    if (c) {
      let maxDev = 0;
      for (const p of pts) maxDev = Math.max(maxDev, Math.abs(dist(p, c.center) - c.radius));
      if (maxDev < Math.max(tol * 2, c.radius * 0.01)) {
        e.center = c.center;
        e.radius = c.radius;
        e.normal = c.normal;
        e.kind = e.closed ? 'circle' : 'arc';
        if (e.closed) e.length = 2 * Math.PI * c.radius;
        return e;
      }
    }
  }
  e.kind = 'curve';
  return e;
}

/** Collect unique vertices of a face (world-independent, body-local coordinates). */
export function facePoints(body: BodyData, face: FaceInfo, maxPts = 4000): Vec3[] {
  const seen = new Set<number>();
  const pts: Vec3[] = [];
  const { indices, positions } = body;
  const step = Math.max(1, Math.floor((face.triCount * 3) / maxPts));
  for (let k = face.triStart * 3; k < (face.triStart + face.triCount) * 3; k += step) {
    const vi = indices[k];
    if (seen.has(vi)) continue;
    seen.add(vi);
    pts.push(pointAt(positions, vi));
  }
  return pts;
}

export function faceArea(body: BodyData, face: FaceInfo): number {
  const { indices, positions } = body;
  let A = 0;
  for (let t = face.triStart; t < face.triStart + face.triCount; t++) {
    const a = pointAt(positions, indices[t * 3]), b = pointAt(positions, indices[t * 3 + 1]), c = pointAt(positions, indices[t * 3 + 2]);
    A += len(cross(sub(b, a), sub(c, a))) / 2;
  }
  return A;
}

/** Classify a face from its mesh, unless the source file already gave an exact surface. */
export function analyseFace(body: BodyData, face: FaceInfo, tol: number): SurfaceInfo {
  if (face.surface?.exact && face.surface.kind !== 'other' && face.surface.kind !== 'bspline') return face.surface;
  const { indices, positions } = body;
  // Area-weighted triangle normals.
  const tn: Vec3[] = [];
  const avg: Vec3 = [0, 0, 0];
  for (let t = face.triStart; t < face.triStart + face.triCount; t++) {
    const a = pointAt(positions, indices[t * 3]), b = pointAt(positions, indices[t * 3 + 1]), c = pointAt(positions, indices[t * 3 + 2]);
    const cr = cross(sub(b, a), sub(c, a));
    if (len(cr) < 1e-14) continue;
    const n = norm(cr);
    tn.push(n);
    avg[0] += cr[0]; avg[1] += cr[1]; avg[2] += cr[2];
  }
  const pts = facePoints(body, face);
  const fallback: SurfaceInfo = face.surface ?? { kind: 'other' };
  if (!tn.length || pts.length < 3) return fallback;
  const an = norm(avg);
  let minDot = 1;
  for (const n of tn) minDot = Math.min(minDot, dot(n, an));
  if (minDot > 0.9999) {
    const pl = fitPlane(pts);
    if (pl.rms < tol) {
      const nrm = dot(pl.normal, an) < 0 ? scale(pl.normal, -1) : pl.normal;
      return { kind: 'plane', axis: nrm, origin: pl.origin };
    }
  }
  // Cylinder: normals perpendicular to a common axis.
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const n of tn) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i * 3 + j] += n[i] * n[j];
  const e = eigenSym3(m);
  const axis = e.vectors[0];
  let maxAx = 0;
  for (const n of tn) maxAx = Math.max(maxAx, Math.abs(dot(n, axis)));
  if (maxAx < 0.02) {
    const [u, v] = basis(axis);
    const c = fitCircle2D(pts.map((p) => dot(p, u)), pts.map((p) => dot(p, v)));
    if (c && c.rms < Math.max(tol, c.r * 0.01)) {
      const along = pts.reduce((s, p) => s + dot(p, axis), 0) / pts.length;
      const origin = add(add(scale(u, c.cx), scale(v, c.cy)), scale(axis, along));
      return { kind: 'cylinder', axis, origin, radius: c.r, exact: false };
    }
  }
  // Sphere: least-squares fit x² + y² + z² = 2ax + 2by + 2cz + d.
  const sph = fitSphere(pts);
  if (sph && sph.rms < Math.max(tol, sph.r * 0.01)) return { kind: 'sphere', origin: sph.c, radius: sph.r };
  return fallback;
}

export function fitSphere(pts: Vec3[]): { c: Vec3; r: number; rms: number } | null {
  if (pts.length < 4) return null;
  // Normal equations for [a b c d].
  const A = new Array(16).fill(0);
  const B = [0, 0, 0, 0];
  for (const p of pts) {
    const row = [2 * p[0], 2 * p[1], 2 * p[2], 1];
    const rhs = p[0] * p[0] + p[1] * p[1] + p[2] * p[2];
    for (let i = 0; i < 4; i++) {
      B[i] += row[i] * rhs;
      for (let j = 0; j < 4; j++) A[i * 4 + j] += row[i] * row[j];
    }
  }
  const x = solveN(A, B, 4);
  if (!x) return null;
  const c: Vec3 = [x[0], x[1], x[2]];
  const r2 = x[3] + dot(c, c);
  if (r2 <= 0) return null;
  const r = Math.sqrt(r2);
  let rms = 0;
  for (const p of pts) rms += (dist(p, c) - r) ** 2;
  return { c, r, rms: Math.sqrt(rms / pts.length) };
}

function solveN(A: number[], b: number[], n: number): number[] | null {
  const M = A.slice();
  const x = b.slice();
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let k = i + 1; k < n; k++) if (Math.abs(M[k * n + i]) > Math.abs(M[p * n + i])) p = k;
    if (Math.abs(M[p * n + i]) < 1e-20) return null;
    if (p !== i) {
      for (let k = 0; k < n; k++) [M[i * n + k], M[p * n + k]] = [M[p * n + k], M[i * n + k]];
      [x[i], x[p]] = [x[p], x[i]];
    }
    for (let k = i + 1; k < n; k++) {
      const f = M[k * n + i] / M[i * n + i];
      for (let j = i; j < n; j++) M[k * n + j] -= f * M[i * n + j];
      x[k] -= f * x[i];
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i];
    for (let j = i + 1; j < n; j++) s -= M[i * n + j] * x[j];
    x[i] = s / M[i * n + i];
  }
  return x;
}

/** Bounding-box diagonal of a set of bodies (used to scale tolerances). */
export function bodiesDiagonal(bodies: BodyData[]): number {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const b of bodies) {
    const p = b.positions.length ? b.positions : null;
    const arrs = p ? [p] : b.edges.map((e) => e.points);
    for (const arr of arrs)
      for (let i = 0; i < arr.length; i += 3)
        for (let k = 0; k < 3; k++) {
          if (arr[i + k] < min[k]) min[k] = arr[i + k];
          if (arr[i + k] > max[k]) max[k] = arr[i + k];
        }
  }
  if (!Number.isFinite(min[0])) return 1;
  return Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
}

/** Union-find helper. */
export class DisjointSet {
  private p: Int32Array;
  constructor(n: number) {
    this.p = new Int32Array(n).map((_, i) => i);
  }
  find(x: number): number {
    while (this.p[x] !== x) {
      this.p[x] = this.p[this.p[x]];
      x = this.p[x];
    }
    return x;
  }
  union(a: number, b: number) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.p[ra] = rb;
  }
}

/**
 * Merge arcs that lie on the same circle and touch end to end (e.g. a hole
 * whose cylinder was exported as two half faces) into a single edge.
 */
export function mergeCoCircularArcs(edges: EdgeInfo[], tol: number): EdgeInfo[] {
  const q = (x: number) => Math.round(x / (tol * 20));
  const groups = new Map<string, EdgeInfo[]>();
  const out: EdgeInfo[] = [];
  for (const e of edges) {
    analyseEdge(e, tol);
    if (e.kind !== 'arc' || !e.center || !e.radius || !e.normal) {
      out.push(e);
      continue;
    }
    const n = e.normal[2] < 0 || (e.normal[2] === 0 && (e.normal[1] < 0 || (e.normal[1] === 0 && e.normal[0] < 0))) ? scale(e.normal, -1) : e.normal;
    const k = [...e.center.map(q), q(e.radius), ...n.map((x) => Math.round(x * 200))].join(',');
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    g.push(e);
  }
  for (const g of groups.values()) {
    if (g.length === 1) {
      out.push(g[0]);
      continue;
    }
    const seg: number[] = [];
    for (const e of g) {
      const n = e.points.length / 3;
      for (let i = 1; i < n; i++) seg.push(...pointAt(e.points, i - 1), ...pointAt(e.points, i));
    }
    for (const c of chainSegments(seg)) out.push(analyseEdge({ points: c.points, closed: c.closed }, tol));
  }
  return out;
}
