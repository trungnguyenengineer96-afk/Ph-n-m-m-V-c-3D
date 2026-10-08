/**
 * Closed profile detection: turns sketch geometry into regions (outer loop +
 * holes) that can be extruded or revolved. Construction geometry is ignored.
 */
import type { SkEntity, SketchData } from './types';

export type Seg =
  | { kind: 'line'; a: [number, number]; b: [number, number] }
  | { kind: 'arc'; a: [number, number]; b: [number, number]; c: [number, number]; r: number; mid: [number, number] };

export interface Loop {
  /** Segments in traversal order; a closed circle has a single 'circle' entry. */
  segs: Seg[];
  circle?: { c: [number, number]; r: number };
  /** Polygon approximation (for containment tests and area). */
  poly: [number, number][];
  area: number; // signed
}

export interface Region {
  outer: Loop;
  holes: Loop[];
}

export interface ProfileResult {
  regions: Region[];
  errors: string[];
}

const TOL = 1e-6;

function polyArea(p: [number, number][]) {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function pointInPoly(pt: [number, number], poly: [number, number][]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function arcPoints(c: [number, number], r: number, from: [number, number], to: [number, number], ccw: boolean, n = 24): [number, number][] {
  let a1 = Math.atan2(from[1] - c[1], from[0] - c[0]);
  let a2 = Math.atan2(to[1] - c[1], to[0] - c[0]);
  if (ccw) while (a2 <= a1) a2 += 2 * Math.PI;
  else while (a2 >= a1) a2 -= 2 * Math.PI;
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const t = a1 + ((a2 - a1) * i) / n;
    out.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
  }
  return out;
}

export function findProfiles(sk: SketchData): ProfileResult {
  const pts = new Map(sk.points.map((p) => [p.id, p]));
  const errors: string[] = [];
  const loops: Loop[] = [];
  // Points made coincident by constraints (or by position) are merged.
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let r = id;
    while (parent.has(r)) r = parent.get(r)!;
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const c of sk.constraints) if (c.type === 'coincident') union(c.refs[0], c.refs[1]);
  const solid = sk.entities.filter((e) => !e.construction);
  const endIds = new Set<string>();
  for (const e of solid) if (e.type !== 'circle') endIds.add(e.p1).add(e.p2);
  const ends = [...endIds];
  for (let i = 0; i < ends.length; i++)
    for (let j = i + 1; j < ends.length; j++) {
      const a = pts.get(ends[i])!, b = pts.get(ends[j])!;
      if (Math.hypot(a.x - b.x, a.y - b.y) < TOL) union(ends[i], ends[j]);
    }

  // Circles are loops on their own.
  for (const e of solid) {
    if (e.type !== 'circle') continue;
    const c = pts.get(e.c)!;
    const poly = arcPoints([c.x, c.y], e.r, [c.x + e.r, c.y], [c.x + e.r, c.y], true, 48);
    loops.push({ segs: [], circle: { c: [c.x, c.y], r: e.r }, poly, area: Math.PI * e.r * e.r });
  }

  // Graph of lines/arcs between merged end nodes.
  const edges = solid.filter((e) => e.type !== 'circle') as Exclude<SkEntity, { type: 'circle' }>[];
  const adj = new Map<string, number[]>();
  edges.forEach((e, i) => {
    for (const n of [find(e.p1), find(e.p2)]) {
      if (!adj.has(n)) adj.set(n, []);
      adj.get(n)!.push(i);
    }
  });
  for (const [n, l] of adj) {
    if (l.length !== 2) {
      const p = pts.get(n)!;
      errors.push(l.length === 1 ? `Biên dạng hở tại (${p.x.toFixed(2)}, ${p.y.toFixed(2)})` : `Biên dạng có nhánh tại (${p.x.toFixed(2)}, ${p.y.toFixed(2)})`);
    }
  }
  const used = new Uint8Array(edges.length);
  for (let start = 0; start < edges.length; start++) {
    if (used[start]) continue;
    // Walk the loop if every node on it has degree 2.
    const order: { i: number; forward: boolean }[] = [];
    let ok = true;
    let node = find(edges[start].p1);
    const first = node;
    let cur = start;
    for (let guard = 0; guard < edges.length + 1; guard++) {
      used[cur] = 1;
      const e = edges[cur];
      const forward = find(e.p1) === node;
      order.push({ i: cur, forward });
      node = forward ? find(e.p2) : find(e.p1);
      if (node === first) break;
      const nxt = (adj.get(node) ?? []).filter((k) => k !== cur);
      if (nxt.length !== 1 || used[nxt[0]]) {
        ok = false;
        break;
      }
      cur = nxt[0];
    }
    if (!ok || node !== first) continue;
    const segs: Seg[] = [];
    const poly: [number, number][] = [];
    for (const { i, forward } of order) {
      const e = edges[i];
      const p1 = pts.get(e.p1)!, p2 = pts.get(e.p2)!;
      const a: [number, number] = forward ? [p1.x, p1.y] : [p2.x, p2.y];
      const b: [number, number] = forward ? [p2.x, p2.y] : [p1.x, p1.y];
      if (e.type === 'line') {
        segs.push({ kind: 'line', a, b });
        poly.push(a);
      } else {
        const c = pts.get(e.c)!;
        const cc: [number, number] = [c.x, c.y];
        // Arc is CCW from p1 to p2; traversed backwards it is clockwise.
        const ap = arcPoints(cc, e.r, a, b, forward, 24);
        const mid = arcPoints(cc, e.r, a, b, forward, 2)[1];
        segs.push({ kind: 'arc', a, b, c: cc, r: e.r, mid });
        poly.push(...ap);
      }
    }
    loops.push({ segs, poly, area: polyArea(poly) });
  }

  // Nesting: a loop's depth is the number of loops containing it.
  const depth = loops.map((l, i) => {
    const probe = l.poly[0];
    return loops.filter((o, j) => j !== i && Math.abs(o.area) > Math.abs(l.area) && pointInPoly(probe, o.poly)).length;
  });
  const regions: Region[] = [];
  loops.forEach((l, i) => {
    if (depth[i] % 2 !== 0) return;
    const holes = loops.filter((h, j) => depth[j] === depth[i] + 1 && Math.abs(h.area) < Math.abs(l.area) && pointInPoly(h.poly[0], l.poly));
    regions.push({ outer: l, holes });
  });
  return { regions, errors: [...new Set(errors)] };
}
