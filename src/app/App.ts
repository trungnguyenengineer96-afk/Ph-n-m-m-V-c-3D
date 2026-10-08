/** Application shell: documents, toolbar, tree, tools and viewport interaction. */
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { LoadedModel, ModelNode } from '../core/types';
import { settings, type LengthUnit } from '../core/units';
import { ACCEPT, isSupported, loadFile, QUALITY } from '../loaders';
import { DocumentView, type BodyMesh, type DisplayMode } from '../viewer/DocumentView';
import { ExplodeManager } from '../viewer/Explode';
import { Picker, type Pick } from '../viewer/Picker';
import { SectionManager } from '../viewer/Section';
import { Viewer, type ViewName } from '../viewer/Viewer';
import { MeasureTool } from '../tools/MeasureTool';
import { faceAreaCached, faceSurface } from '../tools/entities';
import { analyseEdge } from '../core/geometry';
import { fmtArea, fmtLength } from '../core/units';
import { clear, fmtBytes, h, toast } from '../ui/dom';
import { icon } from '../ui/icons';
import { ModelTree } from '../ui/Tree';
import { explodePanel, infoPanel, massPanel, measurePanel, sectionPanel, type PanelContext } from '../ui/panels';
import { mergeAssemblyReferences } from './assemblyLink';

type Tool = 'none' | 'measure' | 'section' | 'explode' | 'mass';

interface Doc {
  id: number;
  model: LoadedModel;
  view: DocumentView;
  camera?: { pos: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3; zoom: number; persp: boolean };
  displayMode: DisplayMode;
}

const BG = '#f4f7fb|#c9d3e0';

export class App {
  readonly viewer: Viewer;
  private docs: Doc[] = [];
  private active: Doc | null = null;
  private nextId = 1;
  private picker: Picker;
  private section: SectionManager;
  private explode: ExplodeManager;
  private measure: MeasureTool;
  private tree: ModelTree;
  private tool: Tool = 'none';
  private selected: ModelNode[] = [];
  private gizmo: TransformControls;
  private dragEnabled = false;
  private facePickResolver: ((p: Pick | null) => void) | null = null;
  private quality = QUALITY.normal;
  private massRefresh: (() => void) | null = null;
  private lastPick: Pick | null = null;

  // DOM
  private el = {
    viewport: document.getElementById('viewport')!,
    tree: document.getElementById('tree')!,
    info: document.getElementById('info')!,
    toolHost: document.getElementById('tool-panel')!,
    docTabs: document.getElementById('doc-tabs')!,
    sheetTabs: document.getElementById('sheet-tabs')!,
    status: document.getElementById('status-msg')!,
    statusSel: document.getElementById('status-sel')!,
    statusUnits: document.getElementById('status-units')!,
    empty: document.getElementById('empty-state')!,
    busy: document.getElementById('busy')!,
    fileInput: document.getElementById('file-input') as HTMLInputElement,
    dirInput: document.getElementById('dir-input') as HTMLInputElement,
  };

  constructor() {
    this.viewer = new Viewer(this.el.viewport);
    this.picker = new Picker(this.viewer, () => this.active?.view ?? null);
    // Rotate and zoom about the model point under the cursor.
    this.viewer.controls.pickPoint = (x, y) => this.picker.raycastFace(x, y)?.point ?? null;
    loadNavSettings(this.viewer);
    this.section = new SectionManager(this.viewer.overlay, () => this.viewer.requestRender());
    this.explode = new ExplodeManager(() => this.viewer.requestRender());
    this.measure = new MeasureTool(this.viewer, this.picker, () => this.active?.view.tolerance ?? 0.001);
    this.section.onChange.push((planes) => {
      this.picker.planes = planes;
      this.measure.setClipping(planes);
    });
    this.tree = new ModelTree(this.el.tree, {
      onSelect: (n, add) => this.selectNodes(n ? [n] : [], add),
      onToggleVisible: (n, v) => this.setVisible(n, v),
      onZoom: (n) => this.zoomTo(n),
      onContext: (n, x, y) => this.contextMenu(n, x, y),
    });
    this.tree.render(null);

    this.gizmo = new TransformControls(this.viewer.camera, this.viewer.renderer.domElement);
    this.gizmo.setSize(0.8);
    this.gizmo.addEventListener('dragging-changed', (e) => (this.viewer.controls.enabled = !(e as unknown as { value: boolean }).value));
    this.gizmo.addEventListener('objectChange', () => {
      if (this.gizmo.object) this.explode.syncManual(this.gizmo.object);
      this.viewer.requestRender();
    });
    this.gizmo.addEventListener('change', () => this.viewer.requestRender());
    this.viewer.scene.add(this.gizmo.getHelper());
    window.addEventListener('cad-texture-loaded', () => this.viewer.requestRender());

    this.el.fileInput.accept = ACCEPT;
    this.el.fileInput.addEventListener('change', () => {
      if (this.el.fileInput.files?.length) this.openFiles([...this.el.fileInput.files]);
      this.el.fileInput.value = '';
    });
    this.el.dirInput.addEventListener('change', () => {
      if (this.el.dirInput.files?.length) this.openFiles([...this.el.dirInput.files].filter((f) => isSupported(f.name)));
      this.el.dirInput.value = '';
    });
    this.bindToolbar();
    this.bindViewport();
    this.bindDragDrop();
    this.bindKeys();
    this.updateStatusUnits();
    this.setStatus('Sẵn sàng. Mở tệp STEP, SLDPRT, SLDASM, SLDDRW, DXF… hoặc kéo thả vào cửa sổ.');
  }

