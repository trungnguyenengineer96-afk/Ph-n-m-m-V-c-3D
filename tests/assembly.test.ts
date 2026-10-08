import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mergeAssemblyReferences } from '../src/app/assemblyLink';
import { loadSolidWorks } from '../src/loaders/sw/solidworks';
import type { LoadedModel } from '../src/core/types';

const part = (f: string) => loadSolidWorks(new Uint8Array(readFileSync(new URL('../public/samples/' + f, import.meta.url))), f);

function fakeAssembly(refs: string[]): LoadedModel {
  return {
    kind: 'assembly',
    name: 'ASM',
    bodies: [],
    root: { name: 'ASM', bodies: [], children: refs.map((r) => ({ name: r, bodies: [], children: [], missing: true })) },
    info: { format: 'SolidWorks Assembly', fileName: 'ASM.SLDASM', fileSize: 0, properties: {}, previews: [], references: refs, warnings: ['Tệp lắp ráp SolidWorks chỉ lưu tham chiếu…'] },
    sheets: [],
  };
}

describe('assembly linking', () => {
  it('grafts referenced parts opened together', () => {
    const asm = fakeAssembly(['C04_cube_hole_5mm.SLDPRT', 'C15_torus.SLDPRT', 'missing_part.SLDPRT']);
    const a = part('C04_cube_hole_5mm.SLDPRT');
    const b = part('C15_torus.SLDPRT');
    const consumed = mergeAssemblyReferences([asm, a, b]);
    expect(consumed.has(a) && consumed.has(b)).toBe(true);
    expect(asm.bodies.length).toBe(a.bodies.length + b.bodies.length);
    const [c1, c2, c3] = asm.root.children;
    expect(c1.missing).toBeFalsy();
    expect(c1.bodies).toEqual([0]);
    expect(c2.bodies).toEqual([a.bodies.length]);
    expect(c3.missing).toBe(true);
    expect(asm.sheets).toBeUndefined();
    expect(asm.info.warnings.some((w) => w.includes('còn thiếu 1'))).toBe(true);
  });
  it('matches STEP exports by base name', () => {
    const asm = fakeAssembly(['C04_cube_hole_5mm.SLDPRT']);
    const stepLike = part('C04_cube_hole_5mm.SLDPRT');
    stepLike.info.fileName = 'C04_cube_hole_5mm.step';
    expect(mergeAssemblyReferences([asm, stepLike]).has(stepLike)).toBe(true);
  });
});
