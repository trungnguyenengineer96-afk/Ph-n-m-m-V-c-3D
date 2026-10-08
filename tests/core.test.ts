import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { massProperties } from '../src/core/mass';
import { describe as describeEntity, measurePair, minDistance, type MEntity } from '../src/core/measure';
import { analyseEdge, analyseFace, chainSegments, fitCircle2D } from '../src/core/geometry';
import { loadDxf } from '../src/loaders/dxf';
import { bodyFromRaw, fromOcct, type OcctResult } from '../src/loaders/convert';
import { loadSolidWorks } from '../src/loaders/sw/solidworks';

const sample = (f: string) => new URL('../public/samples/' + f, import.meta.url);

/** Axis-aligned box as an indexed, outward-oriented triangle mesh. */
function box(sx: number, sy: number, sz: number) {
  const p = [0, 0, 0, sx, 0, 0, sx, sy, 0, 0, sy, 0, 0, 0, sz, sx, 0, sz, sx, sy, sz, 0, sy, sz];
  const i = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { positions: new Float32Array(p), indices: new Uint32Array(i) };
}

describe('mass properties', () => {
  it('box 10×20×30', () => {
    const b = box(10, 20, 30);
    const mp = massProperties([b]);
    expect(mp.volume).toBeCloseTo(6000, 6);
    expect(mp.area).toBeCloseTo(2 * (200 + 300 + 600), 6);
    expect(mp.centroid[0]).toBeCloseTo(5, 6);
    expect(mp.centroid[1]).toBeCloseTo(10, 6);
    expect(mp.centroid[2]).toBeCloseTo(15, 6);
    // Ixx = V (b² + c²)/12 for unit density
    expect(mp.inertia[0]).toBeCloseTo((6000 * (400 + 900)) / 12, 3);
    expect(mp.inertia[4]).toBeCloseTo((6000 * (100 + 900)) / 12, 3);
    expect(mp.inertia[8]).toBeCloseTo((6000 * (100 + 400)) / 12, 3);
    expect(Math.abs(mp.inertia[1])).toBeLessThan(1e-6);
    expect(mp.closedHint).toBe(true);
  });
  it('honours world matrix and inward orientation', () => {
    const b = box(10, 10, 10);
    const flipped = { positions: b.positions, indices: b.indices.slice().reverse() };
    const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 0, 0, 1];
    const mp = massProperties([{ ...flipped, matrix: m }]);
    expect(mp.volume).toBeCloseTo(1000, 6);
    expect(mp.centroid[0]).toBeCloseTo(105, 6);
  });
});

describe('geometry fitting', () => {
  it('circle fit', () => {
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI;
      xs.push(3 + 7 * Math.cos(a));
      ys.push(-2 + 7 * Math.sin(a));
    }
    const c = fitCircle2D(xs, ys)!;
    expect(c.cx).toBeCloseTo(3, 9);
    expect(c.cy).toBeCloseTo(-2, 9);
    expect(c.r).toBeCloseTo(7, 9);
  });
  it('chains segments into polylines', () => {
    const seg = [0, 0, 0, 1, 0, 0, 1, 0, 0, 2, 0, 0, 2, 0, 0, 3, 1, 0];
    const c = chainSegments(seg);
    expect(c.length).toBe(1);
    expect(c[0].points.length / 3).toBe(4);
    expect(c[0].closed).toBe(false);
    const sq = [0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0];
    const c2 = chainSegments(sq);
    expect(c2.length).toBe(1);
    expect(c2[0].closed).toBe(true);
    expect(c2[0].points.length / 3).toBe(4);
  });
});

describe('measure', () => {
  const plane = (z: number, n: [number, number, number]): MEntity => ({
    type: 'face',
    label: 'p',
    surface: { kind: 'plane', axis: n, origin: [0, 0, z] },
    area: 100,
    points: [[0, 0, z], [10, 0, z], [0, 10, z]],
    triangles: new Float32Array([0, 0, z, 10, 0, z, 0, 10, z]),
  });
  it('parallel planes', () => {
    const r = measurePair(plane(0, [0, 0, -1]), plane(25, [0, 0, 1]));
    const p = r.rows.find((x) => x.primary)!;
    expect(p.value).toBeCloseTo(25, 9);
  });
  it('point to point', () => {
    const r = measurePair({ type: 'point', p: [0, 0, 0], label: '' }, { type: 'point', p: [3, 4, 12], label: '' });
    expect(r.rows[0].value).toBeCloseTo(13, 9);
  });
  it('angle between non-parallel planes', () => {
    const a = plane(0, [0, 0, 1]);
    const b: MEntity = { ...(plane(0, [1, 0, 0]) as Extract<MEntity, { type: 'face' }>), surface: { kind: 'plane', axis: [Math.SQRT1_2, 0, Math.SQRT1_2], origin: [0, 0, 0] } };
    const r = measurePair(a, b);
    expect(r.rows.find((x) => x.label === 'Góc')!.value).toBeCloseTo(45, 6);
  });
  it('circle centre distance', () => {
    const circ = (x: number): MEntity => ({ type: 'edge', label: '', kind: 'circle', length: 2 * Math.PI, points: [[x + 1, 0, 0], [x, 1, 0], [x - 1, 0, 0], [x, -1, 0]], center: [x, 0, 0], radius: 1 });
    const r = measurePair(circ(0), circ(50));
    expect(r.rows.find((x) => x.label === 'Khoảng cách tâm–tâm')!.value).toBeCloseTo(50, 9);
    expect(describeEntity(circ(0)).rows.find((x) => x.label === 'Đường kính')!.value).toBeCloseTo(2, 9);
  });
  it('min distance point to triangle', () => {
    const d = minDistance({ type: 'point', p: [2, 2, 5], label: '' }, plane(0, [0, 0, 1]));
    expect(d.d).toBeCloseTo(5, 9);
  });
});

