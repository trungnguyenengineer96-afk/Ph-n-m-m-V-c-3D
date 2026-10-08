/**
 * Section view: up to three clipping planes with capped (filled, hatched) cuts.
 *
 * Caps use the stencil technique: for each plane the back faces of every
 * solid increment and the front faces decrement the stencil, so after both
 * passes the stencil is non-zero exactly where the plane lies inside material.
 * A large quad on the plane is then drawn where stencil ≠ 0.
 */
import * as THREE from 'three';
import type { DocumentView } from './DocumentView';

export type SectionAxis = 'x' | 'y' | 'z' | 'custom';

export interface SectionPlaneState {
  enabled: boolean;
  axis: SectionAxis;
  /** Signed offset along the plane normal (mm). */
  offset: number;
  flip: boolean;
  /** Custom plane normal (for 'custom'). */
  normal: THREE.Vector3;
  /** Rotations (degrees) about the two in-plane axes, like SolidWorks' section angles. */
  rotA: number;
  rotB: number;
}

const AXIS_N: Record<Exclude<SectionAxis, 'custom'>, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

function hatchTexture(color: string, line: string) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = color;
  g.fillRect(0, 0, 64, 64);
  g.strokeStyle = line;
  g.lineWidth = 3;
  for (let k = -64; k <= 128; k += 16) {
    g.beginPath();
    g.moveTo(k, 64);
    g.lineTo(k + 64, 0);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class SectionManager {
  readonly states: SectionPlaneState[] = [
    { enabled: true, axis: 'z', offset: 0, flip: false, normal: new THREE.Vector3(0, 0, 1), rotA: 0, rotB: 0 },
    { enabled: false, axis: 'x', offset: 0, flip: false, normal: new THREE.Vector3(1, 0, 0), rotA: 0, rotB: 0 },
    { enabled: false, axis: 'y', offset: 0, flip: false, normal: new THREE.Vector3(0, 1, 0), rotA: 0, rotB: 0 },
  ];
  readonly planes = [new THREE.Plane(), new THREE.Plane(), new THREE.Plane()];
  active = false;
  showCaps = true;
  hatch = true;
  showPlane = true;
  capColor = '#c9773c';
  private caps: THREE.Mesh[] = [];
  private outlines: THREE.LineLoop[] = [];
  private stencilObjects: THREE.Object3D[] = [];
  private doc: DocumentView | null = null;
  private center = new THREE.Vector3();
  private size = 100;
  private texture: THREE.Texture | null = null;
  readonly onChange: ((planes: THREE.Plane[]) => void)[] = [];

  constructor(private overlay: THREE.Object3D, private requestRender: () => void) {}

  activePlanes(): THREE.Plane[] {
    if (!this.active) return [];
    return this.planes.filter((_, i) => this.states[i].enabled);
  }

  /** Normal of plane i before flipping. */
  baseNormal(i: number): THREE.Vector3 {
    const s = this.states[i];
    const n = s.axis === 'custom' ? s.normal.clone().normalize() : AXIS_N[s.axis].clone();
    if (s.rotA || s.rotB) {
      const t = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const u = new THREE.Vector3().crossVectors(t, n).normalize();
      const v = new THREE.Vector3().crossVectors(n, u).normalize();
      n.applyAxisAngle(u, THREE.MathUtils.degToRad(s.rotA)).applyAxisAngle(v, THREE.MathUtils.degToRad(s.rotB));
    }
    return n.normalize();
  }

  /** Range of offsets along plane i's normal covering the model. */
  range(i: number): [number, number] {
    const n = this.baseNormal(i);
    const c = this.center.dot(n);
    return [c - this.size / 2, c + this.size / 2];
  }

  attach(doc: DocumentView | null) {
    this.detach();
    this.doc = doc;
    if (!doc) return;
    const box = doc.bounds(false);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    this.center.copy(sphere.center);
    this.size = Math.max(sphere.radius * 2, 1e-3);
    // Reset offsets to the model centre.
    this.states.forEach((s, i) => {
      s.offset = this.baseNormal(i).dot(this.center);
    });
    this.rebuild();
  }

  detach() {
    for (const o of [...this.caps, ...this.outlines, ...this.stencilObjects]) {
      o.removeFromParent();
      o.traverse((x) => {
        const m = x as THREE.Mesh;
        if (m.geometry && !(x.userData.sharedGeometry)) m.geometry.dispose();
        (m.material as THREE.Material | undefined)?.dispose();
      });
    }
    this.caps = [];
    this.outlines = [];
    this.stencilObjects = [];
    this.doc?.setClipping([]);
  }

  setActive(on: boolean) {
    this.active = on;
    this.rebuild();
  }

  /** Recompute plane equations; cheap, call on slider moves. */
  updatePlanes() {
    this.states.forEach((s, i) => {
      const n = this.baseNormal(i);
      // three.js keeps the side where n·p + c ≥ 0. Default keeps the side opposite the normal (SolidWorks style).
      const keep = s.flip ? n : n.clone().negate();
      const point = n.clone().multiplyScalar(s.offset);
      this.planes[i].setFromNormalAndCoplanarPoint(keep, point);
    });
    this.positionCaps();
    this.requestRender();
  }

  /** Rebuild stencil groups and caps after the set of active planes changed. */
  rebuild() {
    const doc = this.doc;
    for (const o of [...this.caps, ...this.outlines, ...this.stencilObjects]) {
      o.removeFromParent();
      if (o instanceof THREE.Mesh && !o.userData.sharedGeometry) o.geometry.dispose();
    }
    this.caps = [];
    this.outlines = [];
    this.stencilObjects = [];
    this.updatePlanes();
    const active = this.activePlanes();
    if (!doc) return;
    doc.setClipping(active);
    for (const f of this.onChange) f(active);
    if (!active.length) {
      this.requestRender();
      return;
    }
    if (this.hatch) {
      this.texture?.dispose();
      this.texture = hatchTexture(this.capColor, 'rgba(40,20,10,0.55)');
    }
    active.forEach((plane, i) => {
      if (this.showCaps && doc.meshes.length) {
        // Stencil writers as children of each mesh so they follow explode transforms.
        const back = new THREE.MeshBasicMaterial({
          side: THREE.BackSide,
          clippingPlanes: [plane],
          depthWrite: false,
          depthTest: false,
          colorWrite: false,
          stencilWrite: true,
          stencilFunc: THREE.AlwaysStencilFunc,
          stencilFail: THREE.IncrementWrapStencilOp,
          stencilZFail: THREE.IncrementWrapStencilOp,
          stencilZPass: THREE.IncrementWrapStencilOp,
        });
        const front = back.clone();
        front.side = THREE.FrontSide;
        front.clippingPlanes = [plane];
        front.stencilFail = front.stencilZFail = front.stencilZPass = THREE.DecrementWrapStencilOp;
        for (const m of doc.meshes) {
          for (const mat of [back, front]) {
            const s = new THREE.Mesh(m.geometry, mat);
            s.userData.sharedGeometry = true;
            s.renderOrder = i + 1;
            s.raycast = () => {};
            m.add(s);
            this.stencilObjects.push(s);
          }
        }
        const others = active.filter((p) => p !== plane);
        const capMat = new THREE.MeshStandardMaterial({
          color: this.hatch ? 0xffffff : this.capColor,
          map: this.hatch ? this.texture : null,
          metalness: 0,
          roughness: 0.8,
          side: THREE.DoubleSide,
          clippingPlanes: others,
          stencilWrite: true,
          stencilRef: 0,
          stencilFunc: THREE.NotEqualStencilFunc,
          stencilFail: THREE.ReplaceStencilOp,
          stencilZFail: THREE.ReplaceStencilOp,
          stencilZPass: THREE.ReplaceStencilOp,
        });
        const cap = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), capMat);
        cap.renderOrder = i + 1.1;
        cap.onAfterRender = (r) => r.clearStencil();
        cap.raycast = () => {};
        cap.userData.planeIndex = this.planes.indexOf(plane);
        this.overlay.add(cap);
        this.caps.push(cap);
      }
      if (this.showPlane) {
        const g = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(-0.5, -0.5, 0),
          new THREE.Vector3(0.5, -0.5, 0),
          new THREE.Vector3(0.5, 0.5, 0),
          new THREE.Vector3(-0.5, 0.5, 0),
        ]);
        const outline = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: 0x2b6cd4, transparent: true, opacity: 0.7, clippingPlanes: active.filter((p) => p !== plane) }));
        outline.userData.planeIndex = this.planes.indexOf(plane);
        outline.renderOrder = 50;
        outline.raycast = () => {};
        this.overlay.add(outline);
        this.outlines.push(outline);
      }
    });
    this.positionCaps();
    this.requestRender();
  }

  private positionCaps() {
    for (const o of [...this.caps, ...this.outlines]) {
      const plane = this.planes[o.userData.planeIndex as number];
      if (!plane) continue;
      const p = new THREE.Vector3();
      plane.projectPoint(this.center, p);
      o.position.copy(p);
      o.lookAt(p.clone().sub(plane.normal));
      const s = o instanceof THREE.LineLoop ? this.size * 1.05 : this.size * 4;
      o.scale.set(s, s, 1);
      if (o instanceof THREE.Mesh && this.texture) {
        // Keep hatch spacing constant in screen-independent model units.
        this.texture.repeat.set(s / (this.size / 14), s / (this.size / 14));
      }
    }
  }
}