  // ======================= documents =======================
  async openFiles(files: File[]) {
    const supported = files.filter((f) => isSupported(f.name));
    const skipped = files.length - supported.length;
    if (skipped) toast(`Bỏ qua ${skipped} tệp không hỗ trợ`, 'info');
    if (!supported.length) return;
    this.busy(true, `Đang đọc ${supported.length} tệp…`);
    const loaded: { file: File; model: LoadedModel }[] = [];
    for (const f of supported) {
      try {
        this.busy(true, `Đang đọc ${f.name} (${fmtBytes(f.size)})…`);
        const t0 = performance.now();
        const model = await loadFile(f, this.quality);
        loaded.push({ file: f, model });
        this.setStatus(`Đã đọc ${f.name} trong ${((performance.now() - t0) / 1000).toFixed(2)} s`);
      } catch (e) {
        console.error(e);
        toast(`Lỗi đọc ${f.name}: ${(e as Error).message}`, 'error', 7000);
      }
    }
    // Link SolidWorks assemblies with part files opened together.
    const consumed = mergeAssemblyReferences(loaded.map((l) => l.model));
    for (const l of loaded) if (!consumed.has(l.model)) this.addDocument(l.model);
    this.busy(false);
  }

  addDocument(model: LoadedModel) {
    const view = new DocumentView(model);
    const doc: Doc = { id: this.nextId++, model, view, displayMode: model.is2D ? 'shaded' : 'shaded-edges' };
    this.docs.push(doc);
    this.activate(doc, true);
    for (const w of model.info.warnings.slice(0, 3)) toast(w, 'info', 8000);
  }

  private activate(doc: Doc | null, fresh = false) {
    if (this.active === doc && !fresh) return;
    this.setTool('none');
    if (this.active) {
      const c = this.viewer.camera;
      this.active.camera = {
        pos: c.position.clone(),
        target: this.viewer.controls.target.clone(),
        up: c.up.clone(),
        zoom: this.viewer.ortho.zoom,
        persp: c === this.viewer.persp,
      };
      this.explode.reset();
      this.viewer.modelRoot.remove(this.active.view.root);
    }
    this.active = doc;
    this.selected = [];
    this.section.attach(null);
    this.explode.attach(null);
    if (!doc) {
      this.tree.render(null);
      clear(this.el.info);
      this.el.info.append(infoPanel(null));
      this.el.empty.hidden = false;
      this.renderDocTabs();
      this.renderSheetTabs();
      this.viewer.requestRender();
      return;
    }
    this.el.empty.hidden = true;
    this.viewer.modelRoot.add(doc.view.root);
    doc.view.setDisplayMode(doc.displayMode);
    this.section.attach(doc.view);
    this.section.setActive(false);
    this.explode.attach(doc.view);
    const box = doc.view.bounds(false);
    this.viewer.setModelBounds(box);
    this.viewer.set2DMode(doc.view.is2D);
    if (doc.camera && !fresh) {
      this.viewer.setPerspective(doc.camera.persp);
      const c = this.viewer.camera;
      c.position.copy(doc.camera.pos);
      c.up.copy(doc.camera.up);
      this.viewer.controls.target.copy(doc.camera.target);
      this.viewer.ortho.zoom = doc.camera.zoom;
      this.viewer.ortho.updateProjectionMatrix();
      this.viewer.controls.update();
    } else if (doc.view.is2D) {
      this.viewer.setPerspective(false);
      this.viewer.setView('front', box);
    } else this.viewer.setView('iso', box);
    this.tree.render(doc.model);
    clear(this.el.info);
    this.el.info.append(infoPanel(doc.model));
    this.renderDocTabs();
    this.renderSheetTabs();
    this.syncDisplayButtons();
    this.viewer.requestRender();
  }

  private closeDocument(doc: Doc) {
    const i = this.docs.indexOf(doc);
    if (i < 0) return;
    if (this.active === doc) {
      this.setTool('none');
      this.explode.reset();
      this.section.attach(null);
      this.viewer.modelRoot.remove(doc.view.root);
      this.active = null;
    }
    doc.view.dispose();
    this.docs.splice(i, 1);
    this.activate(this.docs[Math.min(i, this.docs.length - 1)] ?? null, true);
  }

  private renderDocTabs() {
    clear(this.el.docTabs);
    for (const d of this.docs) {
      const kindIcon = d.model.kind === 'assembly' ? 'assembly' : d.model.kind === 'drawing' ? 'drawing' : 'part';
      const tab = h(
        'div',
        { class: 'doc-tab' + (d === this.active ? ' active' : ''), title: d.model.info.fileName },
        icon(kindIcon),
        h('span', {}, d.model.info.fileName),
        h('button', { class: 'icon-btn small', title: 'Đóng', onclick: (e: Event) => { e.stopPropagation(); this.closeDocument(d); } }, icon('close')),
      );
      tab.addEventListener('click', () => this.activate(d));
      this.el.docTabs.append(tab);
    }
  }

