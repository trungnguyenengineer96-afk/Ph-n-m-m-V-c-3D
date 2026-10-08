import { describe, it, expect, beforeAll } from 'vitest';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { initSolver, solveSketch } from '../src/modeling/sketchSolver';
import { findProfiles } from '../src/modeling/profiles';
import { regenerate, shapeToBody } from '../src/modeling/kernel';
import { emptySketch, STD_PLANES, type Feature, type SketchData } from '../src/modeling/types';
import { massProperties } from '../src/core/mass';
import { analyseEdge, analyseFace } from '../src/core/geometry';

beforeAll(async () => {
  setOC(await (opencascade as unknown as () => Promise<never>)());
  await initSolver();
}, 30000);

/** Rectangle w×h with lower-left at the origin, plus optional hole. */
function rectSketch(w: number, h: number, hole?: { x: number; y: number; r: number }): SketchData {
  const sk = emptySketch();
  sk.points.push({ id: 'a', x: 0, y: 0 }, { id: 'b', x: w * 0.9, y: 0.3 }, { id: 'c', x: w, y: h * 1.1 }, { id: 'd', x: 0.2, y: h });
  sk.entities.push(
    { id: 'l1', type: 'line', p1: 'a', p2: 'b' },
    { id: 'l2', type: 'line', p1: 'b', p2: 'c' },
    { id: 'l3', type: 'line', p1: 'c', p2: 'd' },
    { id: 'l4', type: 'line', p1: 'd', p2: 'a' },
  );
  sk.constraints.push(
    { id: 'k1', type: 'coincident', refs: ['a', 'O'] },
    { id: 'k2', type: 'horizontal', refs: ['l1'] },
    { id: 'k3', type: 'vertical', refs: ['l2'] },
    { id: 'k4', type: 'horizontal', refs: ['l3'] },
    { id: 'k5', type: 'vertical', refs: ['l4'] },
    { id: 'k6', type: 'distance', refs: ['l1'], value: w },
    { id: 'k7', type: 'distance', refs: ['l2'], value: h },
  );
  if (hole) {
    sk.points.push({ id: 'hc', x: hole.x + 1, y: hole.y - 1 });
    sk.entities.push({ id: 'c1', type: 'circle', c: 'hc', r: hole.r * 1.3 });
    sk.constraints.push(
      { id: 'k8', type: 'diameter', refs: ['c1'], value: hole.r * 2 },
      { id: 'k9', type: 'hdistance', refs: ['O', 'hc'], value: hole.x },
      { id: 'k10', type: 'vdistance', refs: ['O', 'hc'], value: hole.y },
    );
  }
  return sk;
}

describe('sketch solver', () => {
  it('solves a fully defined rectangle with a hole', () => {
    const sk = rectSketch(40, 20, { x: 20, y: 10, r: 4 });
    const r = solveSketch(sk);
    expect(r.ok).toBe(true);
    const p = (id: string) => sk.points.find((q) => q.id === id)!;
    expect(p('a').x).toBeCloseTo(0, 6);
    expect(p('c').x).toBeCloseTo(40, 6);
    expect(p('c').y).toBeCloseTo(20, 6);
    expect(p('hc').x).toBeCloseTo(20, 6);
    expect(p('hc').y).toBeCloseTo(10, 6);
    expect((sk.entities.find((e) => e.id === 'c1') as { r: number }).r).toBeCloseTo(4, 6);
    expect(r.dof).toBe(0);
  });
  it('reports remaining degrees of freedom', () => {
    const sk = rectSketch(40, 20);
    sk.constraints = sk.constraints.filter((c) => c.id !== 'k7');
    const r = solveSketch(sk);
    expect(r.ok).toBe(true);
    expect(r.dof).toBe(1);
  });
  it('detects conflicting dimensions without changing the sketch', () => {
    const sk = rectSketch(40, 20);
    solveSketch(sk);
    const before = JSON.stringify(sk.points);
    sk.constraints.push({ id: 'bad', type: 'distance', refs: ['a', 'b'], value: 55 });
    const r = solveSketch(sk);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(sk.points)).toBe(before);
  });
});

describe('profiles', () => {
  it('finds outer loop with a hole', () => {
    const sk = rectSketch(40, 20, { x: 20, y: 10, r: 4 });
    solveSketch(sk);
    const p = findProfiles(sk);
    expect(p.errors).toEqual([]);
    expect(p.regions.length).toBe(1);
    expect(p.regions[0].holes.length).toBe(1);
  });
  it('reports open profiles', () => {
    const sk = rectSketch(40, 20);
    sk.entities = sk.entities.filter((e) => e.id !== 'l4');
    solveSketch(sk);
    const p = findProfiles(sk);
    expect(p.regions.length).toBe(0);
    expect(p.errors.length).toBeGreaterThan(0);
  });
});

