/**
 * Reader for the output of the native importer (native/cvimport.cpp):
 *
 *   "CVMESH01" | u32 jsonLength | JSON | padding to 4 | float32/uint32 arrays
 *
 * Array references in the JSON are [byteOffset, count] into the binary part.
 * The result has the same shape as occt-import-js output, so fromOcct()
 * converts it; nodes may also carry a column-major 4×4 matrix (mm).
 */
import type { OcctMesh, OcctNode, OcctResult } from './convert';

const MAGIC = 'CVMESH01';

interface CvMesh {
  name: string;
  color: number[] | null;
  brep_faces: { first: number; last: number; color: number[] | null }[];
  pos: [number, number];
  nor: [number, number];
  idx: [number, number];
}
interface CvFile {
  success: boolean;
  root: OcctNode;
  meshes: CvMesh[];
  timing?: { read: number; mesh: number };
}

export function parseCvMesh(buf: ArrayBuffer): OcctResult & { timing?: { read: number; mesh: number } } {
  const bytes = new Uint8Array(buf);
  if (bytes.length < 12 || new TextDecoder().decode(bytes.subarray(0, 8)) !== MAGIC) throw new Error('Không phải tệp CVMESH');
  const jsonLen = new DataView(buf).getUint32(8, true);
  const js = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + jsonLen))) as CvFile;
  const base = 12 + jsonLen + ((4 - ((12 + jsonLen) % 4)) % 4);
  const f32 = ([off, n]: [number, number]) => new Float32Array(buf, base + off, n);
  const u32 = ([off, n]: [number, number]) => new Uint32Array(buf, base + off, n);
  const meshes: OcctMesh[] = js.meshes.map((m) => ({
    name: m.name,
    color: m.color ?? undefined,
    brep_faces: m.brep_faces,
    attributes: { position: { array: f32(m.pos) }, normal: { array: f32(m.nor) } },
    index: { array: u32(m.idx) },
  }));
  return { success: js.success, root: js.root, meshes, timing: js.timing };
}
