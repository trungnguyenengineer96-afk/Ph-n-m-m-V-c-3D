/** Interactive Measure tool (SolidWorks Evaluate → Measure). */
import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { describe, measureMany, measurePair, type MEntity, type MResult } from '../core/measure';
import { fmtValue } from '../core/units';
import { COLORS, Highlight } from '../viewer/Highlight';
import type { Pick, Picker } from '../viewer/Picker';
import type { Viewer } from '../viewer/Viewer';
import { entityFromPick } from './entities';

export interface MeasureSelection {
  pick: Pick;
  entity: MEntity;
}

export class MeasureTool {
  active = false;
  /** Persistent dimension annotations kept after a new measurement starts. */
  keepHistory = false;
  readonly selection: MeasureSelection[] = [];
  result: MResult | null = null;
  private hover: Highlight;
  private selected: Highlight;
  private graphics = new THREE.Group();
  private history = new THREE.Group();
  readonly onChange: (() => void)[] = [];

  constructor(private viewer: Viewer, private picker: Picker, private getTolerance: () => number) {
    this.hover = new Highlight(viewer.overlay);
    this.selected = new Highlight(viewer.overlay);
    viewer.overlay.add(this.graphics, this.history);
  }

  setClipping(planes: THREE.Plane[]) {
    this.hover.setClipping(planes);
    this.selected.setClipping(planes);
  }

  setActive(on: boolean) {
    this.active = on;
    if (!on) {
      this.hover.clear();
      this.clear();
    }
    this.viewer.requestRender();
  }

  private pickOpts() {
    return { vertices: true, edges: true, faces: true, free: this.viewer.is2D };
  }

  onHover(x: number, y: number) {
    if (!this.active) return;
    this.hover.clear();
    const p = this.picker.pick(x, y, this.pickOpts());
    if (p && p.kind !== 'free') this.hover.show(p, COLORS.hover);
    this.viewer.renderer.domElement.style.cursor = p ? 'crosshair' : 'default';
    this.viewer.requestRender();
  }

  /** Click: replace selection; with additive (Ctrl/Shift) append. */
  onClick(x: number, y: number, additive: boolean) {
    if (!this.active) return;
    const p = this.picker.pick(x, y, this.pickOpts());
    if (!p) {
      if (!additive) this.clear();
      return;
    }
    const entity = entityFromPick(p, this.getTolerance());
    // Clicking the same entity again deselects it.
    const same = this.selection.findIndex((s) => samePick(s.pick, p));
    if (same >= 0) this.selection.splice(same, 1);
    else {
      if (!additive && this.selection.length >= 2) {
        if (this.keepHistory) this.pinCurrent();
        this.selection.length = 0;
      }
      this.selection.push({ pick: p, entity });
    }
    this.update();
  }

  clear() {
    this.selection.length = 0;
    this.result = null;
    this.selected.clear();
    this.clearGraphics();
    for (const f of this.onChange) f();
    this.viewer.requestRender();
  }

  clearHistory() {
    disposeGroup(this.history);
    this.viewer.requestRender();
  }

  private clearGraphics() {
    disposeGroup(this.graphics);
  }

  private update() {
    this.selected.clear();
    this.selection.forEach((s, i) => this.selected.show(s.pick, i === 0 ? COLORS.select : COLORS.selectB));
    const es = this.selection.map((s) => s.entity);
    this.result = es.length === 0 ? null : es.length === 1 ? describe(es[0]) : es.length === 2 ? measurePair(es[0], es[1]) : measureMany(es);
    this.clearGraphics();
    if (this.result) this.drawResult(this.result, this.graphics);
    for (const f of this.onChange) f();
    this.viewer.requestRender();
  }

  private drawResult(r: MResult, group: THREE.Group) {
    const primary = r.rows.find((x) => x.primary);
    if (r.line && primary) {
      const [a, b] = r.line.map((p) => new THREE.Vector3(...p));
      const g = new THREE.BufferGeometry().setFromPoints([a, b]);
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xd0021b, depthTest: false }));
      line.renderOrder = 60;
      group.add(line);
      for (const p of [a, b]) {
        const pg = new THREE.BufferGeometry().setFromPoints([p]);
        const pt = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0xd0021b, size: 7, sizeAttenuation: false, depthTest: false }));
        pt.renderOrder = 61;
        group.add(pt);
      }
      group.add(this.label(primary.label, fmtValue(primary.value, primary.unit), a.clone().lerp(b, 0.5)));
    } else if (primary && this.selection.length) {
      const p = this.selection[this.selection.length - 1].pick.point;
      group.add(this.label(primary.label, fmtValue(primary.value, primary.unit), p.clone()));
    }
    for (const m of r.markers ?? []) {
      const pg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...m)]);
      const pt = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0x0b5bd3, size: 8, sizeAttenuation: false, depthTest: false }));
      pt.renderOrder = 61;
      group.add(pt);
    }
  }

  private label(title: string, value: string, at: THREE.Vector3) {
    const el = document.createElement('div');
    el.className = 'measure-label';
    el.innerHTML = `<span class="ml-title"></span><span class="ml-value"></span>`;
    (el.firstChild as HTMLElement).textContent = title;
    (el.lastChild as HTMLElement).textContent = value;
    const obj = new CSS2DObject(el);
    obj.position.copy(at);
    return obj;
  }

  /** Keep the current dimension on screen while starting a new one. */
  pinCurrent() {
    if (!this.result) return;
    const g = new THREE.Group();
    this.drawResult(this.result, g);
    this.history.add(g);
  }
}

function samePick(a: Pick, b: Pick) {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'face' && b.kind === 'face') return a.owner === b.owner && a.faceIndex === b.faceIndex;
  if (a.kind === 'edge' && b.kind === 'edge') return a.owner === b.owner && a.edgeIndex === b.edgeIndex;
  return a.point.distanceTo(b.point) < 1e-9;
}

function disposeGroup(g: THREE.Group) {
  for (const c of [...g.children]) {
    c.traverse((x) => {
      if (x instanceof CSS2DObject) x.element.remove();
      const m = x as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    });
    c.removeFromParent();
  }
}