describe('DXF', () => {
  it('reads the demo flange', () => {
    const text = readFileSync(sample('demo_flange.dxf'), 'utf8');
    const m = loadDxf(text, 'demo_flange.dxf', text.length);
    const b = m.bodies[0];
    expect(m.is2D).toBe(true);
    const circles = b.edges.filter((e) => e.kind === 'circle');
    expect(circles.length).toBe(10);
    expect(circles.some((c) => Math.abs(c.radius! - 80) < 1e-9)).toBe(true);
    expect(b.texts!.some((t) => t.text.includes('Ø160'))).toBe(true);
    const arc = b.edges.find((e) => e.kind === 'arc')!;
    expect(arc.length).toBeCloseTo((3 * Math.PI) / 2, 6);
  });
});

describe('plain meshes', () => {
  it('box splits into 6 planar faces with 12 edges', () => {
    const b = box(10, 20, 30);
    const body = bodyFromRaw({ name: 'b', positions: b.positions, indices: b.indices });
    expect(body.faces.length).toBe(6);
    const edges = body.edges.map((e) => analyseEdge(e, 1e-4));
    // Region boundaries chain at box corners (degree-3 nodes) → 12 straight edges.
    expect(edges.length).toBe(12);
    expect(edges.every((e) => e.kind === 'line')).toBe(true);
    for (const f of body.faces) expect(analyseFace(body, f, 1e-4).kind).toBe('plane');
  });
});

describe('STEP via OpenCascade', async () => {
  const require = createRequire(import.meta.url);
  const occtimportjs = require('occt-import-js');
  const occt = await occtimportjs();
  const read = (f: string): OcctResult => {
    const r = occt.ReadStepFile(new Uint8Array(readFileSync(sample(f))), null);
    for (const m of r.meshes) {
      m.attributes.position.array = new Float32Array(m.attributes.position.array);
      if (m.attributes.normal) m.attributes.normal.array = new Float32Array(m.attributes.normal.array);
      m.index.array = new Uint32Array(m.index.array);
    }
    return r;
  };
  it('assembly tree and edges', () => {
    const m = fromOcct(read('as1_pe_203_assembly.stp'), 'as1.stp', 'STEP', 1);
    expect(m.kind).toBe('assembly');
    expect(m.root.children.length).toBe(4);
    expect(m.root.children[1].children.length).toBe(7);
    expect(m.bodies.length).toBe(18);
    expect(m.bodies.every((b) => b.edges.length > 0)).toBe(true);
  });
  it('STEP and SLDPRT of the same part agree', () => {
    const step = fromOcct(read('C04_cube_hole_5mm.step'), 'c.step', 'STEP', 1).bodies[0];
    const sw = loadSolidWorks(new Uint8Array(readFileSync(sample('C04_cube_hole_5mm.SLDPRT'))), 'c.SLDPRT').bodies[0];
    // SolidWorks' STEP export splits the periodic hole cylinder into two halves.
    expect(step.faces.length).toBe(sw.faces.length + 1);
    const swR = sw.faces.find((f) => f.surface?.kind === 'cylinder')!.surface!.radius!;
    const cyl = step.faces.map((f) => analyseFace(step, f, 0.001)).find((s) => s.kind === 'cylinder')!;
    expect(cyl.radius!).toBeCloseTo(swR, 2);
    const circles = step.edges.map((e) => analyseEdge(e, 0.001)).filter((e) => e.kind === 'circle');
    expect(circles.length).toBe(2);
    const mpStep = massProperties([step]), mpSw = massProperties([sw]);
    expect(Math.abs(mpStep.volume - mpSw.volume) / mpSw.volume).toBeLessThan(0.01);
  });
});
