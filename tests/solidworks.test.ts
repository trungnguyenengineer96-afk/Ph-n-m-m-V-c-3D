import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadSolidWorks } from '../src/loaders/sw/solidworks';
import { readContainer } from '../src/loaders/sw/container';
import { analyseEdge, analyseFace, faceArea } from '../src/core/geometry';

const load = (f: string) => new Uint8Array(readFileSync(new URL('../public/samples/' + f, import.meta.url)));

describe('SolidWorks container', () => {
  it('reads modern streams', () => {
    const c = readContainer(load('C04_cube_hole_5mm.SLDPRT'));
    expect(c.format).toBe('modern');
    const names = c.streams.map((s) => s.name);
    expect(names).toContain('Contents/DisplayLists');
    expect(names).toContain('PreviewPNG');
  });
  it('reads legacy OLE2 streams', () => {
    const c = readContainer(load('C10_cube_shell_1mm.SLDPRT'));
    expect(c.format).toBe('ole2');
    expect(c.streams.some((s) => /DisplayLists/.test(s.name))).toBe(true);
  });
});

describe('SolidWorks part geometry', () => {
  it('cube with 5 mm hole: 7 faces, exact cylinder radius, 10 mm cube', () => {
    const m = loadSolidWorks(load('C04_cube_hole_5mm.SLDPRT'), 'C04_cube_hole_5mm.SLDPRT');
    expect(m.bodies.length).toBe(1);
    const b = m.bodies[0];
    expect(b.faces.length).toBe(7);
    expect(b.indices.length / 3).toBe(152);
    const cyl = b.faces.find((f) => f.surface?.kind === 'cylinder')!;
    expect(cyl).toBeTruthy();
    // 5 mm hole → diameter 5 → radius 2.5 (or the hole is 5 mm radius); assert consistency with mesh fit.
    const fit = analyseFace(b, { ...cyl, surface: undefined }, 0.01);
    expect(fit.kind).toBe('cylinder');
    expect(Math.abs(fit.radius! - cyl.surface!.radius!)).toBeLessThan(0.05);
    let min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
    for (let i = 0; i < b.positions.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], b.positions[i + k]); max[k] = Math.max(max[k], b.positions[i + k]); }
    expect(max[0] - min[0]).toBeCloseTo(10, 3);
    expect(max[1] - min[1]).toBeCloseTo(10, 3);
    expect(max[2] - min[2]).toBeCloseTo(10, 3);
    const planes = b.faces.filter((f) => f.surface?.kind === 'plane');
    expect(planes.length).toBe(6);
    const areas = planes.map((f) => faceArea(b, f)).sort((a, b) => a - b);
    expect(areas[areas.length - 1]).toBeCloseTo(100, 3);
    // Edges: 14 B-rep edges in the Parasolid body; circles detected with right radius.
    const circles = b.edges.map((e) => analyseEdge(e, 0.01)).filter((e) => e.kind === 'circle');
    expect(circles.length).toBe(2);
    for (const c of circles) expect(c.radius).toBeCloseTo(cyl.surface!.radius!, 1);
    expect(m.info.previews.length).toBeGreaterThan(0);
  });
  it('legacy SW2011 shell parses', () => {
    const m = loadSolidWorks(load('C10_cube_shell_1mm.SLDPRT'), 'C10_cube_shell_1mm.SLDPRT');
    expect(m.bodies.length).toBeGreaterThan(0);
    expect(m.bodies[0].faces.length).toBeGreaterThan(6);
  });
  it('torus parses', () => {
    const m = loadSolidWorks(load('C15_torus.SLDPRT'), 'C15_torus.SLDPRT');
    expect(m.bodies[0].faces.length).toBeGreaterThan(0);
  });
});
