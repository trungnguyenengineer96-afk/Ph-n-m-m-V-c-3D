/** Mass properties of closed triangle meshes (divergence theorem / tetrahedron covariance). */
import type { Vec3 } from './types';
import { eigenSym3 } from './geometry';

export interface MassInput {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  /** 4x4 column-major world matrix (three.js `elements`). */
  matrix?: ArrayLike<number>;
}

export interface MassProps {
  volume: number; // mm³
  area: number; // mm²
  centroid: Vec3; // mm
  /** Inertia tensor about the centroid for unit density, row-major (mm⁵). */
  inertia: number[];
  principalMoments: number[]; // unit density, ascending
  principalAxes: Vec3[];
  bboxMin: Vec3;
  bboxMax: Vec3;
  /** False when the mesh does not look closed (volume unreliable). */
  closedHint: boolean;
}

function xf(m: ArrayLike<number> | undefined, x: number, y: number, z: number): Vec3 {
  if (!m) return [x, y, z];
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
}

export function massProperties(parts: MassInput[]): MassProps {
  let V = 0, A = 0;
  const c = [0, 0, 0];
  // Second moments about origin: ∫ x_i x_j dV
  const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const bmin: Vec3 = [Infinity, Infinity, Infinity], bmax: Vec3 = [-Infinity, -Infinity, -Infinity];
  let signedNeg = 0, signedPos = 0;
  for (const part of parts) {
    const { positions: P, indices: I, matrix } = part;
    const nv = P.length / 3;
    const W = new Float64Array(nv * 3);
    for (let i = 0; i < nv; i++) {
      const p = xf(matrix, P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
      W[i * 3] = p[0];
      W[i * 3 + 1] = p[1];
      W[i * 3 + 2] = p[2];
      for (let k = 0; k < 3; k++) {
        if (p[k] < bmin[k]) bmin[k] = p[k];
        if (p[k] > bmax[k]) bmax[k] = p[k];
      }
    }
    let partV = 0;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, d = I[t + 2] * 3;
      const ax = W[a], ay = W[a + 1], az = W[a + 2];
      const bx = W[b], by = W[b + 1], bz = W[b + 2];
      const cx = W[d], cy = W[d + 1], cz = W[d + 2];
      // area
      const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
      A += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
      // signed tetra (origin, a, b, c)
      const det = ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
      const v = det / 6;
      partV += v;
      c[0] += (v * (ax + bx + cx)) / 4;
      c[1] += (v * (ay + by + cy)) / 4;
      c[2] += (v * (az + bz + cz)) / 4;
      const pa = [ax, ay, az], pb = [bx, by, bz], pc = [cx, cy, cz];
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++) {
          // ∫ x_i x_j over tetra with one vertex at origin:
          // det/120 * (Σ_k a_k_i a_k_j + (Σ a_i)(Σ a_j))
          const s = pa[i] * pa[j] + pb[i] * pb[j] + pc[i] * pc[j];
          const si = pa[i] + pb[i] + pc[i], sj = pa[j] + pb[j] + pc[j];
          C[i * 3 + j] += (det / 120) * (s + si * sj);
        }
    }
    if (partV < 0) signedNeg++;
    else signedPos++;
    V += partV;
  }
  // Inward-oriented meshes produce negative volume; normalise the sign.
  const sgn = V < 0 ? -1 : 1;
  V *= sgn;
  for (let k = 0; k < 9; k++) C[k] *= sgn;
  for (let k = 0; k < 3; k++) c[k] *= sgn;
  const centroid: Vec3 = V > 1e-12 ? [c[0] / V, c[1] / V, c[2] / V] : [(bmin[0] + bmax[0]) / 2, (bmin[1] + bmax[1]) / 2, (bmin[2] + bmax[2]) / 2];
  // Shift second moments to the centroid.
  const Cc = C.slice();
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) Cc[i * 3 + j] -= V * centroid[i] * centroid[j];
  const tr = Cc[0] + Cc[4] + Cc[8];
  const inertia = [tr - Cc[0], -Cc[1], -Cc[2], -Cc[3], tr - Cc[4], -Cc[5], -Cc[6], -Cc[7], tr - Cc[8]];
  const e = eigenSym3(inertia);
  return {
    volume: V,
    area: A,
    centroid,
    inertia,
    principalMoments: e.values,
    principalAxes: e.vectors,
    bboxMin: bmin,
    bboxMax: bmax,
    closedHint: !(signedNeg && signedPos) && V > 1e-9,
  };
}

export const MATERIALS: { name: string; density: number }[] = [
  { name: 'Thép (Steel)', density: 7850 },
  { name: 'Thép không gỉ (SUS304)', density: 8000 },
  { name: 'Gang (Cast iron)', density: 7200 },
  { name: 'Nhôm (6061)', density: 2700 },
  { name: 'Đồng thau (Brass)', density: 8500 },
  { name: 'Đồng (Copper)', density: 8930 },
  { name: 'Titan (Ti-6Al-4V)', density: 4430 },
  { name: 'Nhựa ABS', density: 1050 },
  { name: 'Nhựa POM', density: 1410 },
  { name: 'Nhựa PA6 (Nylon)', density: 1140 },
  { name: 'Gỗ (Wood)', density: 700 },
  { name: 'Nước (1000)', density: 1000 },
];
