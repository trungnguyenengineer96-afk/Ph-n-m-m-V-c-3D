import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as THREE from 'three';
import { massProperties } from '../src/core/mass';
import { fromOcct, type OcctResult } from '../src/loaders/convert';
import { parseCvMesh } from '../src/loaders/cvmesh';
import type { LoadedModel, ModelNode } from '../src/core/types';

const sample = (f: string) => new URL('../public/samples/' + f, import.meta.url).pathname;
const exe = new URL('../native/build/cvimport', import.meta.url).pathname;

/** Volume and centroid of all part instances placed in world space. */
function worldStats(m: LoadedModel) {
  let vol = 0;
  const c = new THREE.Vector3();
  let count = 0;
  const walk = (n: ModelNode, parent: THREE.Matrix4) => {
    const mat = parent.clone();
    if (n.matrix) mat.multiply(new THREE.Matrix4().fromArray(n.matrix));
    for (const bi of n.bodies) {
      const b = m.bodies[bi];
      const p = b.positions.slice();
      const v = new THREE.Vector3();
      for (let i = 0; i < p.length; i += 3) {
        v.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(mat);
        p[i] = v.x; p[i + 1] = v.y; p[i + 2] = v.z;
      }
      const mp = massProperties([{ positions: p, indices: b.indices }]);
      vol += mp.volume;
      c.addScaledVector(new THREE.Vector3(...mp.centroid), mp.volume);
      count++;
    }
    for (const ch of n.children) walk(ch, mat);
  };
  walk(m.root, new THREE.Matrix4());
  return { vol, centroid: c.divideScalar(vol), count };
}

describe.skipIf(!existsSync(exe))('native importer (cvimport)', async () => {
  const require = createRequire(import.meta.url);
  const occt = await require('occt-import-js')();
  const wasm = (f: string): OcctResult => {
    const r = occt.ReadStepFile(new Uint8Array(readFileSync(sample(f))), null);
    for (const m of r.meshes) {
      m.attributes.position.array = new Float32Array(m.attributes.position.array);
      if (m.attributes.normal) m.attributes.normal.array = new Float32Array(m.attributes.normal.array);
      m.index.array = new Uint32Array(m.index.array);
    }
    return r;
  };
  const native = (f: string) => {
    const out = join(mkdtempSync(join(tmpdir(), 'cvm-')), 'out.cvmesh');
    execFileSync(exe, [sample(f), out, '0.001', '0.5']);
    const b = readFileSync(out);
    return parseCvMesh(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  };

  it('assembly agrees with the wasm reader', () => {
    const a = fromOcct(wasm('as1_pe_203_assembly.stp'), 'as1.stp', 'STEP', 1);
    const b = fromOcct(native('as1_pe_203_assembly.stp'), 'as1.stp', 'STEP', 1);
    expect(b.kind).toBe('assembly');
    const sa = worldStats(a), sb = worldStats(b);
    expect(sb.count).toBe(sa.count);
    expect(Math.abs(sb.vol - sa.vol) / sa.vol).toBeLessThan(0.01);
    expect(sb.centroid.distanceTo(sa.centroid)).toBeLessThan(0.5);
    // Repeated parts are stored once.
    expect(b.bodies.length).toBeLessThan(a.bodies.length);
    expect(b.bodies.every((x) => x.edges.length > 0)).toBe(true);
  });

  it('single part with normals and faces', () => {
    const a = fromOcct(wasm('C04_cube_hole_5mm.step'), 'c.step', 'STEP', 1).bodies[0];
    const b = fromOcct(native('C04_cube_hole_5mm.step'), 'c.step', 'STEP', 1).bodies[0];
    expect(b.faces.length).toBe(a.faces.length);
    expect(b.normals!.length).toBe(b.positions.length);
    const va = massProperties([a]).volume, vb = massProperties([b]).volume;
    expect(Math.abs(vb - va) / va).toBeLessThan(0.005);
    expect(b.edges.length).toBe(a.edges.length);
  });
});
