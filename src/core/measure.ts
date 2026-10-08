/**
 * Measurement logic in world space, independent of rendering.
 * Mirrors SolidWorks' Measure tool: one entity → its properties,
 * two entities → distance / angle / centre distance as applicable.
 */
import type { SurfaceInfo, Vec3 } from './types';
import { add, cross, dist, dot, len, norm, scale, sub } from './geometry';

export type MEntity =
  | { type: 'point'; p: Vec3; label: string }
  | {
      type: 'edge';
      label: string;
      kind: 'line' | 'circle' | 'arc' | 'curve';
      length: number;
      points: Vec3[];
      center?: Vec3;
      radius?: number;
      normal?: Vec3;
    }
  | {
      type: 'face';
      label: string;
      surface: SurfaceInfo; // world space
      area: number;
      points: Vec3[]; // sampled vertices (world)
      triangles: Float32Array; // world-space triangle soup (xyz * 3 per tri), possibly subsampled
    };

export type Unit = 'mm' | 'mm2' | 'deg' | 'none';
export interface MRow {
  label: string;
  value: number | string;
  unit: Unit;
  primary?: boolean;
}
export interface MResult {
  rows: MRow[];
  /** Segment to draw as the dimension line (world). */
  line?: [Vec3, Vec3];
  /** Extra marker points (centres). */
  markers?: Vec3[];
}

const PAR_TOL = 1e-4; // |sin| below which directions count as parallel

export function closestPointOnSegment(p: Vec3, a: Vec3, b: Vec3): Vec3 {
  const ab = sub(b, a);
  const L2 = dot(ab, ab);
  if (L2 < 1e-30) return a;
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / L2));
  return add(a, scale(ab, t));
}

/** Closest point on triangle (Ericson, Real-Time Collision Detection 5.1.5). */
export function closestPointOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, scale(ab, d1 / (d1 - d3)));
  const cp = sub(p, c);
  const d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, scale(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return add(b, scale(sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))));
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  return add(a, add(scale(ab, v), scale(ac, w)));
}

