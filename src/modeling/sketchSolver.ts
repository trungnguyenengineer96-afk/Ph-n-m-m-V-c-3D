/**
 * Sketch constraint solving with planegcs (FreeCAD's 2D geometric constraint
 * solver compiled to WebAssembly).
 */
import { GcsWrapper, init_planegcs_module } from '@salusoft89/planegcs';
import type { SkConstraint, SkEntity, SketchData } from './types';

type Prim = Record<string, unknown> & { id: string; type: string };

interface Solver {
  wrapper: GcsWrapper;
  system: { dof: () => number };
}

let modulePromise: Promise<unknown> | null = null;
let wasmLocator: (() => string) | undefined;

/** In the browser the wasm URL must be provided (Vite asset URL). */
export function setPlanegcsWasmUrl(url: string) {
  wasmLocator = () => url;
}

async function getModule() {
  if (!modulePromise) modulePromise = init_planegcs_module(wasmLocator ? { locateFile: wasmLocator } : undefined);
  return modulePromise as Promise<{ GcsSystem: new () => unknown }>;
}

let solver: Solver | null = null;
export async function initSolver(): Promise<void> {
  if (solver) return;
  const mod = await getModule();
  const system = new mod.GcsSystem();
  solver = { wrapper: new GcsWrapper(system as never), system: system as { dof: () => number } };
}
export const solverReady = () => !!solver;

export interface SolveResult {
  ok: boolean;
  /** Remaining degrees of freedom (0 = fully defined). */
  dof: number;
  conflicting: string[];
  redundant: string[];
}

const DEG = Math.PI / 180;

function entityKind(sk: SketchData, id: string): SkEntity['type'] | 'point' | null {
  if (sk.points.some((p) => p.id === id)) return 'point';
  return sk.entities.find((e) => e.id === id)?.type ?? null;
}

/** Translate sketch constraints into planegcs primitives. */
export function toPrimitives(sk: SketchData, temp: Prim[] = []): Prim[] {
  const out: Prim[] = [];
  const fixed = new Set(sk.constraints.filter((c) => c.type === 'fix').map((c) => c.refs[0]));
  for (const p of sk.points) out.push({ id: p.id, type: 'point', x: p.x, y: p.y, fixed: !!p.fixed || fixed.has(p.id) });
  const pt = (id: string) => sk.points.find((p) => p.id === id)!;
  for (const e of sk.entities) {
    if (e.type === 'line') out.push({ id: e.id, type: 'line', p1_id: e.p1, p2_id: e.p2 });
    else if (e.type === 'circle') out.push({ id: e.id, type: 'circle', c_id: e.c, radius: e.r });
    else {
      const c = pt(e.c), a = pt(e.p1), b = pt(e.p2);
      let a1 = Math.atan2(a.y - c.y, a.x - c.x);
      let a2 = Math.atan2(b.y - c.y, b.x - c.x);
      while (a2 <= a1) a2 += 2 * Math.PI;
      out.push({ id: e.id, type: 'arc', c_id: e.c, start_id: e.p1, end_id: e.p2, radius: e.r, start_angle: a1, end_angle: a2 });
      out.push({ id: `${e.id}#rules`, type: 'arc_rules', a_id: e.id });
    }
  }
  const kind = (id: string) => entityKind(sk, id);
  // Constraints left pointing at deleted geometry are ignored.
  for (const c of sk.constraints) if (c.refs.every((r) => kind(r))) out.push(...constraintPrims(c, kind));
  return out.concat(temp);
}

