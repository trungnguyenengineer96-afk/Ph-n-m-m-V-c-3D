/**
 * Part modeling session: feature tree, sketch editing, feature dialogs with
 * live preview, regeneration through the geometry worker, save/export.
 */
import * as THREE from 'three';
import type { LoadedModel, Vec3 } from '../core/types';
import type { Pick } from '../viewer/Picker';
import type { Viewer } from '../viewer/Viewer';
import { clear, h, toast } from '../ui/dom';
import { icon } from '../ui/icons';
import { panelShell } from '../ui/panels';
import { exportRemote, regenerateRemote } from './kernelClient';
import { initSolver, setPlanegcsWasmUrl } from './sketchSolver';
import { SketchEditor, TOOL_LABEL, type SketchTool } from './SketchEditor';
import {
  emptySketch,
  STD_PLANES,
  type EndCondition,
  type ExtrudeFeature,
  type Feature,
  type FeatureStatus,
  type FilletFeature,
  type MirrorFeature,
  type PartDocument,
  type PlaneDef,
  type RevolveFeature,
  type ShellFeature,
  type SketchFeature,
  type SkConstraintType,
  type StdPlane,
} from './types';
import planegcsWasm from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url';

setPlanegcsWasmUrl(planegcsWasm);

export interface StudioHost {
  viewer: Viewer;
  /** Replace the displayed geometry of this document. */
  setModel(model: LoadedModel): void;
  setStatus(msg: string): void;
  /** Show a PropertyManager panel (null closes it). */
  showPanel(el: HTMLElement | null): void;
  /** The last face/edge the user clicked in the viewport (for "sketch on face"). */
  lastPick(): Pick | null;
  /** Feature tree / ribbon need re-rendering. */
  refreshUi(): void;
}

type PickMode = { kind: 'edges' | 'faces'; refs: Vec3[]; onChange: () => void } | null;

const RELATION_LABEL: Partial<Record<SkConstraintType, string>> = {
  horizontal: 'Ngang',
  vertical: 'Dọc',
  coincident: 'Trùng điểm',
  parallel: 'Song song',
  perpendicular: 'Vuông góc',
  equal: 'Bằng nhau',
  tangent: 'Tiếp tuyến',
  concentric: 'Đồng tâm',
  onEntity: 'Nằm trên',
  midpoint: 'Trung điểm',
  fix: 'Cố định',
};

export class PartStudio {
  doc: PartDocument;
  status: FeatureStatus[] = [];
  editor: SketchEditor | null = null;
  private editingSketch: SketchFeature | null = null;
  private sketchIsNew = false;
  pickMode: PickMode = null;
  private history: string[] = [];
  private future: string[] = [];
  private regenSeq = 0;
  private previewTimer = 0;
  private selectedPlane: StdPlane | null = null;
  private refMarkers = new THREE.Group();
  /** Feature currently edited in a dialog (excluded from the display while picking). */
  private dialogFeature: Feature | null = null;
  busy = false;

  constructor(private host: StudioHost, doc?: PartDocument) {
    this.doc = doc ?? { format: 'cadviewer-part', version: 1, name: 'Chi tiết 1', features: [] };
    host.viewer.overlay.add(this.refMarkers);
  }

  get name() {
    return this.doc.name;
  }

  dispose() {
    this.editor?.dispose();
    this.editor = null;
    this.refMarkers.removeFromParent();
  }

  // ------------------------------------------------------------------ regeneration
  async regen(features: Feature[] = this.doc.features): Promise<void> {
    const seq = ++this.regenSeq;
    this.busy = true;
    try {
      const res = await regenerateRemote(features, this.doc.name);
      if (seq !== this.regenSeq) return; // a newer regeneration is running
      if (features === this.doc.features) this.status = res.status;
      const failed = res.status.filter((s) => !s.ok);
      const model: LoadedModel = {
        kind: 'part',
        name: this.doc.name,
        root: { name: this.doc.name, bodies: res.body ? [0] : [], children: [] },
        bodies: res.body ? [res.body] : [],
        info: {
          format: 'Chi tiết dựng hình (CAD Viewer 3D)',
          fileName: `${this.doc.name}.cvpart`,
          fileSize: 0,
          properties: { 'Số feature': String(this.doc.features.length) },
          previews: [],
          references: [],
          warnings: failed.map((s) => `${this.featureName(s.id)}: ${s.error}`),
        },
      };
      this.host.setModel(model);
      if (failed.length && features === this.doc.features) this.host.setStatus(`Lỗi tái tạo: ${this.featureName(failed[0].id)} — ${failed[0].error}`);
    } catch (e) {
      toast('Lỗi lõi hình học: ' + (e as Error).message, 'error', 7000);
    } finally {
      if (seq === this.regenSeq) this.busy = false;
      this.host.refreshUi();
    }
  }