/** Closest points between two segments. */
export function closestSegSeg(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): [Vec3, Vec3] {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s = 0, t = 0;
  if (a <= 1e-30 && e <= 1e-30) return [p1, p2];
  if (a <= 1e-30) t = Math.max(0, Math.min(1, f / e));
  else {
    const c = dot(d1, r);
    if (e <= 1e-30) s = Math.max(0, Math.min(1, -c / a));
    else {
      const b = dot(d1, d2), den = a * e - b * b;
      s = den > 1e-30 ? Math.max(0, Math.min(1, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.max(0, Math.min(1, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.max(0, Math.min(1, (b - c) / a));
      }
    }
  }
  return [add(p1, scale(d1, s)), add(p2, scale(d2, t))];
}

type Geo = { pts: Vec3[]; segs: [Vec3, Vec3][]; tris: Float32Array | null };
function geoOf(e: MEntity): Geo {
  if (e.type === 'point') return { pts: [e.p], segs: [], tris: null };
  if (e.type === 'edge') {
    const segs: [Vec3, Vec3][] = [];
    for (let i = 1; i < e.points.length; i++) segs.push([e.points[i - 1], e.points[i]]);
    if ((e.kind === 'circle') && e.points.length > 2) segs.push([e.points[e.points.length - 1], e.points[0]]);
    return { pts: e.points, segs, tris: null };
  }
  return { pts: e.points, segs: [], tris: e.triangles };
}

const triAt = (t: Float32Array, i: number): [Vec3, Vec3, Vec3] => [
  [t[i * 9], t[i * 9 + 1], t[i * 9 + 2]],
  [t[i * 9 + 3], t[i * 9 + 4], t[i * 9 + 5]],
  [t[i * 9 + 6], t[i * 9 + 7], t[i * 9 + 8]],
];

/** Approximate minimum distance between two entities (exact for points/segments/triangles pairs tested). */
export function minDistance(A: MEntity, B: MEntity): { d: number; pa: Vec3; pb: Vec3 } {
  const ga = geoOf(A), gb = geoOf(B);
  let best = { d: Infinity, pa: ga.pts[0], pb: gb.pts[0] };
  const consider = (pa: Vec3, pb: Vec3) => {
    const d = dist(pa, pb);
    if (d < best.d) best = { d, pa, pb };
  };
  const budget = 3_000_000;
  const pointsVs = (pts: Vec3[], g: Geo, flip: boolean) => {
    const work = pts.length * (g.segs.length + (g.tris ? g.tris.length / 9 : 0) + g.pts.length);
    const step = Math.max(1, Math.ceil(work / budget));
    for (let i = 0; i < pts.length; i += step) {
      const p = pts[i];
      if (g.tris) {
        const nt = g.tris.length / 9;
        for (let t = 0; t < nt; t++) {
          const [a, b, c] = triAt(g.tris, t);
          const q = closestPointOnTriangle(p, a, b, c);
          flip ? consider(q, p) : consider(p, q);
        }
      } else if (g.segs.length) {
        for (const [a, b] of g.segs) {
          const q = closestPointOnSegment(p, a, b);
          flip ? consider(q, p) : consider(p, q);
        }
      } else for (const q of g.pts) flip ? consider(q, p) : consider(p, q);
    }
  };
  pointsVs(ga.pts, gb, false);
  pointsVs(gb.pts, ga, true);
  if (ga.segs.length && gb.segs.length) {
    const step = Math.max(1, Math.ceil((ga.segs.length * gb.segs.length) / budget));
    for (let i = 0; i < ga.segs.length; i += step)
      for (const s2 of gb.segs) {
        const [p, q] = closestSegSeg(ga.segs[i][0], ga.segs[i][1], s2[0], s2[1]);
        consider(p, q);
      }
  }
  return best;
}

const deg = (r: number) => (r * 180) / Math.PI;
function angleBetween(u: Vec3, v: Vec3, unsigned = true) {
  const c = Math.max(-1, Math.min(1, dot(norm(u), norm(v))));
  let a = deg(Math.acos(c));
  if (unsigned && a > 90) a = 180 - a;
  return a;
}

function lineOf(e: MEntity): { p: Vec3; d: Vec3 } | null {
  if (e.type === 'edge' && e.kind === 'line') return { p: e.points[0], d: norm(sub(e.points[e.points.length - 1], e.points[0])) };
  if (e.type === 'face' && (e.surface.kind === 'cylinder' || e.surface.kind === 'cone') && e.surface.axis && e.surface.origin)
    return { p: e.surface.origin, d: norm(e.surface.axis) };
  return null;
}
function planeOf(e: MEntity): { p: Vec3; n: Vec3 } | null {
  if (e.type === 'face' && e.surface.kind === 'plane' && e.surface.axis) {
    const p = e.surface.origin ?? e.points[0];
    return { p, n: norm(e.surface.axis) };
  }
  return null;
}
function centerOf(e: MEntity): Vec3 | null {
  if (e.type === 'point') return e.p;
  if (e.type === 'edge' && (e.kind === 'circle' || e.kind === 'arc') && e.center) return e.center;
  if (e.type === 'face' && e.surface.kind === 'sphere' && e.surface.origin) return e.surface.origin;
  return null;
}

const distPointLine = (p: Vec3, l: { p: Vec3; d: Vec3 }) => {
  const v = sub(p, l.p);
  const foot = add(l.p, scale(l.d, dot(v, l.d)));
  return { d: dist(p, foot), foot };
};

/** Properties of a single entity. */
export function describe(e: MEntity): MResult {
  if (e.type === 'point')
    return {
      rows: [
        { label: 'X', value: e.p[0], unit: 'mm' },
        { label: 'Y', value: e.p[1], unit: 'mm' },
        { label: 'Z', value: e.p[2], unit: 'mm' },
      ],
    };
  if (e.type === 'edge') {
    const rows: MRow[] = [];
    const kindName = { line: 'Đường thẳng', circle: 'Đường tròn', arc: 'Cung tròn', curve: 'Đường cong' }[e.kind];
    rows.push({ label: 'Loại cạnh', value: kindName, unit: 'none' });
    if (e.radius !== undefined && (e.kind === 'circle' || e.kind === 'arc')) {
      rows.push({ label: 'Đường kính', value: e.radius * 2, unit: 'mm', primary: true });
      rows.push({ label: 'Bán kính', value: e.radius, unit: 'mm' });
      if (e.center) rows.push({ label: 'Tâm', value: fmtVec(e.center), unit: 'none' });
      rows.push({ label: e.kind === 'circle' ? 'Chu vi' : 'Chiều dài cung', value: e.length, unit: 'mm' });
    } else rows.push({ label: 'Chiều dài', value: e.length, unit: 'mm', primary: true });
    if (e.kind === 'line') {
      const d = sub(e.points[e.points.length - 1], e.points[0]);
      rows.push({ label: 'dX / dY / dZ', value: fmtVec(d.map(Math.abs) as Vec3), unit: 'none' });
    }
    return { rows, markers: e.center ? [e.center] : undefined };
  }
  const s = e.surface;
  const rows: MRow[] = [];
  const kindName: Record<string, string> = {
    plane: 'Mặt phẳng', cylinder: 'Mặt trụ', cone: 'Mặt côn', sphere: 'Mặt cầu', torus: 'Mặt xuyến', bspline: 'Mặt B-spline', other: 'Mặt cong',
  };
  rows.push({ label: 'Loại mặt', value: kindName[s.kind] + (s.exact ? '' : s.kind === 'other' ? '' : ' (khớp từ lưới)'), unit: 'none' });
  const round = s.radius !== undefined && (s.kind === 'cylinder' || s.kind === 'sphere' || s.kind === 'cone');
  if (round && s.kind !== 'cone') rows.push({ label: 'Đường kính', value: s.radius! * 2, unit: 'mm', primary: true });
  rows.push({ label: 'Diện tích', value: e.area, unit: 'mm2', primary: !round || s.kind === 'cone' });
  if (round) {
    if (s.kind === 'cone') rows.push({ label: 'Đường kính (tham chiếu)', value: s.radius! * 2, unit: 'mm' });
    rows.push({ label: 'Bán kính', value: s.radius!, unit: 'mm' });
  }
  if (s.kind === 'cone' && s.halfAngle !== undefined) rows.push({ label: 'Nửa góc côn', value: deg(s.halfAngle), unit: 'deg' });
  if (s.axis) rows.push({ label: s.kind === 'plane' ? 'Pháp tuyến' : 'Trục', value: fmtVec(s.axis, 4), unit: 'none' });
  return { rows };
}

export function fmtVec(v: Vec3, digits = 3) {
  return `(${v.map((x) => (Math.abs(x) < 10 ** -digits / 2 ? 0 : x).toFixed(digits)).join(', ')})`;
}

/** Measurement between two entities. */
export function measurePair(A: MEntity, B: MEntity): MResult {
  const rows: MRow[] = [];
  let line: [Vec3, Vec3] | undefined;
  const markers: Vec3[] = [];

  const ca = centerOf(A), cb = centerOf(B);
  const la = lineOf(A), lb = lineOf(B);
  const pa = planeOf(A), pb = planeOf(B);

  if (A.type === 'point' && B.type === 'point') {
    const d = sub(B.p, A.p);
    rows.push({ label: 'Khoảng cách', value: len(d), unit: 'mm', primary: true });
    rows.push({ label: 'dX', value: Math.abs(d[0]), unit: 'mm' });
    rows.push({ label: 'dY', value: Math.abs(d[1]), unit: 'mm' });
    rows.push({ label: 'dZ', value: Math.abs(d[2]), unit: 'mm' });
    return { rows, line: [A.p, B.p] };
  }

  // Plane – plane
  if (pa && pb) {
    const s = len(cross(pa.n, pb.n));
    if (s < PAR_TOL) {
      const d = Math.abs(dot(sub(pb.p, pa.p), pa.n));
      rows.push({ label: 'Khoảng cách (song song)', value: d, unit: 'mm', primary: true });
      const foot = sub(B.type === 'face' ? B.points[0] : pb.p, scale(pa.n, dot(sub(B.type === 'face' ? B.points[0] : pb.p, pa.p), pa.n)));
      line = [foot, B.type === 'face' ? B.points[0] : pb.p];
    } else rows.push({ label: 'Góc', value: angleBetween(pa.n, pb.n, false), unit: 'deg', primary: true });
  }

  // Point / centre – plane
  const pointLike = (e: MEntity) => (e.type === 'point' ? e.p : centerOf(e));
  for (const [P, PL] of [
    [A, pb],
    [B, pa],
  ] as const) {
    const p = pointLike(P);
    if (p && PL && !(pa && pb)) {
      const sd = dot(sub(p, PL.p), PL.n);
      rows.push({ label: P.type === 'point' ? 'Khoảng cách điểm–mặt' : 'Khoảng cách tâm–mặt', value: Math.abs(sd), unit: 'mm', primary: true });
      line = [p, sub(p, scale(PL.n, sd))];
    }
  }

  // Centre – centre (circles, spheres, points)
  if (ca && cb && !(A.type === 'point' && B.type === 'point')) {
    const d = sub(cb, ca);
    rows.push({ label: 'Khoảng cách tâm–tâm', value: len(d), unit: 'mm', primary: !rows.some((r) => r.primary) });
    rows.push({ label: 'dX / dY / dZ (tâm)', value: fmtVec(d.map(Math.abs) as Vec3), unit: 'none' });
    if (!line) line = [ca, cb];
    markers.push(ca, cb);
  }

  // Line/axis – line/axis
  if (la && lb) {
    const s = len(cross(la.d, lb.d));
    if (s < PAR_TOL) {
      const r = distPointLine(lb.p, la);
      rows.push({
        label: A.type === 'face' || B.type === 'face' ? 'Khoảng cách trục–trục' : 'Khoảng cách (song song)',
        value: r.d,
        unit: 'mm',
        primary: !rows.some((x) => x.primary),
      });
      if (!line) line = [r.foot, lb.p];
    } else {
      rows.push({ label: 'Góc', value: angleBetween(la.d, lb.d), unit: 'deg', primary: !rows.some((x) => x.primary) });
      // Common perpendicular length (skew distance)
      const n = norm(cross(la.d, lb.d));
      const skew = Math.abs(dot(sub(lb.p, la.p), n));
      if (skew > 1e-9) rows.push({ label: 'Khoảng cách vuông góc chung', value: skew, unit: 'mm' });
    }
  }

  // Point/centre – line/axis
  for (const [P, L] of [
    [A, lb],
    [B, la],
  ] as const) {
    const p = pointLike(P);
    if (p && L && !(la && lb)) {
      const r = distPointLine(p, L);
      rows.push({ label: P.type === 'point' ? 'Khoảng cách điểm–trục/cạnh' : 'Khoảng cách tâm–trục', value: r.d, unit: 'mm', primary: !rows.some((x) => x.primary) });
      if (!line) line = [p, r.foot];
    }
  }

  // Line/axis – plane
  for (const [L, PL] of [
    [la, pb],
    [lb, pa],
  ] as const) {
    if (L && PL && !(pa && pb)) {
      const c = Math.abs(dot(L.d, PL.n));
      if (c < PAR_TOL) {
        const sd = dot(sub(L.p, PL.p), PL.n);
        rows.push({ label: 'Khoảng cách trục/cạnh–mặt', value: Math.abs(sd), unit: 'mm', primary: !rows.some((x) => x.primary) });
        if (!line) line = [L.p, sub(L.p, scale(PL.n, sd))];
      } else rows.push({ label: 'Góc với mặt', value: 90 - angleBetween(L.d, PL.n, false), unit: 'deg' });
    }
  }

  const md = minDistance(A, B);
  rows.push({ label: 'Khoảng cách nhỏ nhất', value: md.d, unit: 'mm', primary: !rows.some((x) => x.primary) });
  if (!line) line = [md.pa, md.pb];
  if (A.type !== 'point' && B.type !== 'point') {
    // Totals like SolidWorks shows when two faces are selected.
    if (A.type === 'face' && B.type === 'face') rows.push({ label: 'Tổng diện tích', value: A.area + B.area, unit: 'mm2' });
    if (A.type === 'edge' && B.type === 'edge') rows.push({ label: 'Tổng chiều dài', value: A.length + B.length, unit: 'mm' });
  }
  return { rows, line, markers: markers.length ? markers : undefined };
}

/** Summary for three or more entities. */
export function measureMany(es: MEntity[]): MResult {
  const rows: MRow[] = [];
  const faces = es.filter((e) => e.type === 'face') as Extract<MEntity, { type: 'face' }>[];
  const edges = es.filter((e) => e.type === 'edge') as Extract<MEntity, { type: 'edge' }>[];
  rows.push({ label: 'Số đối tượng', value: String(es.length), unit: 'none' });
  if (faces.length) rows.push({ label: `Tổng diện tích (${faces.length} mặt)`, value: faces.reduce((s, f) => s + f.area, 0), unit: 'mm2', primary: true });
  if (edges.length) rows.push({ label: `Tổng chiều dài (${edges.length} cạnh)`, value: edges.reduce((s, f) => s + f.length, 0), unit: 'mm', primary: !faces.length });
  return { rows };
}
