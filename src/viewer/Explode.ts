/**
 * Temporary exploded view: components are pushed away from the assembly
 * centre (radially or along one axis) and can be dragged individually.
 * Nothing is written back to the model; "reset" restores every position.
 */
import * as THREE from 'three';
import type { DocumentView } from './DocumentView';
import type { ModelNode } from '../core/types';

export type ExplodeLevel = 'top' | 'parts' | 'bodies';
export type ExplodeDirection = 'radial' | 'x' | 'y' | 'z';

interface Unit {
  obj: THREE.Object3D;
  rest: THREE.Vector3; // local position at rest
  center: THREE.Vector3; // world centre at rest
  manual: THREE.Vector3; // user drag offset, world
  auto: THREE.Vector3; // current automatic offset, world
}

export class ExplodeManager {
  level: ExplodeLevel = 'top';
  direction: ExplodeDirection = 'radial';
  factor = 0;
  private units: Unit[] = [];
  private doc: DocumentView | null = null;
  private center = new THREE.Vector3();
  private diag = 100;
  private restAll = new Map<THREE.Object3D, THREE.Vector3>();

  constructor(private requestRender: () => void) {}

  attach(doc: DocumentView | null) {
    this.reset();
    this.doc = doc;
    this.restAll.clear();
    if (!doc) return;
    doc.root.traverse((o) => this.restAll.set(o, o.position.clone()));
    this.collect();
  }

  get hasUnits() {
    return this.units.length > 1;
  }

  /** Units to explode at the current level. */
  private collect() {
    const doc = this.doc;
    this.units = [];
    if (!doc) return;
    // Measure at rest.
    for (const [o, p] of this.restAll) o.position.copy(p);
    doc.root.updateMatrixWorld(true);
    let objs: THREE.Object3D[] = [];
    if (this.level === 'bodies') objs = doc.meshes.slice();
    else if (this.level === 'parts') {
      // Lowest nodes that own bodies.
      const leafs: THREE.Object3D[] = [];
      const visit = (n: ModelNode) => {
        if (n.bodies.length) leafs.push(doc.nodeObjects.get(n)!);
        n.children.forEach(visit);
      };
      visit(doc.model.root);
      objs = leafs.filter(Boolean);
      if (objs.length <= 1) objs = doc.meshes.slice();
    } else {
      // Top level: descend through single-child wrappers.
      let n = doc.model.root;
      while (!n.bodies.length && n.children.length === 1) n = n.children[0];
      const tops = [...n.children.map((c) => doc.nodeObjects.get(c)!)];
      if (n.bodies.length) tops.push(...doc.meshesOf(n).filter((m) => m.userData.cad.node === n));
      objs = tops.filter((o) => o && hasGeometry(o));
      if (objs.length <= 1) objs = doc.meshes.slice();
    }
    const total = new THREE.Box3();
    for (const o of objs) total.union(new THREE.Box3().setFromObject(o));
    total.getCenter(this.center);
    this.diag = Math.max(total.getSize(new THREE.Vector3()).length(), 1e-3);
    this.units = objs.map((obj) => ({
      obj,
      rest: obj.position.clone(),
      center: new THREE.Box3().setFromObject(obj).getCenter(new THREE.Vector3()),
      manual: new THREE.Vector3(),
      auto: new THREE.Vector3(),
    }));
  }

  setLevel(level: ExplodeLevel) {
    this.level = level;
    this.collect();
    this.apply();
  }

  setDirection(d: ExplodeDirection) {
    this.direction = d;
    this.apply();
  }

  setFactor(f: number) {
    this.factor = f;
    this.apply();
  }

  private apply() {
    const n = this.units.length;
    if (!n) return;
    const axis = this.direction === 'x' ? new THREE.Vector3(1, 0, 0) : this.direction === 'y' ? new THREE.Vector3(0, 1, 0) : this.direction === 'z' ? new THREE.Vector3(0, 0, 1) : null;
    // Axis mode: order units along the axis and spread them evenly.
    let order: number[] = [];
    if (axis) order = this.units.map((_, i) => i).sort((a, b) => this.units[a].center.dot(axis) - this.units[b].center.dot(axis));
    this.units.forEach((u, i) => {
      const off = new THREE.Vector3();
      if (axis) {
        const rank = order.indexOf(i) - (n - 1) / 2;
        off.copy(axis).multiplyScalar(rank * this.diag * 0.35 * this.factor);
      } else {
        const d = u.center.clone().sub(this.center);
        if (d.length() < this.diag * 0.02) {
          // Coincident with the centre: spread on a golden-angle spiral.
          const phi = i * 2.399963, z = 1 - (2 * (i + 0.5)) / n;
          d.set(Math.cos(phi) * Math.sqrt(1 - z * z), z, Math.sin(phi) * Math.sqrt(1 - z * z)).multiplyScalar(this.diag * 0.25);
        }
        off.copy(d).multiplyScalar(this.factor * 1.6);
      }
      u.auto.copy(off);
      this.place(u);
    });
    this.requestRender();
  }

  private place(u: Unit) {
    const parent = u.obj.parent;
    const world = u.auto.clone().add(u.manual);
    if (parent) {
      parent.updateMatrixWorld(true);
      // Convert a world-space translation into the parent's local frame.
      const inv = new THREE.Matrix4().copy(parent.matrixWorld).invert();
      const o = new THREE.Vector3().applyMatrix4(inv);
      const p = world.clone().applyMatrix4(inv).sub(o);
      u.obj.position.copy(u.rest).add(p);
    } else u.obj.position.copy(u.rest).add(world);
    u.obj.updateMatrixWorld(true);
  }

  /** Find the explode unit that contains an object. */
  unitOf(o: THREE.Object3D): THREE.Object3D | null {
    let cur: THREE.Object3D | null = o;
    while (cur) {
      if (this.units.some((u) => u.obj === cur)) return cur;
      cur = cur.parent;
    }
    return null;
  }

  /** Called while dragging with the transform gizmo: record the manual offset. */
  syncManual(obj: THREE.Object3D) {
    const u = this.units.find((x) => x.obj === obj);
    if (!u || !obj.parent) return;
    obj.parent.updateMatrixWorld(true);
    const pw = obj.parent.matrixWorld;
    const restW = u.rest.clone().applyMatrix4(pw);
    const nowW = obj.position.clone().applyMatrix4(pw);
    u.manual.copy(nowW.sub(restW).sub(u.auto));
  }

  get isExploded() {
    return this.factor > 0 || this.units.some((u) => u.manual.lengthSq() > 0);
  }

  reset() {
    for (const u of this.units) {
      u.manual.set(0, 0, 0);
      u.auto.set(0, 0, 0);
    }
    for (const [o, p] of this.restAll) o.position.copy(p);
    this.doc?.root.updateMatrixWorld(true);
    this.factor = 0;
    this.requestRender();
  }
}

function hasGeometry(o: THREE.Object3D) {
  let found = false;
  o.traverse((x) => {
    if ((x as THREE.Mesh).isMesh) found = true;
  });
  return found;
}
