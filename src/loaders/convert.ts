/** Conversions from loader outputs (OpenCascade, plain triangle meshes) to LoadedModel. */
import type { BodyData, FaceInfo, FileInfo, LoadedModel, ModelNode, Vec3 } from '../core/types';
import { bodiesDiagonal, chainSegments, cross, dot, edgesFromFaces, mergeCoCircularArcs, norm, pointAt, sub } from '../core/geometry';

// ---------------- OpenCascade (occt-import-js) ----------------
export interface OcctMesh {
  name?: string;
  color?: number[];
  brep_faces?: { first: number; last: number; color: number[] | null }[];
  attributes: { position: { array: Float32Array }; normal?: { array: Float32Array } };
  index: { array: Uint32Array };
}
export interface OcctNode {
  name: string;
  meshes: number[];
  children: OcctNode[];
  /** Placement relative to the parent, column-major 4×4 (mm); native importer only. */
  matrix?: number[];
}
export interface OcctResult {
  success: boolean;
  root: OcctNode;
  meshes: OcctMesh[];
}

export function fromOcct(res: OcctResult, fileName: string, format: string, fileSize: number): LoadedModel {
  const bodies: BodyData[] = res.meshes.map((m, i): BodyData => {
    const positions = m.attributes.position.array;
    const indices = m.index.array;
    const nt = indices.length / 3;
    let faces: FaceInfo[] = (m.brep_faces || []).map((f) => ({
      triStart: f.first,
      triCount: f.last - f.first + 1,
      color: f.color ? (f.color as Vec3) : undefined,
    }));
    if (!faces.length) faces = [{ triStart: 0, triCount: nt }];
    return {
      name: m.name && m.name.trim() ? m.name : `Thân ${i + 1}`,
      positions,
      normals: m.attributes.normal?.array,
      indices,
      color: m.color ? (m.color as Vec3) : undefined,
      faces,
      edges: edgesFromFaces(positions, indices, faces),
    };
  });
  const tol = Math.max(1e-4, bodiesDiagonal(bodies) * 2e-5);
  for (const b of bodies) b.edges = mergeCoCircularArcs(b.edges, tol);
  const baseName = fileName.replace(/\.[^.]+$/, '');
  const conv = (n: OcctNode, depth: number): ModelNode => {
    const node: ModelNode = {
      name: n.name && n.name.trim() ? n.name : depth === 0 ? baseName : 'Thành phần',
      bodies: n.meshes.slice(),
      children: (n.children || []).map((c) => conv(c, depth + 1)),
    };
    if (n.matrix && !isIdentity(n.matrix)) node.matrix = n.matrix;
    // OpenCascade flattens sub-assemblies into one node with several meshes;
    // give each solid its own node so it can be selected, hidden and exploded.
    if (node.bodies.length > 1) {
      const counts = new Map<string, number>();
      for (const bi of node.bodies) counts.set(bodies[bi].name, (counts.get(bodies[bi].name) ?? 0) + 1);
      const seen = new Map<string, number>();
      const solids = node.bodies.map((bi) => {
        const nm = bodies[bi].name;
        const k = (seen.get(nm) ?? 0) + 1;
        seen.set(nm, k);
        return { name: counts.get(nm)! > 1 ? `${nm} <${k}>` : nm, bodies: [bi], children: [] };
      });
      node.children = [...solids, ...node.children];
      node.bodies = [];
    }
    return node;
  };
  let root = conv(res.root, 0);
  // Collapse nameless single-child wrappers that OpenCascade adds on top.
  while (!root.bodies.length && root.children.length === 1 && root.children[0].children.length) {
    root = { ...root.children[0], name: root.children[0].name || baseName };
  }
  if (!root.name || root.name === 'Thành phần') root.name = baseName;
  const leafCount = countParts(root);
  const info: FileInfo = { format, fileName, fileSize, properties: {}, previews: [], references: [], warnings: [] };
  info.properties['Số thân (body)'] = String(bodies.length);
  return { kind: leafCount > 1 ? 'assembly' : 'part', name: baseName, root, bodies, info };
}

function isIdentity(m: number[]): boolean {
  return m.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-12);
}

function countParts(n: ModelNode): number {
  return n.bodies.length + n.children.reduce((s, c) => s + countParts(c), 0);
}

// ---------------- plain triangle meshes (STL / OBJ / glTF / 3MF / PLY) ----------------
export interface RawMesh {
  name: string;
  positions: Float32Array; // already in model space (mm)
  indices: Uint32Array | null;
  color?: Vec3;
}
export interface RawNode {
  name: string;
  meshes: number[];
  children: RawNode[];
}

/** Weld coincident vertices so triangles share indices (needed for adjacency). */
function weld(positions: Float32Array, indices: Uint32Array | null) {
  const map = new Map<string, number>();
  const out: number[] = [];
  const nv = positions.length / 3;
  const remap = new Uint32Array(nv);
  for (let i = 0; i < nv; i++) {
    const k = `${positions[i * 3]},${positions[i * 3 + 1]},${positions[i * 3 + 2]}`;
    let id = map.get(k);
    if (id === undefined) {
      id = out.length / 3;
      map.set(k, id);
      out.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    }
    remap[i] = id;
  }
  const src = indices ?? Uint32Array.from({ length: nv }, (_, i) => i);
  const idx = new Uint32Array(src.length);
  for (let i = 0; i < src.length; i++) idx[i] = remap[src[i]];
  return { positions: new Float32Array(out), indices: idx };
}

