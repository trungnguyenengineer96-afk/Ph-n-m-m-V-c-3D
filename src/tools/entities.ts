/** Convert picks (body-local data) into world-space measurement entities. */
import * as THREE from 'three';
import type { BodyData, FaceInfo, SurfaceInfo, Vec3 } from '../core/types';
import { analyseEdge, analyseFace, faceArea, facePoints } from '../core/geometry';
import type { MEntity } from '../core/measure';
import type { Pick } from '../viewer/Picker';

const surfaceCache = new WeakMap<FaceInfo, SurfaceInfo>();
const areaCache = new WeakMap<FaceInfo, number>();

const v3 = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];

export function faceSurface(body: BodyData, face: FaceInfo, tol: number): SurfaceInfo {
  let s = surfaceCache.get(face);
  if (!s) {
    s = analyseFace(body, face, tol);
    surfaceCache.set(face, s);
  }
  return s;
}

export function faceAreaCached(body: BodyData, face: FaceInfo): number {
  let a = areaCache.get(face);
  if (a === undefined) {
    a = faceArea(body, face);
    areaCache.set(face, a);
  }
  return a;
}

function uniformScale(m: THREE.Matrix4) {
  const s = new THREE.Vector3();
  m.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
  return (Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.z)) / 3;
}

export function entityFromPick(p: Pick, tol: number): MEntity {
  if (p.kind === 'vertex') return { type: 'point', p: v3(p.point), label: 'Đỉnh' };
  if (p.kind === 'free') return { type: 'point', p: v3(p.point), label: 'Điểm' };
  const mw = p.owner.matrixWorld;
  const sc = uniformScale(mw);
  const toW = (x: Vec3): Vec3 => v3(new THREE.Vector3(...x).applyMatrix4(mw));
  const dirW = (x: Vec3): Vec3 => v3(new THREE.Vector3(...x).transformDirection(mw));
  if (p.kind === 'edge') {
    const e = analyseEdge(p.body.edges[p.edgeIndex], tol);
    const pts: Vec3[] = [];
    for (let i = 0; i < e.points.length; i += 3) pts.push(toW([e.points[i], e.points[i + 1], e.points[i + 2]]));
    return {
      type: 'edge',
      label: { line: 'Cạnh thẳng', circle: 'Cạnh tròn', arc: 'Cung', curve: 'Cạnh cong' }[e.kind!],
      kind: e.kind!,
      length: (e.length ?? 0) * sc,
      points: pts,
      center: e.center ? toW(e.center) : undefined,
      radius: e.radius !== undefined ? e.radius * sc : undefined,
      normal: e.normal ? dirW(e.normal) : undefined,
    };
  }
  const body = p.body;
  const face = body.faces[p.faceIndex];
  const s = faceSurface(body, face, tol);
  const surface: SurfaceInfo = {
    ...s,
    axis: s.axis ? dirW(s.axis) : undefined,
    origin: s.origin ? toW(s.origin) : undefined,
    radius: s.radius !== undefined ? s.radius * sc : undefined,
  };
  // Planes from SolidWorks carry only the normal; anchor them on the face.
  const localPts = facePoints(body, face, 3000);
  if (surface.kind === 'plane' && !surface.origin && localPts.length) surface.origin = toW(localPts[0]);
  // Normal pointing out of the material, as seen from the picked side.
  if (surface.kind === 'plane' && surface.axis && p.normal.dot(new THREE.Vector3(...surface.axis)) < 0)
    surface.axis = [-surface.axis[0], -surface.axis[1], -surface.axis[2]];
  const step = Math.max(1, Math.ceil(face.triCount / 6000));
  const nt = Math.ceil(face.triCount / step);
  const tris = new Float32Array(nt * 9);
  const tmp = new THREE.Vector3();
  let o = 0;
  for (let t = face.triStart; t < face.triStart + face.triCount; t += step)
    for (let k = 0; k < 3; k++) {
      const vi = body.indices[t * 3 + k];
      tmp.set(body.positions[vi * 3], body.positions[vi * 3 + 1], body.positions[vi * 3 + 2]).applyMatrix4(mw);
      tris[o++] = tmp.x;
      tris[o++] = tmp.y;
      tris[o++] = tmp.z;
    }
  const kindLabel: Record<string, string> = {
    plane: 'Mặt phẳng', cylinder: 'Mặt trụ', cone: 'Mặt côn', sphere: 'Mặt cầu', torus: 'Mặt xuyến', bspline: 'Mặt B-spline', other: 'Mặt cong',
  };
  return {
    type: 'face',
    label: kindLabel[surface.kind] ?? 'Mặt',
    surface,
    area: faceAreaCached(body, face) * sc * sc,
    points: localPts.map(toW),
    triangles: tris.subarray(0, o),
  };
}