function constraintPrims(c: SkConstraint, kind: (id: string) => string | null): Prim[] {
  const [a, b] = c.refs;
  const ka = kind(a), kb = b ? kind(b) : null;
  const id = c.id;
  switch (c.type) {
    case 'coincident':
      return [{ id, type: 'p2p_coincident', p1_id: a, p2_id: b }];
    case 'horizontal':
      return ka === 'line' ? [{ id, type: 'horizontal_l', l_id: a }] : [{ id, type: 'horizontal_pp', p1_id: a, p2_id: b }];
    case 'vertical':
      return ka === 'line' ? [{ id, type: 'vertical_l', l_id: a }] : [{ id, type: 'vertical_pp', p1_id: a, p2_id: b }];
    case 'parallel':
      return [{ id, type: 'parallel', l1_id: a, l2_id: b }];
    case 'perpendicular':
      return [{ id, type: 'perpendicular_ll', l1_id: a, l2_id: b }];
    case 'equal':
      if (ka === 'line' && kb === 'line') return [{ id, type: 'equal_length', l1_id: a, l2_id: b }];
      if (ka === 'circle' && kb === 'circle') return [{ id, type: 'equal_radius_cc', c1_id: a, c2_id: b }];
      if (ka === 'arc' && kb === 'arc') return [{ id, type: 'equal_radius_aa', a1_id: a, a2_id: b }];
      if (ka === 'circle' && kb === 'arc') return [{ id, type: 'equal_radius_ca', c1_id: a, a2_id: b }];
      if (ka === 'arc' && kb === 'circle') return [{ id, type: 'equal_radius_ca', c1_id: b, a2_id: a }];
      return [];
    case 'tangent': {
      const [l, cu] = ka === 'line' ? [a, b] : kb === 'line' ? [b, a] : [null, null];
      if (l && cu) return [{ id, type: kind(cu) === 'arc' ? 'tangent_la' : 'tangent_lc', l_id: l, [kind(cu) === 'arc' ? 'a_id' : 'c_id']: cu }];
      if (ka === 'circle' && kb === 'circle') return [{ id, type: 'tangent_cc', c1_id: a, c2_id: b }];
      if (ka === 'arc' && kb === 'arc') return [{ id, type: 'tangent_aa', a1_id: a, a2_id: b }];
      if (ka === 'circle' && kb === 'arc') return [{ id, type: 'tangent_ca', c_id: a, a_id: b }];
      if (ka === 'arc' && kb === 'circle') return [{ id, type: 'tangent_ca', c_id: b, a_id: a }];
      return [];
    }
    case 'fix':
      return []; // handled by fixing the point
    case 'onEntity':
      if (kb === 'line') return [{ id, type: 'point_on_line_pl', p_id: a, l_id: b }];
      if (kb === 'circle') return [{ id, type: 'point_on_circle', p_id: a, c_id: b }];
      if (kb === 'arc') return [{ id, type: 'point_on_arc', p_id: a, a_id: b }];
      return [];
    case 'midpoint':
      // p is the midpoint of line b: endpoints symmetric about p.
      return [{ id, type: 'p2p_symmetric_ppp', p1_id: `${b}.p1`, p2_id: `${b}.p2`, p_id: a }];
    case 'concentric':
      return [{ id, type: 'p2p_coincident', p1_id: `${a}.c`, p2_id: `${b}.c` }];
    case 'distance':
      if (ka === 'line' && !b) return [{ id, type: 'p2p_distance', p1_id: `${a}.p1`, p2_id: `${a}.p2`, distance: c.value }];
      if (ka === 'point' && kb === 'line') return [{ id, type: 'p2l_distance', p_id: a, l_id: b, distance: c.value }];
      if (ka === 'line' && kb === 'point') return [{ id, type: 'p2l_distance', p_id: b, l_id: a, distance: c.value }];
      if (ka === 'line' && kb === 'line') return [{ id, type: 'p2l_distance', p_id: `${a}.p1`, l_id: b, distance: c.value }];
      return [{ id, type: 'p2p_distance', p1_id: a, p2_id: b, distance: c.value }];
    case 'hdistance':
      return [{ id, type: 'difference', param1: { o_id: a, prop: 'x' }, param2: { o_id: b, prop: 'x' }, difference: c.value }];
    case 'vdistance':
      return [{ id, type: 'difference', param1: { o_id: a, prop: 'y' }, param2: { o_id: b, prop: 'y' }, difference: c.value }];
    case 'radius':
      return [{ id, type: ka === 'arc' ? 'arc_radius' : 'circle_radius', [ka === 'arc' ? 'a_id' : 'c_id']: a, radius: c.value }];
    case 'diameter':
      return [{ id, type: ka === 'arc' ? 'arc_diameter' : 'circle_diameter', [ka === 'arc' ? 'a_id' : 'c_id']: a, diameter: c.value }];
    case 'angle':
      return [{ id, type: 'l2l_angle_ll', l1_id: a, l2_id: b, angle: (c.value ?? 0) * DEG }];
  }
}

/** Resolve "line.p1" style references to real point ids. */
function resolveRefs(sk: SketchData, prims: Prim[]): Prim[] {
  const ent = new Map(sk.entities.map((e) => [e.id, e]));
  const res = (v: unknown) => {
    if (typeof v !== 'string' || !v.includes('.')) return v;
    const [eid, key] = v.split('.');
    const e = ent.get(eid) as Record<string, unknown> | undefined;
    return e && typeof e[key] === 'string' ? e[key] : v;
  };
  return prims.map((p) => {
    const q: Prim = { ...p };
    for (const k of Object.keys(q)) if (k.endsWith('_id') && k !== 'id') q[k] = res(q[k]);
    return q;
  });
}

/**
 * Solve the sketch in place. Temporary primitives (e.g. dragged point
 * position) are added with low priority. On failure the sketch is unchanged.
 */
export function solveSketch(sk: SketchData, temp: Prim[] = []): SolveResult {
  if (!solver) throw new Error('Bộ giải phác thảo chưa khởi tạo');
  const w = solver.wrapper;
  w.clear_data();
  const prims = resolveRefs(sk, toPrimitives(sk, temp));
  w.push_primitives_and_params(prims as never);
  const status = w.solve();
  const conflicting = w.get_gcs_conflicting_constraints();
  const redundant = w.get_gcs_redundant_constraints();
  const ok = (status === 0 || status === 1) && !conflicting.length;
  if (ok) {
    w.apply_solution();
    const solved = new Map((w.sketch_index.get_primitives() as unknown as Prim[]).map((p) => [p.id, p]));
    for (const p of sk.points) {
      const s = solved.get(p.id);
      if (s) {
        p.x = s.x as number;
        p.y = s.y as number;
      }
    }
    for (const e of sk.entities) {
      const s = solved.get(e.id);
      if (s && (e.type === 'circle' || e.type === 'arc')) e.r = s.radius as number;
    }
  }
  let dof = -1;
  try {
    dof = solver.system.dof();
  } catch {
    /* not available */
  }
  return { ok, dof, conflicting, redundant };
}