/**
 * Split a mesh into "faces": regions of triangles connected across edges whose
 * dihedral angle stays below the threshold. Returns triangles reordered by face.
 */
export function segmentFaces(positions: Float32Array, indices: Uint32Array, angleDeg = 12) {
  const nt = indices.length / 3;
  const cosT = Math.cos((angleDeg * Math.PI) / 180);
  const tn: Vec3[] = new Array(nt);
  for (let t = 0; t < nt; t++) {
    const a = pointAt(positions, indices[t * 3]), b = pointAt(positions, indices[t * 3 + 1]), c = pointAt(positions, indices[t * 3 + 2]);
    tn[t] = norm(cross(sub(b, a), sub(c, a)));
  }
  const edgeTris = new Map<number, number[]>();
  const nv = positions.length / 3;
  for (let t = 0; t < nt; t++)
    for (let e = 0; e < 3; e++) {
      const a = indices[t * 3 + e], b = indices[t * 3 + ((e + 1) % 3)];
      const k = a < b ? a * nv + b : b * nv + a;
      let l = edgeTris.get(k);
      if (!l) edgeTris.set(k, (l = []));
      l.push(t);
    }
  const label = new Int32Array(nt).fill(-1);
  const order: number[] = [];
  const faces: FaceInfo[] = [];
  for (let s = 0; s < nt; s++) {
    if (label[s] >= 0) continue;
    const fid = faces.length;
    const start = order.length;
    const stack = [s];
    label[s] = fid;
    while (stack.length) {
      const t = stack.pop()!;
      order.push(t);
      for (let e = 0; e < 3; e++) {
        const a = indices[t * 3 + e], b = indices[t * 3 + ((e + 1) % 3)];
        const k = a < b ? a * nv + b : b * nv + a;
        const l = edgeTris.get(k)!;
        if (l.length !== 2) continue; // non-manifold or boundary edge breaks the region
        for (const u of l) {
          if (label[u] >= 0) continue;
          if (dot(tn[t], tn[u]) >= cosT) {
            label[u] = fid;
            stack.push(u);
          }
        }
      }
    }
    faces.push({ triStart: start, triCount: order.length - start });
  }
  const out = new Uint32Array(indices.length);
  order.forEach((t, i) => out.set(indices.subarray(t * 3, t * 3 + 3), i * 3));
  return { indices: out, faces };
}

/**
 * Plain meshes have no B-rep: faces are angle-based regions and the shown
 * edges are their boundaries. Region edges are unshared within the welded mesh,
 * so they are computed directly instead of via edgesFromFaces.
 */
export function bodyFromRaw(m: RawMesh): BodyData {
  const w = weld(m.positions, m.indices);
  const seg = segmentFaces(w.positions, w.indices);
  const faces = seg.faces;
  const nt = seg.indices.length / 3;
  const faceOf = new Int32Array(nt);
  faces.forEach((f, fi) => faceOf.fill(fi, f.triStart, f.triStart + f.triCount));
  const nv = w.positions.length / 3;
  const owner = new Map<number, number>();
  const segs: number[] = [];
  for (let t = 0; t < nt; t++)
    for (let e = 0; e < 3; e++) {
      const a = seg.indices[t * 3 + e], b = seg.indices[t * 3 + ((e + 1) % 3)];
      const k = a < b ? a * nv + b : b * nv + a;
      const prev = owner.get(k);
      if (prev === undefined) owner.set(k, t);
      else {
        owner.delete(k);
        if (faceOf[prev] !== faceOf[t]) segs.push(...pointAt(w.positions, a), ...pointAt(w.positions, b));
      }
    }
  for (const [k] of owner) {
    const a = Math.floor(k / nv), b = k % nv;
    segs.push(...pointAt(w.positions, a), ...pointAt(w.positions, b));
  }
  const edges = chainSegments(segs).map((c) => ({ points: c.points, closed: c.closed }));
  return { name: m.name, positions: w.positions, indices: seg.indices, color: m.color, faces, edges };
}

export function fromRawMeshes(meshes: RawMesh[], tree: RawNode, fileName: string, format: string, fileSize: number): LoadedModel {
  const bodies = meshes.map(bodyFromRaw);
  const conv = (n: RawNode): ModelNode => ({ name: n.name, bodies: n.meshes, children: n.children.map(conv) });
  const root = conv(tree);
  const info: FileInfo = {
    format,
    fileName,
    fileSize,
    properties: { 'Số thân (body)': String(bodies.length) },
    previews: [],
    references: [],
    warnings: ['Tệp lưới tam giác: các "mặt" được nhận dạng theo góc pháp tuyến; kích thước bán kính là giá trị khớp gần đúng.'],
  };
  return { kind: bodies.length > 1 ? 'assembly' : 'part', name: fileName.replace(/\.[^.]+$/, ''), root, bodies, info };
}