describe('feature regeneration', () => {
  const base = (): Feature[] => {
    const sk = rectSketch(40, 20, { x: 20, y: 10, r: 4 });
    solveSketch(sk);
    return [
      { id: 's1', type: 'sketch', name: 'Sketch1', plane: STD_PLANES.front, sketch: sk },
      { id: 'e1', type: 'extrude', name: 'Boss-Extrude1', sketchId: 's1', cut: false, end: 'blind', depth: 10, reverse: false },
    ];
  };
  it('extrudes a plate with a hole (volume, faces, exact geometry)', () => {
    const r = regenerate(base());
    expect(r.status.every((s) => s.ok)).toBe(true);
    const body = shapeToBody(r.shape!, 'p');
    const mp = massProperties([body]);
    expect(mp.volume).toBeCloseTo(40 * 20 * 10 - Math.PI * 16 * 10, -1);
    expect(mp.bboxMax[2]).toBeCloseTo(10, 4);
    // OpenCascade may split the periodic hole surface at its seam.
    expect(body.faces.length).toBeGreaterThanOrEqual(7);
    const cyl = body.faces.map((f) => analyseFace(body, f, 0.01)).find((s) => s.kind === 'cylinder');
    expect(cyl?.radius).toBeCloseTo(4, 1);
    const circles = body.edges.map((e) => analyseEdge(e, 0.01)).filter((e) => e.kind === 'circle');
    expect(circles.length).toBe(2);
  });
  it('cuts, fillets, shells and revolves', () => {
    const f = base();
    // Cut-extrude a 10x10 square through all from the top face plane.
    const cut = emptySketch();
    cut.points.push({ id: 'a', x: 0, y: 0 }, { id: 'b', x: 10, y: 0 }, { id: 'c', x: 10, y: 10 }, { id: 'd', x: 0, y: 10 });
    cut.entities.push(
      { id: 'l1', type: 'line', p1: 'a', p2: 'b' },
      { id: 'l2', type: 'line', p1: 'b', p2: 'c' },
      { id: 'l3', type: 'line', p1: 'c', p2: 'd' },
      { id: 'l4', type: 'line', p1: 'd', p2: 'a' },
    );
    f.push({ id: 's2', type: 'sketch', name: 'Sketch2', plane: { ...STD_PLANES.front, origin: [0, 0, 10] }, sketch: cut });
    f.push({ id: 'e2', type: 'extrude', name: 'Cut-Extrude1', sketchId: 's2', cut: true, end: 'blind', depth: 4, reverse: false });
    let r = regenerate(f);
    expect(r.status.every((s) => s.ok)).toBe(true);
    let mp = massProperties([shapeToBody(r.shape!, 'p')]);
    expect(mp.volume).toBeCloseTo(40 * 20 * 10 - Math.PI * 160 - 10 * 10 * 4, -1);

    f.push({ id: 'f1', type: 'fillet', name: 'Fillet1', size: 2, edges: [[40, 10.000001, 10.000002]] });
    const volBefore = massProperties([shapeToBody(r.shape!, 'p', 0.002, 0.05)]).volume;
    r = regenerate(f);
    expect(r.status.at(-1)).toEqual({ id: 'f1', ok: true });
    // A 2 mm fillet on one 20 mm edge removes (1 - π/4)·2²·20 mm³.
    const volFillet = massProperties([shapeToBody(r.shape!, 'p', 0.002, 0.05)]).volume;
    expect(volBefore - volFillet).toBeCloseTo((1 - Math.PI / 4) * 4 * 20, 0);

    f.push({ id: 'sh', type: 'shell', name: 'Shell1', thickness: 1, faces: [[30, 10, 0]] });
    r = regenerate(f);
    expect(r.status.at(-1)?.ok).toBe(true);

    // Revolve a rectangle around a centerline on the Front plane → tube.
    const rv = emptySketch();
    rv.points.push({ id: 'a', x: 5, y: 0 }, { id: 'b', x: 8, y: 0 }, { id: 'c', x: 8, y: 30 }, { id: 'd', x: 5, y: 30 }, { id: 'ax1', x: 0, y: 0 }, { id: 'ax2', x: 0, y: 30 });
    rv.entities.push(
      { id: 'l1', type: 'line', p1: 'a', p2: 'b' },
      { id: 'l2', type: 'line', p1: 'b', p2: 'c' },
      { id: 'l3', type: 'line', p1: 'c', p2: 'd' },
      { id: 'l4', type: 'line', p1: 'd', p2: 'a' },
      { id: 'ax', type: 'line', p1: 'ax1', p2: 'ax2', construction: true },
    );
    const tube = regenerate([
      { id: 's', type: 'sketch', name: 'S', plane: STD_PLANES.front, sketch: rv },
      { id: 'r', type: 'revolve', name: 'Revolve1', sketchId: 's', cut: false, angle: 360 },
    ]);
    expect(tube.status.every((s) => s.ok)).toBe(true);
    mp = massProperties([shapeToBody(tube.shape!, 't', 0.005, 0.05)]);
    expect(mp.volume / (Math.PI * (64 - 25) * 30)).toBeCloseTo(1, 2);
    // Only the four circles are drawn; the cylinder seam lines are hidden.
    const tb = shapeToBody(tube.shape!, 't');
    const kinds = tb.edges.map((e) => analyseEdge(e, 0.01).kind);
    expect(kinds.filter((k) => k === 'circle').length).toBe(4);
    expect(kinds.filter((k) => k === 'line').length).toBe(0);
  });
  it('reports failing features and keeps the previous shape', () => {
    const f = base();
    f.push({ id: 'bad', type: 'fillet', name: 'Fillet1', size: 50, edges: [[40, 10, 10]] });
    const r = regenerate(f);
    expect(r.status.find((s) => s.id === 'bad')?.ok).toBe(false);
    expect(r.shape).not.toBeNull();
  });
});