  /** Sheet tabs along the bottom of the viewport for multi-sheet drawings. */
  private renderSheetTabs() {
    const host = this.el.sheetTabs;
    clear(host);
    const view = this.active?.view;
    const n = view?.sheetObjects.length ?? 0;
    host.hidden = n < 2;
    if (!view || n < 2) return;
    view.sheetObjects.forEach((m, i) => {
      const b = h('button', { class: 'sheet-tab' + (i === view.activeSheet ? ' active' : ''), title: m.name }, m.name);
      b.addEventListener('click', () => this.showSheet(i));
      host.append(b);
    });
  }

  private showSheet(i: number) {
    const view = this.active?.view;
    if (!view || !view.sheetObjects.length) return;
    view.setSheet(i);
    this.el.sheetTabs.querySelectorAll('.sheet-tab').forEach((b, k) => b.classList.toggle('active', k === view.activeSheet));
    this.el.sheetTabs.querySelectorAll('.sheet-tab')[view.activeSheet]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.viewer.fit(view.bounds(), false);
    this.setStatus(`${view.sheetObjects[view.activeSheet].name} (${view.activeSheet + 1}/${view.sheetObjects.length})`);
  }

  // ======================= tools =======================
  private panelContext(): PanelContext {
    return {
      viewer: this.viewer,
      doc: () => this.active?.view ?? null,
      section: this.section,
      explode: this.explode,
      measure: this.measure,
      selectedNodes: () => this.selected,
      pickPlanarFace: (prompt) => this.pickPlanarFace(prompt),
      setDragMode: (on) => this.setDragMode(on),
      dragMode: () => this.dragEnabled,
      closeTool: () => this.setTool('none'),
    };
  }