  private featureName(id: string) {
    return this.doc.features.find((f) => f.id === id)?.name ?? id;
  }

  private nextName(prefix: string) {
    let n = 1;
    while (this.doc.features.some((f) => f.name === `${prefix}${n}`)) n++;
    return `${prefix}${n}`;
  }
  private newId() {
    return Math.random().toString(36).slice(2, 10);
  }

  private commit(mutate: () => void) {
    this.history.push(JSON.stringify(this.doc.features));
    if (this.history.length > 100) this.history.shift();
    this.future = [];
    mutate();
    this.regen();
  }
  undo() {
    if (this.editor) return this.editor.undo();
    const s = this.history.pop();
    if (!s) return;
    this.future.push(JSON.stringify(this.doc.features));
    this.doc.features = JSON.parse(s);
    this.regen();
  }
  redo() {
    if (this.editor) return this.editor.redo();
    const s = this.future.pop();
    if (!s) return;
    this.history.push(JSON.stringify(this.doc.features));
    this.doc.features = JSON.parse(s);
    this.regen();
  }

  // ------------------------------------------------------------------ sketching
  /** Plane for a new sketch: selected planar face, selected standard plane, or Front. */
  private planeForNewSketch(): PlaneDef {
    const p = this.host.lastPick();
    if (p?.kind === 'face') {
      const n = p.normal.clone().normalize();
      // Use the picked face's plane through the projection of the model origin.
      const d = n.dot(p.point);
      const origin = n.clone().multiplyScalar(d);
      let x = new THREE.Vector3(1, 0, 0);
      if (Math.abs(n.dot(x)) > 0.9) x = new THREE.Vector3(0, 0, -1);
      x.sub(n.clone().multiplyScalar(x.dot(n))).normalize();
      const flat = (v: THREE.Vector3) => v.toArray().map((c) => (Math.abs(c) < 1e-12 ? 0 : c)) as Vec3;
      return { origin: flat(origin), xDir: flat(x), normal: flat(n), label: 'Mặt đã chọn' };
    }
    return STD_PLANES[this.selectedPlane ?? 'front'];
  }

  async newSketch(plane?: PlaneDef) {
    if (this.editor) return;
    const pl = plane ?? this.planeForNewSketch();
    const f: SketchFeature = { id: this.newId(), type: 'sketch', name: this.nextName('Sketch'), plane: pl, sketch: emptySketch() };
    await this.openSketch(f, true);
  }

  async editSketch(id: string) {
    const f = this.doc.features.find((x) => x.id === id);
    if (!f || f.type !== 'sketch' || this.editor) return;
    await this.openSketch(f, false);
  }

  private async openSketch(f: SketchFeature, isNew: boolean) {
    try {
      await initSolver();
    } catch (e) {
      toast('Không tải được bộ giải phác thảo: ' + (e as Error).message, 'error');
      return;
    }
    this.host.showPanel(null);
    this.editingSketch = JSON.parse(JSON.stringify(f));
    this.sketchIsNew = isNew;
    this.editor = new SketchEditor(this.host.viewer, this.editingSketch!.plane, this.editingSketch!.sketch);
    this.editor.onStatus.push((m) => this.host.setStatus(m));
    this.editor.onChange.push(() => this.host.refreshUi());
    this.editor.setTool(isNew ? 'line' : 'select');
    // Look at the sketch plane (SolidWorks: Normal To).
    const n = new THREE.Vector3(...f.plane.normal);
    const x = new THREE.Vector3(...f.plane.xDir);
    const up = new THREE.Vector3().crossVectors(n, x);
    const target = new THREE.Vector3(...f.plane.origin);
    this.host.viewer.alignTo(n, up, new THREE.Box3().setFromCenterAndSize(target, new THREE.Vector3(1, 1, 1).multiplyScalar(this.host.viewer.modelRadius * 2)));
    this.host.refreshUi();
  }

