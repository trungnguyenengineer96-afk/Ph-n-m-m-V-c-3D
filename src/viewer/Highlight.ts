/** Hover / selection overlays for faces, edges and vertices. */
import * as THREE from 'three';
import type { BodyData } from '../core/types';
import type { Pick } from './Picker';
import type { BodyMesh } from './DocumentView';

export const COLORS = {
  hover: 0xf08c00,
  select: 0x1e6fe0,
  selectB: 0x14a05a,
};

let dotTexture: THREE.Texture | null = null;
function getDot() {
  if (dotTexture) return dotTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.beginPath();
  g.arc(32, 32, 26, 0, Math.PI * 2);
  g.fillStyle = '#fff';
  g.fill();
  g.lineWidth = 8;
  g.strokeStyle = '#222';
  g.stroke();
  dotTexture = new THREE.CanvasTexture(c);
  return dotTexture;
}

export class Highlight {
  readonly objects: THREE.Object3D[] = [];
  private clip: THREE.Plane[] | null = null;

  constructor(private overlayRoot: THREE.Object3D) {}

  setClipping(planes: THREE.Plane[]) {
    this.clip = planes.length ? planes : null;
    for (const o of this.objects)
      o.traverse((x) => {
        const m = (x as THREE.Mesh).material as THREE.Material | undefined;
        if (m && x.userData.clipped) {
          m.clippingPlanes = this.clip;
          m.needsUpdate = true;
        }
      });
  }

  clear() {
    for (const o of this.objects) {
      o.removeFromParent();
      o.traverse((x) => {
        const m = x as THREE.Mesh;
        m.geometry?.dispose();
        (m.material as THREE.Material | undefined)?.dispose();
      });
    }
    this.objects.length = 0;
  }

  show(p: Pick, color: number) {
    if (p.kind === 'face') this.face(p.owner, p.body, p.faceIndex, color);
    else if (p.kind === 'edge') this.edge(p.owner, p.body, p.edgeIndex, color);
    else this.point(p.point, color);
  }

  face(mesh: BodyMesh, body: BodyData, faceIndex: number, color: number) {
    const f = body.faces[faceIndex];
    if (!f) return;
    const pos = new Float32Array(f.triCount * 9);
    for (let t = 0; t < f.triCount; t++)
      for (let k = 0; k < 3; k++) {
        const vi = body.indices[(f.triStart + t) * 3 + k];
        pos.set(body.positions.subarray(vi * 3, vi * 3 + 3), (t * 3 + k) * 3);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = new THREE.Mesh(
      g,
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.55,
        side: THREE.DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
        clippingPlanes: this.clip,
      }),
    );
    m.userData.clipped = true;
    m.renderOrder = 25;
    m.raycast = () => {};
    mesh.add(m);
    this.objects.push(m);
  }

  edge(owner: THREE.Object3D, body: BodyData, edgeIndex: number, color: number) {
    const e = body.edges[edgeIndex];
    if (!e) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(e.points.slice(), 3));
    const mat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
    const line = e.closed ? new THREE.LineLoop(g, mat) : new THREE.Line(g, mat);
    line.renderOrder = 30;
    line.raycast = () => {};
    owner.add(line);
    this.objects.push(line);
  }

  point(p: THREE.Vector3, color: number) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([p.x, p.y, p.z], 3));
    const pts = new THREE.Points(
      g,
      new THREE.PointsMaterial({ color, size: 12, sizeAttenuation: false, map: getDot(), transparent: true, depthTest: false, alphaTest: 0.2 }),
    );
    pts.renderOrder = 40;
    pts.raycast = () => {};
    this.overlayRoot.add(pts);
    this.objects.push(pts);
  }
}