  setTool(tool: Tool) {
    if (tool !== 'none' && !this.active) {
      toast('Hãy mở một tệp trước', 'info');
      return;
    }
    // Toggling the active tool closes it.
    if (tool === this.tool && tool !== 'none') tool = 'none';
    const prev = this.tool;
    if (prev === 'measure') this.measure.setActive(false);
    // A section stays active after its panel closes (as in SolidWorks); the HUD button turns it off.
    if (prev === 'explode') this.setDragMode(false);
    this.massRefresh = null;
    this.tool = tool;
    clear(this.el.toolHost);
    this.el.toolHost.hidden = tool === 'none';
    const ctx = this.panelContext();
    if (tool === 'measure') {
      this.measure.setActive(true);
      this.el.toolHost.append(measurePanel(ctx));
      this.setStatus('Đo: nhấp vào đỉnh / cạnh / mặt. Ctrl + nhấp để chọn thêm. Esc để thoát.');
    } else if (tool === 'section') {
      if (!this.section.active) this.section.setActive(true);
      this.el.toolHost.append(sectionPanel(ctx));
      this.setStatus('Mặt cắt: kéo thanh trượt để di chuyển mặt cắt.');
    } else if (tool === 'explode') {
      this.el.toolHost.append(explodePanel(ctx));
      this.setStatus('Tách rời: kéo thanh trượt hoặc bật chế độ kéo thả chi tiết.');
    } else if (tool === 'mass') {
      const p = massPanel(ctx);
      this.massRefresh = p.refresh;
      this.el.toolHost.append(p.el);
    } else this.setStatus('Sẵn sàng.');
    document.querySelectorAll<HTMLElement>('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    this.syncDisplayButtons();
    this.viewer.requestRender();
  }

  private toggleSection() {
    if (!this.active) return;
    const on = !this.section.active;
    this.section.setActive(on);
    if (on && this.tool !== 'section') this.setTool('section');
    if (!on && this.tool === 'section') this.setTool('none');
    this.syncDisplayButtons();
  }

  private setDragMode(on: boolean) {
    this.dragEnabled = on;
    if (!on) this.gizmo.detach();
    else if (this.selected.length) this.attachGizmo();
    this.viewer.requestRender();
  }

  private attachGizmo() {
    const doc = this.active?.view;
    if (!doc || !this.dragEnabled || !this.selected.length) return;
    const obj = doc.nodeObjects.get(this.selected[0]);
    const unit = obj ? this.explode.unitOf(obj.children.find((c) => (c as BodyMesh).userData?.cad) ?? obj) ?? this.explode.unitOf(obj) : null;
    if (unit) {
      this.gizmo.camera = this.viewer.camera;
      this.gizmo.attach(unit);
    } else toast('Thành phần này không phải đơn vị tách ở mức hiện tại', 'info');
  }

  private pickPlanarFace(prompt: string): Promise<{ normal: THREE.Vector3; point: THREE.Vector3 } | null> {
    this.setStatus(prompt + ' (Esc để huỷ)');
    toast(prompt, 'info', 2500);
    return new Promise((resolve) => {
      this.facePickResolver = (p) => {
        this.facePickResolver = null;
        if (!p || p.kind !== 'face') return resolve(null);
        const s = faceSurface(p.body, p.body.faces[p.faceIndex], this.active!.view.tolerance);
        if (s.kind !== 'plane' || !s.axis) {
          toast('Mặt được chọn không phải mặt phẳng', 'error');
          return resolve(null);
        }
        const n = new THREE.Vector3(...s.axis).transformDirection(p.owner.matrixWorld);
        if (n.dot(p.normal) < 0) n.negate();
        resolve({ normal: n, point: p.point.clone() });
      };
    });
  }

  // ======================= selection & visibility =======================
  private selectNodes(nodes: ModelNode[], additive: boolean) {
    if (additive) {
      const set = new Set(this.selected);
      for (const n of nodes) set.has(n) ? set.delete(n) : set.add(n);
      this.selected = [...set];
    } else this.selected = nodes;
    this.tree.setSelection(this.selected);
    this.active?.view.setComponentHighlight(this.selected);
    this.el.statusSel.textContent = this.selected.length ? `Đã chọn: ${this.selected.map((n) => n.name).join(', ')}` : '';
    if (this.dragEnabled) {
      this.gizmo.detach();
      this.attachGizmo();
    }
    this.massRefresh?.();
    this.viewer.requestRender();
  }

  private setVisible(node: ModelNode, visible: boolean) {
    this.active?.view.setNodeVisible(node, visible);
    this.tree.setVisible(node, visible);
    this.viewer.requestRender();
  }

  private isolate(node: ModelNode) {
    const doc = this.active;
    if (!doc) return;
    const keep = new Set<ModelNode>();
    // Keep the node, its ancestors and descendants visible.
    const path: ModelNode[] = [];
    const find = (n: ModelNode): boolean => {
      path.push(n);
      if (n === node) return true;
      for (const c of n.children) if (find(c)) return true;
      path.pop();
      return false;
    };
    find(doc.model.root);
    path.forEach((n) => keep.add(n));
    const walk = (n: ModelNode, inside: boolean) => {
      const vis = inside || keep.has(n);
      this.setVisible(n, vis);
      for (const c of n.children) walk(c, inside || n === node);
    };
    walk(doc.model.root, false);
    this.zoomTo(node);
  }

  private showAll() {
    const doc = this.active;
    if (!doc) return;
    const walk = (n: ModelNode) => {
      this.setVisible(n, true);
      n.children.forEach(walk);
    };
    walk(doc.model.root);
  }

  private zoomTo(node: ModelNode) {
    const doc = this.active?.view;
    if (!doc) return;
    const obj = doc.nodeObjects.get(node);
    if (!obj) return;
    const box = new THREE.Box3();
    for (const m of doc.meshesOf(node)) box.union(new THREE.Box3().setFromObject(m));
    if (box.isEmpty()) box.setFromObject(obj);
    this.viewer.fit(box);
  }

  private contextMenu(node: ModelNode | null, x: number, y: number, pick?: Pick | null) {
    document.querySelector('.ctx-menu')?.remove();
    const items: [string, () => void][] = [];
    if (node) {
      const hidden = this.tree.isHidden(node);
      items.push([hidden ? 'Hiện' : 'Ẩn  (H)', () => this.setVisible(node, hidden)]);
      items.push(['Cô lập (Isolate)', () => this.isolate(node)]);
      items.push(['Phóng tới', () => this.zoomTo(node)]);
      items.push(['Trong suốt / Đục', () => this.toggleTransparency(node)]);
    }
    if (pick?.kind === 'face') items.push(['Nhìn vuông góc (Normal To)', () => this.normalToPick(pick)]);
    items.push(['Hiện tất cả', () => this.showAll()]);
    items.push(['Vừa màn hình (F)', () => this.fitAll()]);
    const menu = h('div', { class: 'ctx-menu', style: `left:${x}px;top:${y}px` }, ...items.map(([t, f]) => h('button', { onclick: () => { menu.remove(); f(); } }, t)));
    document.body.append(menu);
    const close = (e: Event) => {
      if (!menu.contains(e.target as Node)) {
        menu.remove();
        document.removeEventListener('pointerdown', close, true);
      }
    };
    setTimeout(() => document.addEventListener('pointerdown', close, true));
  }

  private toggleTransparency(node: ModelNode) {
    for (const m of this.active?.view.meshesOf(node) ?? []) {
      const mat = m.userData.cad.shadedMaterial;
      const on = !(mat.userData.ghost as boolean);
      mat.userData.ghost = on;
      mat.transparent = on;
      mat.opacity = on ? 0.3 : 1;
      mat.depthWrite = !on;
      mat.needsUpdate = true;
    }
    this.viewer.requestRender();
  }

  private normalToPick(p: Pick) {
    if (p.kind !== 'face') return;
    const s = faceSurface(p.body, p.body.faces[p.faceIndex], this.active!.view.tolerance);
    let n = p.normal.clone();
    if (s.kind === 'plane' && s.axis) {
      n = new THREE.Vector3(...s.axis).transformDirection(p.owner.matrixWorld);
      if (n.dot(p.normal) < 0) n.negate();
    }
    this.viewer.normalTo(n, p.point);
  }

  fitAll() {
    if (this.active) this.viewer.fit(this.active.view.bounds(true));
  }

  // ======================= viewport interaction =======================
  private bindViewport() {
    const canvas = this.viewer.renderer.domElement;
    let down: { x: number; y: number; button: number; t: number } | null = null;
    let hoverQueued: { x: number; y: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, button: e.button, t: performance.now() };
    });
    canvas.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4;
      const button = down.button;
      down = null;
      if (moved || (this.gizmo as unknown as { dragging: boolean }).dragging) return;
      if (button === 0) this.onClick(e);
      else if (button === 2) {
        const p = this.picker.pick(e.clientX, e.clientY, { faces: true });
        const node = p && p.kind !== 'free' ? this.nodeOfPick(p) : null;
        this.contextMenu(node, e.clientX, e.clientY, p);
      }
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointermove', (e) => {
      if (down) return;
      if (!hoverQueued)
        requestAnimationFrame(() => {
          const q = hoverQueued;
          hoverQueued = null;
          if (q) this.onHover(q.x, q.y);
        });
      hoverQueued = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener('dblclick', (e) => {
      if (this.tool === 'measure') return;
      const p = this.picker.pick(e.clientX, e.clientY, { faces: true });
      if (p?.kind === 'face') this.normalToPick(p);
    });
  }

  private nodeOfPick(p: Pick): ModelNode | null {
    if (p.kind === 'free') return null;
    const doc = this.active?.view;
    if (!doc) return null;
    let o: THREE.Object3D | null = p.owner;
    while (o) {
      const n = doc.objectNodes.get(o);
      if (n) return n;
      o = o.parent;
    }
    return null;
  }

  private onHover(x: number, y: number) {
    if (this.tool === 'measure' || this.facePickResolver) {
      this.measure.active ? this.measure.onHover(x, y) : null;
      if (this.facePickResolver) this.viewer.renderer.domElement.style.cursor = 'pointer';
      return;
    }
    this.viewer.renderer.domElement.style.cursor = 'default';
  }

  private onClick(e: PointerEvent) {
    if (this.facePickResolver) {
      this.facePickResolver(this.picker.pick(e.clientX, e.clientY, { faces: true }));
      return;
    }
    if (this.tool === 'measure') {
      this.measure.onClick(e.clientX, e.clientY, e.ctrlKey || e.metaKey || e.shiftKey);
      return;
    }
    const p = this.picker.pick(e.clientX, e.clientY, { faces: true, edges: true, vertices: true });
    this.lastPick = p;
    if (!p || p.kind === 'free') {
      if (!(e.ctrlKey || e.shiftKey)) this.selectNodes([], false);
      return;
    }
    const node = this.nodeOfPick(p);
    if (node) this.selectNodes([node], e.ctrlKey || e.metaKey || e.shiftKey);
    this.setStatus(this.quickInfo(p));
  }

  /** SolidWorks shows a quick measurement of the clicked entity in the status bar. */
  private quickInfo(p: Pick): string {
    const tol = this.active?.view.tolerance ?? 0.001;
    if (p.kind === 'face') {
      const f = p.body.faces[p.faceIndex];
      const s = faceSurface(p.body, f, tol);
      const parts = [`Mặt: diện tích ${fmtArea(faceAreaCached(p.body, f))}`];
      if (s.radius !== undefined && (s.kind === 'cylinder' || s.kind === 'sphere')) parts.push(`Ø ${fmtLength(2 * s.radius)}`);
      return parts.join(' — ');
    }
    if (p.kind === 'edge') {
      const e = analyseEdge(p.body.edges[p.edgeIndex], tol);
      if (e.radius !== undefined && (e.kind === 'circle' || e.kind === 'arc')) return `Cạnh tròn: Ø ${fmtLength(2 * e.radius)}, chiều dài ${fmtLength(e.length ?? 0)}`;
      return `Cạnh: chiều dài ${fmtLength(e.length ?? 0)}`;
    }
    if (p.kind === 'vertex') return `Đỉnh: (${[p.point.x, p.point.y, p.point.z].map((v) => fmtLength(v)).join(', ')})`;
    return '';
  }

  // ======================= toolbar =======================
  private bindToolbar() {
    const on = (id: string, f: () => void) => document.getElementById(id)?.addEventListener('click', f);
    on('btn-open', () => this.el.fileInput.click());
    on('btn-open-dir', () => this.el.dirInput.click());
    on('btn-empty-open', () => this.el.fileInput.click());
    on('btn-shot', () => this.screenshot());
    on('btn-export-stl', () => this.exportModel('stl'));
    on('btn-export-glb', () => this.exportModel('glb'));
    on('btn-settings', () => this.settingsDialog());
    on('btn-help', () => this.helpDialog());
    on('hud-fit', () => this.fitAll());
    on('hud-section', () => this.toggleSection());
    on('hud-persp', () => {
      this.viewer.setPerspective(this.viewer.camera !== this.viewer.persp);
      this.gizmo.camera = this.viewer.camera;
      this.syncDisplayButtons();
    });
    document.querySelectorAll<HTMLElement>('[data-tool]').forEach((b) => b.addEventListener('click', () => this.setTool(b.dataset.tool as Tool)));
    document.querySelectorAll<HTMLElement>('[data-view]').forEach((b) =>
      b.addEventListener('click', () => {
        const v = b.dataset.view as ViewName | 'normal';
        if (v === 'normal') this.normalToSelection();
        else if (this.active) this.viewer.setView(v, this.active.view.bounds(true));
        b.closest('details')?.removeAttribute('open');
      }),
    );
    document.querySelectorAll<HTMLElement>('[data-display]').forEach((b) =>
      b.addEventListener('click', () => {
        if (!this.active) return;
        this.active.displayMode = b.dataset.display as DisplayMode;
        this.active.view.setDisplayMode(this.active.displayMode);
        this.syncDisplayButtons();
        b.closest('details')?.removeAttribute('open');
        this.viewer.requestRender();
      }),
    );
    document.querySelectorAll<HTMLElement>('[data-sample]').forEach((b) =>
      b.addEventListener('click', async () => {
        b.closest('details')?.removeAttribute('open');
        const names = b.dataset.sample!.split(',');
        this.busy(true, 'Đang tải tệp mẫu…');
        try {
          const files = await Promise.all(
            names.map(async (n) => {
              const r = await fetch(`${import.meta.env.BASE_URL}samples/${encodeURIComponent(n)}`);
              if (!r.ok) throw new Error(`Không tải được ${n}`);
              return new File([await r.arrayBuffer()], n);
            }),
          );
          await this.openFiles(files);
        } catch (e) {
          toast((e as Error).message, 'error');
        } finally {
          this.busy(false);
        }
      }),
    );
    // Close <details> menus when clicking elsewhere.
    document.addEventListener('click', (e) => {
      document.querySelectorAll('details.menu[open]').forEach((d) => {
        if (!d.contains(e.target as Node)) d.removeAttribute('open');
      });
    });
    // Left panel tabs
    document.querySelectorAll<HTMLElement>('[data-tab]').forEach((t) =>
      t.addEventListener('click', () => {
        document.querySelectorAll<HTMLElement>('[data-tab]').forEach((x) => x.classList.toggle('active', x === t));
        document.querySelectorAll<HTMLElement>('[data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== t.dataset.tab));
      }),
    );
  }

  private normalToSelection() {
    if (this.lastPick?.kind === 'face') this.normalToPick(this.lastPick);
    else toast('Hãy nhấp chọn một mặt trước, rồi bấm Normal To (phím 8)', 'info');
  }

  private syncDisplayButtons() {
    const mode = this.active?.displayMode;
    document.querySelectorAll<HTMLElement>('[data-display]').forEach((b) => b.classList.toggle('active', b.dataset.display === mode));
    document.getElementById('hud-section')?.classList.toggle('active', this.section.active);
    document.getElementById('hud-persp')?.classList.toggle('active', this.viewer.camera === this.viewer.persp);
  }

  private bindDragDrop() {
    const overlay = document.getElementById('drop-overlay')!;
    let depth = 0;
    window.addEventListener('dragenter', (e) => {
      e.preventDefault();
      depth++;
      overlay.hidden = false;
    });
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) overlay.hidden = true;
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      depth = 0;
      overlay.hidden = true;
      const items = e.dataTransfer?.items;
      const files: File[] = [];
      if (items && items.length && 'webkitGetAsEntry' in items[0]) {
        const entries = [...items].map((i) => i.webkitGetAsEntry()).filter(Boolean) as FileSystemEntry[];
        for (const en of entries) files.push(...(await readEntry(en)));
      } else if (e.dataTransfer?.files) files.push(...e.dataTransfer.files);
      this.openFiles(files);
    });
  }

  private bindKeys() {
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      if (e.ctrlKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        this.el.fileInput.click();
        return;
      }
      if (e.key.startsWith('Arrow') && this.active && !this.viewer.is2D && !e.ctrlKey && !e.metaKey) {
        // SolidWorks: arrows rotate 15° (Shift: 90°), Alt + ←/→ rolls the view.
        e.preventDefault();
        const step = e.shiftKey ? 90 : 15;
        const c = this.viewer.controls;
        if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) c.rollBy(e.key === 'ArrowLeft' ? step : -step);
        else if (e.key === 'ArrowLeft') c.rotateBy(-step, 0);
        else if (e.key === 'ArrowRight') c.rotateBy(step, 0);
        else if (e.key === 'ArrowUp') c.rotateBy(0, -step);
        else if (e.key === 'ArrowDown') c.rotateBy(0, step);
        return;
      }
      if ((e.key === 'PageDown' || e.key === 'PageUp') && this.active?.view.sheetObjects.length) {
        e.preventDefault();
        this.showSheet(this.active.view.activeSheet + (e.key === 'PageDown' ? 1 : -1));
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const box = this.active?.view.bounds(true) ?? null;
      const views: Record<string, ViewName> = { '1': 'front', '2': 'back', '3': 'left', '4': 'right', '5': 'top', '6': 'bottom', '7': 'iso' };
      if (views[e.key] && this.active && !this.viewer.is2D) this.viewer.setView(views[e.key], box);
      else if (e.key === '8') this.normalToSelection();
      else if (e.key === 'f' || e.key === 'F') this.fitAll();
      else if (e.key === 'm' || e.key === 'M') this.setTool('measure');
      else if (e.key === 's' || e.key === 'S') this.toggleSection();
      else if (e.key === 'e' || e.key === 'E') this.setTool('explode');
      else if (e.key === 'p' || e.key === 'P') document.getElementById('hud-persp')?.click();
      else if (e.key === 'h') this.selected.forEach((n) => this.setVisible(n, false));
      else if (e.key === 'H') this.showAll();
      else if (e.key === 't' || e.key === 'T') this.gizmo.setMode('translate');
      else if (e.key === 'r' || e.key === 'R') this.gizmo.setMode(this.gizmo.mode === 'rotate' ? 'translate' : 'rotate');
      else if (e.key === 'Escape') {
        if (this.facePickResolver) this.facePickResolver(null);
        else if (this.tool !== 'none') this.setTool('none');
        else this.selectNodes([], false);
      } else if (e.key === 'Delete' && this.tool === 'measure') this.measure.clear();
    });
  }

  // ======================= export =======================
  private screenshot() {
    if (!this.active) return;
    const url = this.viewer.screenshot(BG);
    download(url, `${this.active.model.name}.png`);
  }

  private async exportModel(kind: 'stl' | 'glb') {
    const doc = this.active?.view;
    if (!doc || !doc.meshes.length) {
      toast('Không có mô hình 3D để xuất', 'info');
      return;
    }
    const group = new THREE.Group();
    for (const m of doc.meshes) {
      if (!doc.isEffectivelyVisible(m)) continue;
      const c = new THREE.Mesh(m.geometry, m.userData.cad.shadedMaterial);
      c.name = m.name;
      c.matrixAutoUpdate = false;
      c.matrix.copy(m.matrixWorld);
      group.add(c);
    }
    group.updateMatrixWorld(true);
    if (kind === 'stl') {
      const { STLExporter } = await import('three/examples/jsm/exporters/STLExporter.js');
      const data = new STLExporter().parse(group, { binary: true }) as DataView;
      download(URL.createObjectURL(new Blob([data.buffer as ArrayBuffer], { type: 'model/stl' })), `${this.active!.model.name}.stl`);
    } else {
      const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
      // glTF uses metres.
      const root = new THREE.Group();
      root.scale.setScalar(0.001);
      root.add(group);
      const glb = (await new GLTFExporter().parseAsync(root, { binary: true })) as ArrayBuffer;
      download(URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' })), `${this.active!.model.name}.glb`);
    }
    toast('Đã xuất tệp (theo trạng thái hiển thị hiện tại)', 'ok');
  }

  // ======================= dialogs =======================
  private settingsDialog() {
    const unit = h('select', {}, ...(['mm', 'cm', 'm', 'in'] as LengthUnit[]).map((u) => h('option', { value: u, selected: settings.length === u }, u))) as HTMLSelectElement;
    const dec = h('input', { type: 'number', min: '0', max: '8', value: String(settings.decimals), class: 'num' }) as HTMLInputElement;
    const q = h(
      'select',
      {},
      h('option', { value: 'low' }, 'Thấp (nhanh)'),
      h('option', { value: 'normal' }, 'Trung bình'),
      h('option', { value: 'high' }, 'Cao (mịn, chậm)'),
    ) as HTMLSelectElement;
    q.value = Object.entries(QUALITY).find(([, v]) => v === this.quality)?.[0] ?? 'normal';
    const c = this.viewer.controls;
    const style = h(
      'select',
      {},
      h('option', { value: 'free', selected: c.rotateStyle === 'free' }, 'Tự do quanh điểm con trỏ (như SolidWorks)'),
      h('option', { value: 'turntable', selected: c.rotateStyle === 'turntable' }, 'Bàn xoay — giữ trục Y thẳng đứng'),
    ) as HTMLSelectElement;
    const speed = h('input', { type: 'number', min: '0.1', max: '2', step: '0.05', value: String(c.rotateSpeed), class: 'num' }) as HTMLInputElement;
    const invert = h('input', { type: 'checkbox' }) as HTMLInputElement;
    invert.checked = c.invertWheel;
    const dlg = modal(
      'Cài đặt',
      h('div', { class: 'field' }, h('label', {}, 'Đơn vị chiều dài hiển thị'), unit),
      h('div', { class: 'field' }, h('label', {}, 'Số chữ số thập phân'), dec),
      h('div', { class: 'field' }, h('label', {}, 'Độ mịn lưới khi đọc STEP/IGES'), q),
      h('div', { class: 'hint' }, 'Độ mịn áp dụng cho tệp mở sau khi thay đổi.'),
      h('div', { class: 'field' }, h('label', {}, 'Kiểu xoay'), style),
      h('div', { class: 'field' }, h('label', {}, 'Tốc độ xoay (độ / pixel)'), speed),
      h('label', { class: 'check' }, invert, 'Đảo chiều con lăn khi phóng to'),
    );
    dlg.onClose = () => {
      settings.length = unit.value as LengthUnit;
      settings.decimals = Math.max(0, Math.min(8, Number(dec.value) || 3));
      this.quality = QUALITY[q.value];
      c.rotateStyle = style.value as 'free' | 'turntable';
      c.rotateSpeed = Math.max(0.05, Math.min(3, Number(speed.value) || 0.4));
      c.invertWheel = invert.checked;
      saveNavSettings(this.viewer);
      this.updateStatusUnits();
      if (this.measure.selection.length) this.measure.onChange.forEach((f) => f());
    };
  }

  private helpDialog() {
    const rows: [string, string][] = [
      ['Chuột trái kéo / chuột giữa kéo', 'Xoay quanh điểm dưới con trỏ'],
      ['Chuột phải kéo / Ctrl + chuột giữa', 'Di chuyển (pan)'],
      ['Con lăn / Shift + chuột giữa', 'Phóng to / thu nhỏ tại con trỏ'],
      ['← → ↑ ↓ (Shift: 90°)', 'Xoay 15°'],
      ['Alt + ← →', 'Xoay quanh hướng nhìn (roll)'],
      ['Nhấp đúp vào mặt', 'Nhìn vuông góc mặt (Normal To)'],
      ['Chuột phải (không kéo)', 'Menu: Ẩn / Cô lập / Trong suốt…'],
      ['F', 'Vừa màn hình (Zoom to fit)'],
      ['1…7', 'Trước, Sau, Trái, Phải, Trên, Dưới, Isometric'],
      ['8', 'Normal To mặt đã chọn'],
      ['P', 'Bật/tắt phối cảnh (perspective)'],
      ['M / S / E', 'Đo / Mặt cắt / Tách rời'],
      ['h / Shift+H', 'Ẩn thành phần chọn / Hiện tất cả'],
      ['T / R', 'Gizmo kéo: tịnh tiến / xoay (chế độ tách rời)'],
      ['Ctrl + O', 'Mở tệp'],
      ['Esc', 'Thoát công cụ / bỏ chọn'],
    ];
    modal(
      'Hướng dẫn nhanh',
      h('table', { class: 'kv' }, ...rows.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v)))),
      h(
        'div',
        { class: 'hint' },
        'Định dạng hỗ trợ: STEP/STP, IGES/IGS, BREP, SolidWorks SLDPRT/SLDASM/SLDDRW, DXF, STL, OBJ, glTF/GLB, 3MF, PLY. ' +
          'Lắp ráp SolidWorks: mở cùng lúc tệp .SLDASM với các .SLDPRT (hoặc cả thư mục). Lắp ráp STEP giữ nguyên cây và vị trí.',
      ),
    );
  }

  // ======================= misc =======================
  setStatus(msg: string) {
    this.el.status.textContent = msg;
  }

  private updateStatusUnits() {
    this.el.statusUnits.textContent = `Đơn vị: ${settings.length} · ${settings.decimals} số lẻ`;
  }

  private busy(on: boolean, msg = '') {
    this.el.busy.hidden = !on;
    const t = this.el.busy.querySelector('.busy-text');
    if (t) t.textContent = msg;
  }
}

