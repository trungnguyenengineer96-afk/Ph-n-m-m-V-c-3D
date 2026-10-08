import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mergeAssemblyReferences } from '../src/app/assemblyLink';
import { loadSolidWorks } from '../src/loaders/sw/solidworks';
import type { LoadedModel } from '../src/core/types';
import { buildAssembly, parseCompInstanceTree, parseTessDirectory } from '../src/loaders/sw/assembly';
import { readContainer } from '../src/loaders/sw/container';
import type { SwStream } from '../src/loaders/sw/container';

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
    expect(c1.linked).toBe(true);
  });
  it('matches STEP exports by base name', () => {
    const asm = fakeAssembly(['C04_cube_hole_5mm.SLDPRT']);
    const stepLike = part('C04_cube_hole_5mm.SLDPRT');
    stepLike.info.fileName = 'C04_cube_hole_5mm.step';
    expect(mergeAssemblyReferences([asm, stepLike]).has(stepLike)).toBe(true);
  });
});

// ---- SLDASM structure decoding on a synthetic assembly built from a sample part ----

function cstr(s: string): number[] {
  const out = [0xff, 0xfe, 0xff, s.length];
  for (const ch of s) out.push(ch.charCodeAt(0) & 0xff, ch.charCodeAt(0) >> 8);
  return out;
}
const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
const ID_A = [1, 2, 3, 4, 5, 6, 7, 8];
const ID_B = [9, 9, 9, 9, 9, 9, 9, 9];

function syntheticAssembly(): SwStream[] {
  const xml = `<?xml version="1.0"?><swSolidWorks><swHeader>
    <swFile id="3" swDocType="ASSEMBLY" swPath="C:\\x\\Top.SLDASM"/><swFile id="6" swDocType="PART" swPath="C:\\x\\Cube.SLDPRT"/></swHeader>
    <swModelList><swModel id="5" swName="Cube" swConfigurationName="Default" swFileRef="6"/>
    <swModel id="2" swName="Top" swConfigurationName="Default" swFileRef="3" swBoundingBox="0 0 0 0.11 0.01 0.01">
      <swReference id="4" swName="Cube" swReferenceNumber="1" swModelRef="5" swConfigurationName="Default" swSuppressed="NO" swTransform="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
      <swReference id="7" swName="Cube" swReferenceNumber="2" swModelRef="5" swConfigurationName="Default" swSuppressed="NO" swTransform="0 1 0 0 -1 0 0 0 0 0 1 0 0.1 0 0 1"/>
      <swReference id="8" swName="Gone" swReferenceNumber="1" swModelRef="5" swConfigurationName="Default" swSuppressed="YES" swTransform="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
    </swModel></swModelList>
    <swConfigurationList><swConfiguration id="1" swName="Default" swModelRef="2" swMostRecentConfiguration="YES"/></swConfigurationList></swSolidWorks>`;
  const dir = [
    ...u32(2), ...u32(2), ...u32(2), ...u32(1),
    ...cstr('Cube-1@Top'), ...u32(167), ...Array(16).fill(0), ...ID_A, ...cstr('000-000-001'), ...u32(0), ...u32(1), ...u32(0x66), ...u32(0x94), ...u32(7), ...u32(2),
    ...cstr('Cube-2@Top'), ...u32(167), ...Array(8).fill(0), ...ID_A, ...ID_B, ...cstr(''), ...u32(0xffffffff), ...u32(1), ...u32(0x66), ...u32(0x94), ...u32(7), ...u32(3),
  ];
  const part = readContainer(new Uint8Array(readFileSync(new URL('../public/samples/C04_cube_hole_5mm.SLDPRT', import.meta.url))));
  const dl = part.streams.find((s) => s.name === 'Contents/DisplayLists')!.data;
  const tess = new Uint8Array(12 + dl.length);
  tess.set([...u32(0), ...ID_A]);
  tess.set(dl, 12);
  return [
    { name: 'swXmlContents/COMPINSTANCETREE', data: new TextEncoder().encode(xml) },
    { name: 'FaceTessellations/Directory', data: new Uint8Array(dir) },
    { name: 'FaceTessellations/000-000-001', data: tess },
  ];
}

describe('SLDASM decoding', () => {
  it('parses the component instance tree', () => {
    const t = parseCompInstanceTree(new TextDecoder().decode(syntheticAssembly()[0].data));
    expect(t.configs[0]).toMatchObject({ name: 'Default', modelRef: '2', active: true });
    const top = t.models.get('2')!;
    expect(top.refs.length).toBe(3);
    expect(top.refs[1].transform![12]).toBeCloseTo(0.1, 12);
    expect(top.refs[2].suppressed).toBe(true);
  });
  it('parses the tessellation directory, including shared instances', () => {
    const d = parseTessDirectory(syntheticAssembly()[1].data);
    expect(d).toEqual([
      { path: 'Cube-1@Top', blockId: '0102030405060708', stream: '000-000-001', blockIndex: 0 },
      { path: 'Cube-2@Top', blockId: '0102030405060708', stream: '', blockIndex: -1 },
    ]);
  });
  it('builds placed components that share cached geometry', () => {
    const a = buildAssembly(syntheticAssembly(), 'Top')!;
    expect(a.root.children.length).toBe(2); // suppressed component skipped
    expect(a.bodies.length).toBe(1);
    const [c1, c2] = a.root.children;
    expect(c1.bodies).toEqual([0]);
    expect(c2.bodies).toEqual([0]);
    expect(c2.matrix![12]).toBeCloseTo(100, 9); // metres → mm
    expect(c2.matrix![1]).toBe(1);
    expect(a.bodies[0].faces.length).toBe(7);
    expect(c1.refFile).toBe('Cube.SLDPRT');
  });
});
