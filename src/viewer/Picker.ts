/** Screen picking with snapping: vertex > edge > face, honouring visibility and section planes. */
import * as THREE from 'three';
import type { BodyData } from '../core/types';
import type { BodyMesh, DocumentView } from './DocumentView';
import type { Viewer } from './Viewer';

export type Pick =
  | { kind: 'vertex'; owner: THREE.Object3D; body: BodyData; edgeIndex: number; point: THREE.Vector3 }
  | { kind: 'edge'; owner: THREE.Object3D; body: BodyData; edgeIndex: number; point: THREE.Vector3 }
  | { kind: 'face'; owner: BodyMesh; body: BodyData; faceIndex: number; point: THREE.Vector3; normal: THREE.Vector3 }
  | { kind: 'free'; point: THREE.Vector3 };

export interface PickOptions {
  vertices?: boolean;
  edges?: boolean;
  faces?: boolean;
  /** For drawings: return a free point on the XY plane when nothing is hit. */
  free?: boolean;
}

const VERTEX_PX = 9;
const EDGE_PX = 6;

export class Picker {
  private raycaster = new THREE.Raycaster();
  planes: THREE.Plane[] = [];

  constructor(private viewer: Viewer, private getDoc: () => DocumentView | null) {}

  private ndc(clientX: number, clientY: number) {
    const r = this.viewer.renderer.domElement.getBoundingClientRect();
    return {
      ndc: new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1),
      px: new THREE.Vector2(clientX - r.left, clientY - r.top),
      w: r.width,
      h: r.height,
    };
  }

  private unclipped(p: THREE.Vector3, eps = 0) {
    for (const pl of this.planes) if (pl.distanceToPoint(p) < -eps) return false;
    return true;
  }

  /** Visible meshes for raycasting. */
  pickableMeshes(doc: DocumentView): BodyMesh[] {
    return doc.meshes.filter((m) => doc.isEffectivelyVisible(m));
  }

  raycastFace(clientX: number, clientY: number): Extract<Pick, { kind: 'face' }> | null {
    const doc = this.getDoc();
    if (!doc) return null;
    const { ndc } = this.ndc(clientX, clientY);
    this.raycaster.setFromCamera(ndc, this.viewer.camera);
    const hits = this.raycaster.intersectObjects(this.pickableMeshes(doc), false);
    for (const h of hits) {
      if (!this.unclipped(h.point, this.viewer.modelRadius * 1e-6)) continue;
      const mesh = h.object as BodyMesh;
      if (h.faceIndex === undefined || h.faceIndex === null) continue;
      const fi = doc.faceIndexOfTriangle(mesh, h.faceIndex);
      const normal = h.face ? h.face.normal.clone().transformDirection(mesh.matrixWorld) : new THREE.Vector3(0, 0, 1);
      return { kind: 'face', owner: mesh, body: mesh.userData.cad.body, faceIndex: fi, point: h.point.clone(), normal };
    }
    return null;
  }

  pick(clientX: number, clientY: number, opts: PickOptions = { vertices: true, edges: true, faces: true }): Pick | null {
    const doc = this.getDoc();
    if (!doc) return null;
    const { px, w, h } = this.ndc(clientX, clientY);
    const cam = this.viewer.camera;
    cam.updateMatrixWorld();
    const face = opts.faces !== false || opts.edges || opts.vertices ? this.raycastFace(clientX, clientY) : null;
    const view = cam.matrixWorldInverse;
    const hitZ = face ? face.point.clone().applyMatrix4(view).z : -Infinity;
    const depthEps = this.viewer.modelRadius * 0.004 + this.viewer.pixelSize() * 3;

    let bestV: { d: number; owner: THREE.Object3D; body: BodyData; edge: number; p: THREE.Vector3 } | null = null;
    let bestE: { d: number; owner: THREE.Object3D; body: BodyData; edge: number; p: THREE.Vector3 } | null = null;

    if (opts.vertices || opts.edges) {
      const owners: { obj: THREE.Object3D; body: BodyData }[] = [];
      for (const m of doc.meshes) if (doc.isEffectivelyVisible(m) && m.userData.cad.body.edges.length) owners.push({ obj: m, body: m.userData.cad.body });
      for (const l of doc.lineObjects) if (doc.isEffectivelyVisible(l)) owners.push({ obj: l, body: l.userData.cadLines as BodyData });

      const tmp = new THREE.Vector3();
      const projected = (v: THREE.Vector3) => {
        tmp.copy(v).project(cam);
        return { x: ((tmp.x + 1) / 2) * w, y: ((1 - tmp.y) / 2) * h };
      };
      const visible = (wp: THREE.Vector3) => {
        if (!this.unclipped(wp, this.viewer.modelRadius * 1e-5)) return false;
        if (!face) return true;
        return wp.clone().applyMatrix4(view).z >= hitZ - depthEps;
      };
      const sphere = new THREE.Sphere();
      const a = new THREE.Vector3(), b = new THREE.Vector3();
      for (const { obj, body } of owners) {
        // Cheap reject using the projected bounding sphere.
        const g = (obj as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
        if (g) {
          if (!g.boundingSphere) g.computeBoundingSphere();
          sphere.copy(g.boundingSphere!).applyMatrix4(obj.matrixWorld);
          const c = projected(sphere.center);
          const rpx = sphere.radius / this.viewer.pixelSize();
          if (cam instanceof THREE.OrthographicCamera && Math.hypot(c.x - px.x, c.y - px.y) > rpx + 20) continue;
        }
        const mw = obj.matrixWorld;
        body.edges.forEach((e, ei) => {
          const pts = e.points, n = pts.length / 3;
          let prev: { x: number; y: number } | null = null;
          const segs = n - 1 + (e.closed ? 1 : 0);
          const first = projected(a.set(pts[0], pts[1], pts[2]).applyMatrix4(mw));
          // Vertices: endpoints of open edges.
          if (opts.vertices && !e.closed) {
            for (const k of [0, n - 1]) {
              const wp = new THREE.Vector3(pts[k * 3], pts[k * 3 + 1], pts[k * 3 + 2]).applyMatrix4(mw);
              const s = projected(wp);
              const d = Math.hypot(s.x - px.x, s.y - px.y);
              if (d < VERTEX_PX && (!bestV || d < bestV.d) && visible(wp)) bestV = { d, owner: obj, body, edge: ei, p: wp };
            }
          }
          if (!opts.edges) return;
          prev = first;
          for (let i = 0; i < segs; i++) {
            const j = (i + 1) % n;
            b.set(pts[j * 3], pts[j * 3 + 1], pts[j * 3 + 2]).applyMatrix4(mw);
            const cur = projected(b);
            const dx = cur.x - prev.x, dy = cur.y - prev.y;
            const L2 = dx * dx + dy * dy;
            let t = L2 > 0 ? ((px.x - prev.x) * dx + (px.y - prev.y) * dy) / L2 : 0;
            t = Math.max(0, Math.min(1, t));
            const d = Math.hypot(prev.x + t * dx - px.x, prev.y + t * dy - px.y);
            if (d < EDGE_PX && (!bestE || d < bestE.d)) {
              const pa = new THREE.Vector3(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]).applyMatrix4(mw);
              const wp = pa.lerp(b, t);
              if (visible(wp)) bestE = { d, owner: obj, body, edge: ei, p: wp.clone() };
            }
            prev = cur;
          }
        });
      }
    }
    if (bestV) {
      const v = bestV as { owner: THREE.Object3D; body: BodyData; edge: number; p: THREE.Vector3 };
      return { kind: 'vertex', owner: v.owner, body: v.body, edgeIndex: v.edge, point: v.p };
    }
    if (bestE) {
      const e = bestE as { owner: THREE.Object3D; body: BodyData; edge: number; p: THREE.Vector3 };
      return { kind: 'edge', owner: e.owner, body: e.body, edgeIndex: e.edge, point: e.p };
    }
    if (face && opts.faces !== false) return face;
    if (opts.free) {
      const { ndc } = this.ndc(clientX, clientY);
      this.raycaster.setFromCamera(ndc, cam);
      const p = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), p)) return { kind: 'free', point: p };
    }
    return null;
  }
}