const NAV_KEY = 'cadviewer.nav';
function loadNavSettings(v: Viewer) {
  try {
    const raw = localStorage.getItem(NAV_KEY);
    if (!raw) return;
    const o = JSON.parse(raw) as { style?: 'free' | 'turntable'; speed?: number; invert?: boolean };
    if (o.style) v.controls.rotateStyle = o.style;
    if (typeof o.speed === 'number') v.controls.rotateSpeed = o.speed;
    if (typeof o.invert === 'boolean') v.controls.invertWheel = o.invert;
  } catch {
    /* storage unavailable */
  }
}
function saveNavSettings(v: Viewer) {
  try {
    localStorage.setItem(NAV_KEY, JSON.stringify({ style: v.controls.rotateStyle, speed: v.controls.rotateSpeed, invert: v.controls.invertWheel }));
  } catch {
    /* storage unavailable */
  }
}

async function readEntry(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    return new Promise((res) => (entry as FileSystemFileEntry).file((f) => res(isSupported(f.name) ? [f] : []), () => res([])));
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const all: FileSystemEntry[] = [];
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res) => reader.readEntries(res, () => res([])));
      if (!batch.length) break;
      all.push(...batch);
    }
    const out: File[] = [];
    for (const e of all) out.push(...(await readEntry(e)));
    return out;
  }
  return [];
}

function download(url: string, name: string) {
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function modal(title: string, ...body: HTMLElement[]) {
  const ctl: { onClose?: () => void } = {};
  const close = () => {
    back.remove();
    ctl.onClose?.();
  };
  const back = h(
    'div',
    { class: 'modal-back', onclick: (e: Event) => e.target === back && close() },
    h(
      'div',
      { class: 'modal', role: 'dialog', 'aria-label': title },
      h('div', { class: 'pm-head' }, h('span', { class: 'pm-title' }, title), h('button', { class: 'icon-btn', onclick: close, title: 'Đóng' }, icon('close'))),
      h('div', { class: 'pm-body' }, ...body, h('div', { class: 'btn-row right' }, h('button', { class: 'btn primary', onclick: close }, 'OK'))),
    ),
  );
  document.body.append(back);
  return ctl;
}