  /** Leave the sketch; save=true keeps the changes. */
  exitSketch(save = true) {
    if (!this.editor || !this.editingSketch) return;
    const f = this.editingSketch;
    this.editor.dispose();
    this.editor = null;
    this.editingSketch = null;
    if (save && f.sketch.entities.length) {
      this.commit(() => {
        const i = this.doc.features.findIndex((x) => x.id === f.id);
        if (i >= 0) this.doc.features[i] = f;
        else this.doc.features.push(f);
      });
    } else this.host.refreshUi();
    this.host.setStatus(save ? `Đã lưu ${f.name}.` : 'Đã huỷ thay đổi sketch.');
  }

  setSketchTool(t: SketchTool) {
    this.editor?.setTool(t);
    this.host.refreshUi();
  }

  // ------------------------------------------------------------------ viewport input
  pointerDown(e: PointerEvent) {
    return this.editor?.pointerDown(e) ?? false;
  }
  pointerMove(e: PointerEvent) {
    this.editor?.pointerMove(e);
  }
  pointerUp(e: PointerEvent) {
    return this.editor?.pointerUp(e) ?? false;
  }
  dblClick() {
    return this.editor?.dblClick() ?? false;
  }
  key(e: KeyboardEvent): boolean {
    if (this.editor) {
      if (this.editor.key(e)) {
        this.host.refreshUi();
        return true;
      }
      if (e.key === 'Escape') {
        this.exitSketch(true);
        return true;
      }
      return false;
    }
    if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) {
      this.undo();
      return true;
    }
    if (e.ctrlKey && (e.key === 'y' || e.key === 'Y')) {
      this.redo();
      return true;
    }
    return false;
  }

  /** Edge/face picking for fillet, chamfer and shell dialogs. */
  handlePick(p: Pick | null): boolean {
    const pm = this.pickMode;
    if (!pm) return false;
    if (!p || p.kind === 'free' || p.kind === 'vertex') return true;
    let ref: Vec3 | null = null;
    if (pm.kind === 'edges' && p.kind === 'edge') {
      const e = p.body.edges[p.edgeIndex];
      const n = e.points.length / 3;
      // An interior polyline vertex lies exactly on the edge (and on no other edge).
      if (n > 2) {
        const k = Math.floor(n / 2);
        ref = [e.points[k * 3], e.points[k * 3 + 1], e.points[k * 3 + 2]];
      } else ref = [0, 1, 2].map((c) => (e.points[c] + e.points[3 + c]) / 2) as Vec3;
    } else if (pm.kind === 'faces' && p.kind === 'face') {
      ref = [p.point.x, p.point.y, p.point.z];
    } else {
      this.host.setStatus(pm.kind === 'edges' ? 'Hãy nhấp vào một cạnh.' : 'Hãy nhấp vào một mặt.');
      return true;
    }
    const near = pm.refs.findIndex((r) => Math.hypot(r[0] - ref![0], r[1] - ref![1], r[2] - ref![2]) < 1e-3);
    if (near >= 0) pm.refs.splice(near, 1);
    else pm.refs.push(ref);
    this.drawRefMarkers(pm.refs);
    pm.onChange();
    return true;
  }

  private drawRefMarkers(refs: Vec3[]) {
    for (const c of [...this.refMarkers.children]) {
      (c as THREE.Points).geometry.dispose();
      c.removeFromParent();
    }
    if (!refs.length) return this.host.viewer.requestRender();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(refs.flat(), 3));
    const pts = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x1e6fe0, size: 11, sizeAttenuation: false, depthTest: false }));
    pts.renderOrder = 90;
    this.refMarkers.add(pts);
    this.host.viewer.requestRender();
  }

  // ------------------------------------------------------------------ feature dialogs
  private sketches(): SketchFeature[] {
    return this.doc.features.filter((f): f is SketchFeature => f.type === 'sketch');
  }

  /** The most recent sketch not consumed by a feature yet. */
  private defaultSketch(): SketchFeature | undefined {
    const used = new Set(this.doc.features.flatMap((f) => (f.type === 'extrude' || f.type === 'revolve' ? [f.sketchId] : [])));
    const list = this.sketches();
    return [...list].reverse().find((s) => !used.has(s.id)) ?? list[list.length - 1];
  }

  /** Features with `f` inserted (new) or replacing its existing version. */
  private withFeature(f: Feature): Feature[] {
    const i = this.doc.features.findIndex((x) => x.id === f.id);
    if (i >= 0) return this.doc.features.map((x, k) => (k === i ? f : x));
    return [...this.doc.features, f];
  }

  private schedulePreview(f: Feature) {
    clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => this.regen(this.withFeature(f)), 180);
  }

  private closeDialog(apply: Feature | null) {
    clearTimeout(this.previewTimer);
    this.pickMode = null;
    this.dialogFeature = null;
    this.drawRefMarkers([]);
    this.host.showPanel(null);
    if (apply) this.commit(() => (this.doc.features = this.withFeature(apply)));
    else this.regen();
  }

  private dialog(title: string, iconName: string, f: Feature, body: HTMLElement[], validate: () => string | null) {
    const ok = h('button', { class: 'btn primary' }, '✓ OK');
    const cancel = h('button', { class: 'btn' }, '✗ Huỷ');
    ok.addEventListener('click', () => {
      const err = validate();
      if (err) return toast(err, 'error');
      this.closeDialog(f);
    });
    cancel.addEventListener('click', () => this.closeDialog(null));
    const panel = panelShell(title, iconName, () => this.closeDialog(null), ...body, h('div', { class: 'btn-row' }, ok, cancel));
    this.host.showPanel(panel);
  }

  private sketchSelect(value: string, onChange: (id: string) => void) {
    const sel = h('select', {}, ...this.sketches().map((s) => h('option', { value: s.id, selected: s.id === value }, s.name))) as HTMLSelectElement;
    sel.addEventListener('change', () => onChange(sel.value));
    return h('div', { class: 'field' }, h('label', {}, 'Sketch biên dạng'), sel);
  }

  private numField(label: string, value: number, onInput: (v: number) => void, step = 1) {
    const input = h('input', { type: 'number', value: String(value), step: String(step) }) as HTMLInputElement;
    input.addEventListener('input', () => {
      const v = Number(input.value);
      if (Number.isFinite(v)) onInput(v);
    });
    return h('div', { class: 'field' }, h('label', {}, label), input);
  }

  extrudeDialog(cut: boolean, existing?: ExtrudeFeature) {
    const sk = existing ? undefined : this.defaultSketch();
    if (!existing && !sk) return toast('Hãy tạo một Sketch có biên dạng kín trước (nút Sketch).', 'info');
    const f: ExtrudeFeature = existing
      ? { ...existing }
      : { id: this.newId(), type: 'extrude', name: this.nextName(cut ? 'Cut-Extrude' : 'Boss-Extrude'), sketchId: sk!.id, cut, end: cut ? 'throughAll' : 'blind', depth: 10, reverse: false };
    const end = h(
      'select',
      {},
      ...(['blind', 'throughAll', 'midPlane'] as EndCondition[]).map((v) =>
        h('option', { value: v, selected: f.end === v }, { blind: 'Chiều sâu (Blind)', throughAll: 'Xuyên suốt (Through All)', midPlane: 'Đối xứng (Mid Plane)' }[v]),
      ),
    ) as HTMLSelectElement;
    const depth = this.numField('Chiều sâu D1 (mm)', f.depth, (v) => {
      f.depth = v;
      this.schedulePreview(f);
    });
    const rev = h('input', { type: 'checkbox', checked: f.reverse }) as HTMLInputElement;
    end.addEventListener('change', () => {
      f.end = end.value as EndCondition;
      depth.hidden = f.end === 'throughAll';
      this.schedulePreview(f);
    });
    depth.hidden = f.end === 'throughAll';
    rev.addEventListener('change', () => {
      f.reverse = rev.checked;
      this.schedulePreview(f);
    });
    this.dialog(
      cut ? 'Cắt Extrude (Cut-Extrude)' : 'Đùn khối (Boss-Extrude)',
      'cube',
      f,
      [
        this.sketchSelect(f.sketchId, (id) => {
          f.sketchId = id;
          this.schedulePreview(f);
        }),
        h('div', { class: 'field' }, h('label', {}, 'Điều kiện kết thúc'), end),
        depth,
        h('label', { class: 'check' }, rev, 'Đảo hướng'),
      ],
      () => (f.end !== 'throughAll' && !(f.depth > 0) ? 'Chiều sâu phải lớn hơn 0' : null),
    );
    this.schedulePreview(f);
  }

  revolveDialog(cut: boolean, existing?: RevolveFeature) {
    const sk = existing ? undefined : this.defaultSketch();
    if (!existing && !sk) return toast('Hãy tạo Sketch có biên dạng kín và một đường tâm (centerline) làm trục.', 'info');
    const f: RevolveFeature = existing ? { ...existing } : { id: this.newId(), type: 'revolve', name: this.nextName(cut ? 'Cut-Revolve' : 'Revolve'), sketchId: sk!.id, cut, angle: 360 };
    this.dialog(
      cut ? 'Cắt xoay (Cut-Revolve)' : 'Xoay khối (Revolve)',
      'cube',
      f,
      [
        this.sketchSelect(f.sketchId, (id) => {
          f.sketchId = id;
          this.schedulePreview(f);
        }),
        this.numField('Góc (°)', f.angle, (v) => {
          f.angle = v;
          this.schedulePreview(f);
        }, 5),
        h('div', { class: 'hint' }, 'Trục xoay: đường tâm (centerline) đầu tiên trong sketch.'),
      ],
      () => (f.angle > 0 ? null : 'Góc phải lớn hơn 0'),
    );
    this.schedulePreview(f);
  }

  filletDialog(kind: 'fillet' | 'chamfer', existing?: FilletFeature) {
    if (!this.doc.features.some((f) => f.type === 'extrude' || f.type === 'revolve')) return toast('Chưa có khối để bo/vát.', 'info');
    const f: FilletFeature = existing ? { ...existing, edges: existing.edges.slice() } : { id: this.newId(), type: kind, name: this.nextName(kind === 'fillet' ? 'Fillet' : 'Chamfer'), size: 2, edges: [] };
    const count = h('div', { class: 'hint' });
    const update = () => (count.textContent = `${f.edges.length} cạnh đã chọn — nhấp cạnh trên mô hình để thêm/bỏ.`);
    this.startPicking('edges', f.edges, update, f);
    update();
    const preview = h('button', { class: 'btn' }, 'Xem trước');
    preview.addEventListener('click', () => this.regen(this.withFeature(f)));
    this.dialog(
      kind === 'fillet' ? 'Bo tròn cạnh (Fillet)' : 'Vát cạnh (Chamfer)',
      'cube',
      f,
      [this.numField(kind === 'fillet' ? 'Bán kính (mm)' : 'Khoảng vát (mm)', f.size, (v) => (f.size = v), 0.5), count, preview],
      () => (!f.edges.length ? 'Chưa chọn cạnh nào' : f.size > 0 ? null : 'Kích thước phải lớn hơn 0'),
    );
  }

  shellDialog(existing?: ShellFeature) {
    if (!this.doc.features.some((f) => f.type === 'extrude' || f.type === 'revolve')) return toast('Chưa có khối để tạo vỏ.', 'info');
    const f: ShellFeature = existing ? { ...existing, faces: existing.faces.slice() } : { id: this.newId(), type: 'shell', name: this.nextName('Shell'), thickness: 1, faces: [] };
    const count = h('div', { class: 'hint' });
    const update = () => (count.textContent = `${f.faces.length} mặt sẽ bị mở — nhấp mặt trên mô hình để chọn.`);
    this.startPicking('faces', f.faces, update, f);
    update();
    const preview = h('button', { class: 'btn' }, 'Xem trước');
    preview.addEventListener('click', () => this.regen(this.withFeature(f)));
    this.dialog('Tạo vỏ (Shell)', 'cube', f, [this.numField('Độ dày (mm)', f.thickness, (v) => (f.thickness = v), 0.5), count, preview], () =>
      !f.faces.length ? 'Chưa chọn mặt' : f.thickness > 0 ? null : 'Độ dày phải lớn hơn 0',
    );
  }

  mirrorDialog(existing?: MirrorFeature) {
    if (!this.doc.features.some((f) => f.type === 'extrude' || f.type === 'revolve')) return toast('Chưa có khối để đối xứng.', 'info');
    const f: MirrorFeature = existing ? { ...existing } : { id: this.newId(), type: 'mirror', name: this.nextName('Mirror'), plane: 'right' };
    const sel = h(
      'select',
      {},
      ...(['front', 'top', 'right'] as StdPlane[]).map((p) => h('option', { value: p, selected: f.plane === p }, STD_PLANES[p].label)),
    ) as HTMLSelectElement;
    sel.addEventListener('change', () => {
      f.plane = sel.value as StdPlane;
      this.schedulePreview(f);
    });
    this.dialog('Đối xứng khối (Mirror)', 'cube', f, [h('div', { class: 'field' }, h('label', {}, 'Mặt đối xứng'), sel)], () => null);
    this.schedulePreview(f);
  }

  /** Show the model before `f` so its references can be picked. */
  private startPicking(kind: 'edges' | 'faces', refs: Vec3[], onChange: () => void, f: Feature) {
    this.dialogFeature = f;
    this.pickMode = { kind, refs, onChange };
    this.drawRefMarkers(refs);
    const i = this.doc.features.findIndex((x) => x.id === f.id);
    this.regen(i >= 0 ? this.doc.features.slice(0, i) : this.doc.features);
  }

  editFeature(id: string) {
    const f = this.doc.features.find((x) => x.id === id);
    if (!f) return;
    if (f.type === 'sketch') return this.editSketch(id);
    if (f.type === 'extrude') return this.extrudeDialog(f.cut, f);
    if (f.type === 'revolve') return this.revolveDialog(f.cut, f);
    if (f.type === 'fillet' || f.type === 'chamfer') return this.filletDialog(f.type, f);
    if (f.type === 'shell') return this.shellDialog(f);
    if (f.type === 'mirror') return this.mirrorDialog(f);
  }

  deleteFeature(id: string) {
    const f = this.doc.features.find((x) => x.id === id);
    if (!f) return;
    const dependents = this.doc.features.filter((x) => (x.type === 'extrude' || x.type === 'revolve') && x.sketchId === id);
    if (dependents.length && !confirm(`Xoá ${f.name} sẽ xoá cả ${dependents.map((d) => d.name).join(', ')}. Tiếp tục?`)) return;
    this.commit(() => {
      const drop = new Set([id, ...dependents.map((d) => d.id)]);
      this.doc.features = this.doc.features.filter((x) => !drop.has(x.id));
    });
  }

  toggleSuppress(id: string) {
    this.commit(() => {
      const f = this.doc.features.find((x) => x.id === id);
      if (f) f.suppressed = !f.suppressed || undefined;
    });
  }

  rename(id: string) {
    const f = this.doc.features.find((x) => x.id === id);
    if (!f) return;
    const n = prompt('Tên mới', f.name);
    if (n && n.trim()) this.commit(() => (f.name = n.trim()));
  }

  // ------------------------------------------------------------------ files
  save() {
    const blob = new Blob([JSON.stringify(this.doc, null, 1)], { type: 'application/json' });
    download(URL.createObjectURL(blob), `${this.doc.name}.cvpart`);
  }

  async exportAs(format: 'step' | 'stl') {
    try {
      const r = await exportRemote(this.doc.features, format);
      download(URL.createObjectURL(new Blob([r.data], { type: format === 'step' ? 'model/step' : 'model/stl' })), `${this.doc.name}.${format === 'step' ? 'step' : 'stl'}`);
      toast(`Đã xuất ${format.toUpperCase()}`, 'ok');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  // ------------------------------------------------------------------ UI
  renderTree(host: HTMLElement) {
    clear(host);
    const list = h('ul', { class: 'tree feature-tree' });
    const row = (label: string, iconName: string, opts: { id?: string; plane?: StdPlane; err?: string; suppressed?: boolean; depth?: number; active?: boolean } = {}) => {
      const r = h(
        'div',
        {
          class: 'tree-row' + (opts.err ? ' error' : '') + (opts.suppressed ? ' is-hidden' : '') + (opts.active ? ' selected' : '') + (opts.plane && this.selectedPlane === opts.plane ? ' selected' : ''),
          style: `padding-left:${(opts.depth ?? 0) * 14 + 6}px`,
          title: opts.err ?? label,
        },
        icon(iconName),
        h('span', { class: 'tree-name' }, label),
        opts.err ? h('span', { class: 'tree-err' }, '⚠') : null,
      );
      if (opts.plane) {
        r.addEventListener('click', () => {
          this.selectedPlane = opts.plane!;
          this.host.setStatus(`${STD_PLANES[opts.plane!].label} đã chọn — bấm "Sketch" để vẽ trên mặt này.`);
          this.host.refreshUi();
        });
        r.addEventListener('dblclick', () => this.newSketch(STD_PLANES[opts.plane!]));
      }
      if (opts.id) {
        const id = opts.id;
        r.addEventListener('dblclick', () => this.editFeature(id));
        r.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          this.featureMenu(id, e.clientX, e.clientY);
        });
      }
      list.append(h('li', {}, r));
    };
    row(this.doc.name, 'part');
    row('Mặt trước (Front Plane)', 'section', { plane: 'front', depth: 1 });
    row('Mặt trên (Top Plane)', 'section', { plane: 'top', depth: 1 });
    row('Mặt phải (Right Plane)', 'section', { plane: 'right', depth: 1 });
    row('Gốc toạ độ (Origin)', 'move', { depth: 1 });
    const consumed = new Set(this.doc.features.flatMap((f) => (f.type === 'extrude' || f.type === 'revolve' ? [f.sketchId] : [])));
    for (const f of this.doc.features) {
      if (f.type === 'sketch' && consumed.has(f.id)) continue;
      const st = this.status.find((s) => s.id === f.id);
      row(f.name, f.type === 'sketch' ? 'drawing' : 'cube', { id: f.id, err: st && !st.ok ? st.error : undefined, suppressed: f.suppressed, depth: 1, active: this.editingSketch?.id === f.id });
      if (f.type === 'extrude' || f.type === 'revolve') {
        const sk = this.doc.features.find((x) => x.id === f.sketchId);
        if (sk) row(sk.name, 'drawing', { id: sk.id, depth: 2, suppressed: sk.suppressed });
      }
    }
    if (this.editingSketch && this.sketchIsNew) row(`${this.editingSketch.name} (đang vẽ)`, 'drawing', { depth: 1, active: true });
    host.append(list);
    host.append(h('div', { class: 'hint tree-hint' }, 'Nhấp đúp feature để sửa · chuột phải để xoá / tắt / đổi tên.'));
  }

  private featureMenu(id: string, x: number, y: number) {
    document.querySelector('.ctx-menu')?.remove();
    const f = this.doc.features.find((q) => q.id === id)!;
    const items: [string, () => void][] = [
      [f.type === 'sketch' ? 'Sửa sketch' : 'Sửa feature', () => this.editFeature(id)],
      [f.suppressed ? 'Bật lại (Unsuppress)' : 'Tạm tắt (Suppress)', () => this.toggleSuppress(id)],
      ['Đổi tên', () => this.rename(id)],
      ['Xoá', () => this.deleteFeature(id)],
    ];
    const menu = h('div', { class: 'ctx-menu', style: `left:${x}px;top:${y}px` }, ...items.map(([t, fn]) => h('button', { onclick: () => { menu.remove(); fn(); } }, t)));
    document.body.append(menu);
    const close = (e: Event) => {
      if (!menu.contains(e.target as Node)) {
        menu.remove();
        document.removeEventListener('pointerdown', close, true);
      }
    };
    setTimeout(() => document.addEventListener('pointerdown', close, true));
  }

  /** CommandManager: Features tab, or Sketch tab while sketching. */
  renderRibbon(host: HTMLElement) {
    clear(host);
    const btn = (label: string, iconName: string, onClick: () => void, opts: { active?: boolean; title?: string; disabled?: boolean } = {}) => {
      const b = h('button', { class: 'mbtn' + (opts.active ? ' active' : ''), title: opts.title ?? label, disabled: opts.disabled }, icon(iconName), h('span', {}, label));
      b.addEventListener('click', onClick);
      return b;
    };
    const group = (...items: HTMLElement[]) => h('div', { class: 'mgroup' }, ...items);
    if (this.editor) {
      const ed = this.editor;
      const t = (tool: SketchTool, label: string, iconName: string) => btn(label, iconName, () => this.setSketchTool(tool), { active: ed.tool === tool, title: TOOL_LABEL[tool] });
      host.append(
        h('span', { class: 'mtab' }, 'Phác thảo'),
        group(btn('Thoát Sketch', 'check', () => this.exitSketch(true), { title: 'Lưu và thoát sketch (Esc)' }), btn('Huỷ', 'close', () => this.exitSketch(false))),
        group(
          t('select', 'Chọn', 'select'),
          t('line', 'Đường', 'line'),
          t('centerline', 'Đường tâm', 'centerline'),
          t('rect', 'Chữ nhật', 'rect'),
          t('circle', 'Tròn', 'circle'),
          t('arc', 'Cung', 'arc'),
          t('dimension', 'Kích thước', 'dimension'),
        ),
        group(
          btn('Dựng hình', 'centerline', () => ed.toggleConstruction(), { title: 'Chuyển đối tượng chọn thành nét dựng hình (construction)' }),
          btn('Xoá', 'trash', () => ed.deleteSelection()),
          btn('Hoàn tác', 'undo', () => ed.undo(), { title: 'Ctrl+Z' }),
        ),
      );
      const rels = ed.applicableRelations();
      const relGroup = group(
        h('span', { class: 'mlabel' }, rels.length ? 'Thêm quan hệ:' : 'Chọn đối tượng (Ctrl+nhấp) để thêm quan hệ'),
        ...rels.map((r) => btn(RELATION_LABEL[r] ?? r, 'relation', () => ed.addRelation(r))),
      );
      host.append(relGroup);
      const st = ed.lastSolve;
      host.append(
        h(
          'span',
          { class: 'sk-state ' + (!st.ok ? 'bad' : st.dof === 0 ? 'full' : 'under') },
          !st.ok ? 'Xung đột ràng buộc' : st.dof === 0 ? 'Đã xác định đủ (Fully Defined)' : st.dof > 0 ? `Chưa xác định đủ (${st.dof} bậc tự do)` : 'Under Defined',
        ),
      );
      return;
    }
    host.append(
      h('span', { class: 'mtab' }, 'Đặc trưng'),
      group(btn('Sketch', 'drawing', () => this.newSketch(), { title: 'Sketch mới trên mặt chọn (mặt phẳng trong cây hoặc mặt phẳng trên mô hình)' })),
      group(
        btn('Đùn khối', 'extrude', () => this.extrudeDialog(false), { title: 'Extruded Boss/Base' }),
        btn('Xoay khối', 'revolve', () => this.revolveDialog(false), { title: 'Revolved Boss/Base' }),
        btn('Cắt đùn', 'cutextrude', () => this.extrudeDialog(true), { title: 'Extruded Cut' }),
        btn('Cắt xoay', 'revolve', () => this.revolveDialog(true), { title: 'Revolved Cut' }),
      ),
      group(
        btn('Bo tròn', 'fillet', () => this.filletDialog('fillet'), { title: 'Fillet' }),
        btn('Vát cạnh', 'chamfer', () => this.filletDialog('chamfer'), { title: 'Chamfer' }),
        btn('Vỏ', 'shell', () => this.shellDialog(), { title: 'Shell' }),
        btn('Đối xứng', 'mirror', () => this.mirrorDialog(), { title: 'Mirror body' }),
      ),
      group(
        btn('Hoàn tác', 'undo', () => this.undo(), { title: 'Ctrl+Z', disabled: !this.history.length }),
        btn('Làm lại', 'redo', () => this.redo(), { title: 'Ctrl+Y', disabled: !this.future.length }),
      ),
      group(
        btn('Lưu .cvpart', 'save', () => this.save()),
        btn('Xuất STEP', 'export', () => this.exportAs('step')),
        btn('Xuất STL', 'export', () => this.exportAs('stl')),
      ),
      this.busy ? h('span', { class: 'sk-state under' }, 'Đang tái tạo…') : h('span'),
    );
  }

  get isPickingRefs() {
    return !!this.pickMode;
  }
  get dialogOpen() {
    return !!this.dialogFeature;
  }
}

function download(url: string, name: string) {
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
