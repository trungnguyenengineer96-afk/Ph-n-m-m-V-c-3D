/**
 * Interactive 2D sketcher on a plane (SolidWorks-style).
 *
 * Tools: select/drag, line, centerline, corner rectangle, circle, 3-point arc,
 * smart dimension. While drawing, the cursor snaps to existing points (shared
 * point = coincident) and to nearby horizontal/vertical directions (adds a
 * Horizontal/Vertical relation). Every edit re-solves the sketch with planegcs;
 * edits that make the sketch unsolvable are rolled back.
 */
import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Viewer } from '../viewer/Viewer';
import { solveSketch, type SolveResult } from './sketchSolver';
import type { PlaneDef, SkConstraint, SkConstraintType, SkEntity, SkPoint, SketchData } from './types';

export type SketchTool = 'select' | 'line' | 'centerline' | 'rect' | 'circle' | 'arc' | 'dimension';

export const TOOL_LABEL: Record<SketchTool, string> = {
  select: 'Chọn / kéo',
  line: 'Đường thẳng (L)',
  centerline: 'Đường tâm',
  rect: 'Hình chữ nhật (R)',
  circle: 'Đường tròn (C)',
  arc: 'Cung 3 điểm (A)',
  dimension: 'Kích thước thông minh (D)',
};

type V2 = { x: number; y: number };

interface Snap {
  pos: V2;
  pointId?: string; // existing point under the cursor
  onEntity?: string; // existing line/curve under the cursor
}

const COLORS = {
  under: 0x1450c8,
  full: 0x111111,
  construction: 0x6a7a90,
  selected: 0xff8a00,
  hover: 0xf0b000,
  preview: 0x2a9d3a,
  dim: 0x205ec0,
};

const RELATION_GLYPH: Partial<Record<SkConstraintType, string>> = {
  horizontal: '⟷',
  vertical: '↕',
  parallel: '∥',
  perpendicular: '⊥',
  equal: '=',
  tangent: '◠',
  coincident: '●',
  fix: '⚓',
  onEntity: '◇',
  midpoint: '◆',
  concentric: '◎',
};

export class SketchEditor {
  readonly group = new THREE.Group();
  private geom = new THREE.Group();
  private previewGroup = new THREE.Group();
  private labels = new THREE.Group();
  tool: SketchTool = 'line';
  readonly selection = new Set<string>();
  private hover: string | null = null;
  private seq = 0;
  private matrix = new THREE.Matrix4();
  private inverse = new THREE.Matrix4();
  private plane3 = new THREE.Plane();
  private raycaster = new THREE.Raycaster();
  lastSolve: SolveResult = { ok: true, dof: -1, conflicting: [], redundant: [] };
  private history: string[] = [];
  private future: string[] = [];
  // tool state
  private chain: { id: string | null; pos: V2 } | null = null;
  private clicks: Snap[] = [];
  private cursor: V2 = { x: 0, y: 0 };
  private drag: { ids: string[]; start: V2; orig: Map<string, V2>; moved: boolean } | null = null;
  private dimPick: string[] = [];
  private popup: HTMLElement | null = null;
  readonly onChange: (() => void)[] = [];
  readonly onStatus: ((msg: string) => void)[] = [];

  constructor(
    private viewer: Viewer,
    readonly plane: PlaneDef,
    readonly sketch: SketchData,
  ) {
    const x = new THREE.Vector3(...plane.xDir).normalize();
    const n = new THREE.Vector3(...plane.normal).normalize();
    const y = new THREE.Vector3().crossVectors(n, x);
    this.matrix.makeBasis(x, y, n).setPosition(new THREE.Vector3(...plane.origin));
    this.inverse.copy(this.matrix).invert();
    this.plane3.setFromNormalAndCoplanarPoint(n, new THREE.Vector3(...plane.origin));
    this.group.matrixAutoUpdate = false;
    this.group.matrix.copy(this.matrix);
    this.group.add(this.buildGrid(), this.geom, this.previewGroup, this.labels);
    this.group.renderOrder = 70;
    viewer.overlay.add(this.group);
    this.group.updateMatrixWorld(true);
    for (const p of sketch.points) this.bumpSeq(p.id);
    for (const e of sketch.entities) this.bumpSeq(e.id);
    for (const c of sketch.constraints) this.bumpSeq(c.id);
    this.solve();
    this.render();
  }

  dispose() {
    this.closePopup();
    this.group.traverse((o) => {
      if (o instanceof CSS2DObject) o.element.remove();
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose?.();
    });
    this.group.removeFromParent();
    this.viewer.requestRender();
  }

  // ------------------------------------------------------------------ ids & lookup
  private bumpSeq(id: string) {
    const n = Number(id.replace(/^\D+/, ''));
    if (Number.isFinite(n)) this.seq = Math.max(this.seq, n);
  }
  private nid(prefix: string) {
    return `${prefix}${++this.seq}`;
  }
  private pt(id: string): SkPoint {
    return this.sketch.points.find((p) => p.id === id)!;
  }
  private ent(id: string): SkEntity | undefined {
    return this.sketch.entities.find((e) => e.id === id);
  }
  private addPoint(pos: V2): string {
    const id = this.nid('p');
    this.sketch.points.push({ id, x: pos.x, y: pos.y });
    return id;
  }
  private addConstraint(type: SkConstraintType, refs: string[], value?: number, label?: [number, number]): SkConstraint {
    const c: SkConstraint = { id: this.nid('k'), type, refs, value, label };
    this.sketch.constraints.push(c);
    return c;
  }

  // ------------------------------------------------------------------ history
  private snapshot() {
    this.history.push(JSON.stringify(this.sketch));
    if (this.history.length > 200) this.history.shift();
    this.future = [];
  }
  private restore(json: string) {
    const s = JSON.parse(json) as SketchData;
    this.sketch.points.splice(0, this.sketch.points.length, ...s.points);
    this.sketch.entities.splice(0, this.sketch.entities.length, ...s.entities);
    this.sketch.constraints.splice(0, this.sketch.constraints.length, ...s.constraints);
  }
  undo() {
    const s = this.history.pop();
    if (!s) return;
    this.future.push(JSON.stringify(this.sketch));
    this.restore(s);
    this.solve();
    this.render();
  }
  redo() {
    const s = this.future.pop();
    if (!s) return;
    this.history.push(JSON.stringify(this.sketch));
    this.restore(s);
    this.solve();
    this.render();
  }

  /** Apply an edit; roll it back if the sketch cannot be solved. */
  private edit(fn: () => void, what = 'thao tác'): boolean {
    this.snapshot();
    const before = this.history[this.history.length - 1];
    fn();
    const r = this.solve();
    if (!r.ok) {
      this.restore(before);
      this.history.pop();
      this.solve();
      this.status(`Không thể áp dụng ${what}: ràng buộc xung đột hoặc thừa (${[...r.conflicting].join(', ')}).`);
      this.render();
      return false;
    }
    this.render();
    return true;
  }

  private solve(): SolveResult {
    try {
      this.lastSolve = solveSketch(this.sketch);
    } catch (e) {
      this.lastSolve = { ok: false, dof: -1, conflicting: [String(e)], redundant: [] };
    }
    for (const f of this.onChange) f();
    return this.lastSolve;
  }

  private status(msg: string) {
    for (const f of this.onStatus) f(msg);
  }

  get fullyDefined() {
    return this.lastSolve.ok && this.lastSolve.dof === 0;
  }

  // ------------------------------------------------------------------ coordinates
  /** Cursor → sketch coordinates (null if the view is parallel to the plane). */
  toLocal(clientX: number, clientY: number): V2 | null {
    const r = this.viewer.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.viewer.camera);
    const hit = this.raycaster.ray.intersectPlane(this.plane3, new THREE.Vector3());
    if (!hit) return null;
    hit.applyMatrix4(this.inverse);
    return { x: hit.x, y: hit.y };
  }
  private tol() {
    return this.viewer.pixelSize() * 9;
  }

  private distToEntity(e: SkEntity, p: V2): number {
    if (e.type === 'line') {
      const a = this.pt(e.p1), b = this.pt(e.p2);
      const dx = b.x - a.x, dy = b.y - a.y;
      const L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
      return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
    }
    const c = this.pt(e.c);
    const d = Math.abs(Math.hypot(p.x - c.x, p.y - c.y) - e.r);
    if (e.type === 'circle') return d;
    // Arc: only within its sweep.
    const a1 = Math.atan2(this.pt(e.p1).y - c.y, this.pt(e.p1).x - c.x);
    const a2 = Math.atan2(this.pt(e.p2).y - c.y, this.pt(e.p2).x - c.x);
    const ap = Math.atan2(p.y - c.y, p.x - c.x);
    const norm = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    return norm(ap - a1) <= norm(a2 - a1) ? d : Infinity;
  }

  /** What is under the cursor: a point, else an entity. */
  private hitTest(p: V2, exclude: Set<string> = new Set()): { pointId?: string; entityId?: string } {
    const tol = this.tol();
    let best: { id: string; d: number } | null = null;
    for (const q of this.sketch.points) {
      if (exclude.has(q.id)) continue;
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < tol && (!best || d < best.d)) best = { id: q.id, d };
    }
    if (best) return { pointId: best.id };
    let bestE: { id: string; d: number } | null = null;
    for (const e of this.sketch.entities) {
      if (exclude.has(e.id)) continue;
      const d = this.distToEntity(e, p);
      if (d < tol * 0.8 && (!bestE || d < bestE.d)) bestE = { id: e.id, d };
    }
    return bestE ? { entityId: bestE.id } : {};
  }

  private snap(p: V2, from?: V2, exclude?: Set<string>): Snap & { h?: boolean; v?: boolean } {
    const hit = this.hitTest(p, exclude);
    if (hit.pointId) {
      const q = this.pt(hit.pointId);
      return { pos: { x: q.x, y: q.y }, pointId: hit.pointId };
    }
    const out: Snap & { h?: boolean; v?: boolean } = { pos: { ...p } };
    if (from) {
      // Horizontal / vertical inference within ~3°.
      const dx = p.x - from.x, dy = p.y - from.y;
      const ang = Math.abs(Math.atan2(dy, dx));
      const tolA = (3 * Math.PI) / 180;
      if ((ang < tolA || Math.abs(ang - Math.PI) < tolA) && Math.abs(dx) > this.tol()) {
        out.pos.y = from.y;
        out.h = true;
      } else if (Math.abs(ang - Math.PI / 2) < tolA && Math.abs(dy) > this.tol()) {
        out.pos.x = from.x;
        out.v = true;
      }
    }
    if (hit.entityId) out.onEntity = hit.entityId;
    return out;
  }

  /** Create (or reuse) the point for a snap; adds an on-entity relation when needed. */
  private pointFor(s: Snap): string {
    if (s.pointId) return s.pointId;
    const id = this.addPoint(s.pos);
    if (s.onEntity) this.addConstraint('onEntity', [id, s.onEntity]);
    return id;
  }

  // ------------------------------------------------------------------ input
  setTool(t: SketchTool) {
    this.tool = t;
    this.chain = null;
    this.clicks = [];
    this.dimPick = [];
    this.closePopup();
    this.renderPreview();
    const hints: Record<SketchTool, string> = {
      select: 'Chọn: nhấp để chọn, kéo điểm/đường để di chuyển. Delete để xoá.',
      line: 'Đường thẳng: nhấp các điểm liên tiếp; nhấp đúp hoặc Esc để kết thúc chuỗi.',
      centerline: 'Đường tâm (dựng hình, dùng làm trục xoay): nhấp 2 điểm.',
      rect: 'Hình chữ nhật: nhấp góc thứ nhất rồi góc đối diện.',
      circle: 'Đường tròn: nhấp tâm rồi nhấp một điểm trên đường tròn.',
      arc: 'Cung 3 điểm: nhấp điểm đầu, điểm cuối, rồi điểm trên cung.',
      dimension: 'Kích thước: nhấp đường (chiều dài), tròn/cung (đường kính/bán kính), hoặc 2 đối tượng (khoảng cách/góc).',
    };
    this.status(hints[t]);
  }

  /** Returns true when the event was consumed by the sketcher. */
  pointerDown(e: PointerEvent): boolean {
    if (e.button !== 0) return false;
    const p = this.toLocal(e.clientX, e.clientY);
    if (!p) return false;
    this.cursor = p;
    if (this.tool === 'select') {
      const hit = this.hitTest(p);
      const id = hit.pointId ?? hit.entityId;
      if (!id) {
        if (!e.ctrlKey && !e.shiftKey) this.selection.clear();
        this.render();
        return false; // let the camera rotate
      }
      if (e.ctrlKey || e.shiftKey) this.selection.has(id) ? this.selection.delete(id) : this.selection.add(id);
      else if (!this.selection.has(id)) {
        this.selection.clear();
        this.selection.add(id);
      }
      // Start a drag of the picked geometry.
      const ids = hit.pointId ? [hit.pointId] : this.pointsOf(hit.entityId!);
      if (!ids.includes('O')) {
        const orig = new Map(ids.map((i) => [i, { x: this.pt(i).x, y: this.pt(i).y }]));
        this.drag = { ids, start: p, orig, moved: false };
      }
      this.render();
      return true;
    }
    return true; // drawing tools consume left clicks (handled on pointerup)
  }

  pointerMove(e: PointerEvent) {
    const p = this.toLocal(e.clientX, e.clientY);
    if (!p) return;
    this.cursor = p;
    if (this.drag) {
      const d = this.drag;
      if (!d.moved) {
        this.snapshot();
        d.moved = true;
      }
      const dx = p.x - d.start.x, dy = p.y - d.start.y;
      const temp = d.ids.flatMap((id) => {
        const o = d.orig.get(id)!;
        return [
          { id: `drag_x_${id}`, type: 'coordinate_x', p_id: id, x: o.x + dx, temporary: true },
          { id: `drag_y_${id}`, type: 'coordinate_y', p_id: id, y: o.y + dy, temporary: true },
        ];
      });
      try {
        solveSketch(this.sketch, temp);
      } catch {
        /* ignore while dragging */
      }
      this.render();
      return;
    }
    const hit = this.hitTest(p);
    const h = hit.pointId ?? hit.entityId ?? null;
    if (h !== this.hover) {
      this.hover = h;
      this.render();
    }
    this.renderPreview();
  }

  pointerUp(e: PointerEvent): boolean {
    if (this.drag) {
      const moved = this.drag.moved;
      this.drag = null;
      if (moved) this.solve();
      this.render();
      return true;
    }
    if (e.button !== 0 || this.tool === 'select') return false;
    const p = this.toLocal(e.clientX, e.clientY);
    if (!p) return false;
    this.click(p);
    return true;
  }

  dblClick(): boolean {
    if (this.tool === 'line' || this.tool === 'centerline') {
      this.chain = null;
      this.renderPreview();
      return true;
    }
    return false;
  }

  key(e: KeyboardEvent): boolean {
    const k = e.key;
    if (k === 'Escape') {
      if (this.popup) this.closePopup();
      else if (this.chain || this.clicks.length || this.dimPick.length) {
        this.chain = null;
        this.clicks = [];
        this.dimPick = [];
        this.renderPreview();
      } else if (this.tool !== 'select') this.setTool('select');
      else return false;
      return true;
    }
    if ((k === 'Delete' || k === 'Backspace') && this.selection.size) {
      this.deleteSelection();
      return true;
    }
    if (e.ctrlKey && (k === 'z' || k === 'Z')) {
      this.undo();
      return true;
    }
    if (e.ctrlKey && (k === 'y' || k === 'Y')) {
      this.redo();
      return true;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return false;
    const map: Record<string, SketchTool> = { l: 'line', r: 'rect', c: 'circle', a: 'arc', d: 'dimension', s: 'select' };
    if (map[k.toLowerCase()]) {
      this.setTool(map[k.toLowerCase()]);
      for (const f of this.onChange) f();
      return true;
    }
    return false;
  }

  private click(raw: V2) {
    switch (this.tool) {
      case 'line':
      case 'centerline': {
        const s = this.snap(raw, this.chain?.pos);
        if (!this.chain) {
          this.chain = { id: s.pointId ?? null, pos: s.pos };
          if (!s.pointId && s.onEntity) this.chain.id = null;
          this.clicks = [s];
          this.renderPreview();
          return;
        }
        if (Math.hypot(s.pos.x - this.chain.pos.x, s.pos.y - this.chain.pos.y) < this.tol() / 3) return;
        const startSnap = this.clicks[0];
        let endId = '';
        let closed = false;
        const ok = this.edit(() => {
          const a = this.chain!.id ?? this.pointFor(startSnap);
          const b = this.pointFor(s);
          endId = b;
          const id = this.nid('e');
          this.sketch.entities.push({ id, type: 'line', p1: a, p2: b, construction: this.tool === 'centerline' || undefined });
          if (s.h) this.addConstraint('horizontal', [id]);
          else if (s.v) this.addConstraint('vertical', [id]);
          closed = !!s.pointId && s.pointId === this.firstChainPoint;
          if (!this.firstChainPoint) this.firstChainPoint = a;
        }, 'đường thẳng');
        if (!ok || this.tool === 'centerline' || closed || !endId) {
          this.chain = null;
          this.firstChainPoint = null;
        } else {
          this.chain = { id: endId, pos: { ...this.pt(endId) } };
          this.clicks = [{ pos: this.chain.pos, pointId: endId }];
        }
        this.renderPreview();
        return;
      }
      case 'rect': {
        const s = this.snap(raw);
        if (!this.clicks.length) {
          this.clicks = [s];
          this.renderPreview();
          return;
        }
        const a = this.clicks[0];
        this.clicks = [];
        if (Math.abs(s.pos.x - a.pos.x) < 1e-9 || Math.abs(s.pos.y - a.pos.y) < 1e-9) return;
        this.edit(() => {
          const p1 = this.pointFor(a);
          const p3 = this.pointFor(s);
          const p2 = this.addPoint({ x: s.pos.x, y: a.pos.y });
          const p4 = this.addPoint({ x: a.pos.x, y: s.pos.y });
          const ids = [this.nid('e'), this.nid('e'), this.nid('e'), this.nid('e')];
          const pairs: [string, string][] = [[p1, p2], [p2, p3], [p3, p4], [p4, p1]];
          pairs.forEach(([u, v], i) => this.sketch.entities.push({ id: ids[i], type: 'line', p1: u, p2: v }));
          this.addConstraint('horizontal', [ids[0]]);
          this.addConstraint('horizontal', [ids[2]]);
          this.addConstraint('vertical', [ids[1]]);
          this.addConstraint('vertical', [ids[3]]);
        }, 'hình chữ nhật');
        this.renderPreview();
        return;
      }
      case 'circle': {
        const s = this.snap(raw);
        if (!this.clicks.length) {
          this.clicks = [s];
          this.renderPreview();
          return;
        }
        const c = this.clicks[0];
        this.clicks = [];
        const r = Math.hypot(raw.x - c.pos.x, raw.y - c.pos.y);
        if (r < 1e-9) return;
        this.edit(() => {
          const cid = this.pointFor(c);
          this.sketch.entities.push({ id: this.nid('e'), type: 'circle', c: cid, r });
        }, 'đường tròn');
        this.renderPreview();
        return;
      }
      case 'arc': {
        const s = this.clicks.length < 2 ? this.snap(raw) : { pos: raw };
        this.clicks.push(s);
        if (this.clicks.length < 3) {
          this.renderPreview();
          return;
        }
        const [a, b, m] = this.clicks;
        this.clicks = [];
        const circ = circleFrom3(a.pos, m.pos, b.pos);
        if (!circ) return;
        this.edit(() => {
          let p1 = this.pointFor(a);
          let p2 = this.pointFor(b);
          const cid = this.addPoint(circ.c);
          if (!ccwContains(circ.c, a.pos, b.pos, m.pos)) [p1, p2] = [p2, p1];
          this.sketch.entities.push({ id: this.nid('e'), type: 'arc', c: cid, p1, p2, r: circ.r });
        }, 'cung tròn');
        this.renderPreview();
        return;
      }
      case 'dimension':
        this.dimensionClick(raw);
        return;
    }
  }
  private firstChainPoint: string | null = null;

  private pointsOf(entityId: string): string[] {
    const e = this.ent(entityId);
    if (!e) return [];
    if (e.type === 'line') return [e.p1, e.p2];
    if (e.type === 'circle') return [e.c];
    return [e.c, e.p1, e.p2];
  }

  // ------------------------------------------------------------------ dimensions
  private dimensionClick(p: V2) {
    const hit = this.hitTest(p);
    const id = hit.pointId ?? hit.entityId;
    if (!id) {
      // Click on empty space: place the pending single-entity dimension.
      if (this.dimPick.length === 1) {
        const e = this.ent(this.dimPick[0]);
        if (e?.type === 'line') return this.askDimension('distance', [e.id], p);
      }
      this.dimPick = [];
      return;
    }
    this.dimPick.push(id);
    const [a, b] = this.dimPick;
    const ea = this.ent(a);
    if (this.dimPick.length === 1) {
      if (ea?.type === 'circle') return this.askDimension('diameter', [a], p);
      if (ea?.type === 'arc') return this.askDimension('radius', [a], p);
      this.status('Chọn đối tượng thứ hai, hoặc nhấp chỗ trống để đặt kích thước chiều dài.');
      this.renderPreview();
      return;
    }
    const eb = this.ent(b);
    const isP = (x: string) => !!this.sketch.points.find((q) => q.id === x);
    if (ea?.type === 'line' && eb?.type === 'line') {
      const parallel = Math.abs(cross2(this.dir(ea), this.dir(eb))) < 1e-6;
      return this.askDimension(parallel ? 'distance' : 'angle', [a, b], p);
    }
    if ((isP(a) && eb?.type === 'line') || (ea?.type === 'line' && isP(b))) return this.askDimension('distance', isP(a) ? [a, b] : [b, a], p);
    if (isP(a) && isP(b)) return this.askDimension('distance', [a, b], p);
    // Circle centres.
    const centre = (x: string) => (isP(x) ? x : this.ent(x)?.type === 'circle' || this.ent(x)?.type === 'arc' ? (this.ent(x) as { c: string }).c : null);
    const ca = centre(a), cb = centre(b);
    if (ca && cb) return this.askDimension('distance', [ca, cb], p);
    this.dimPick = [];
  }

  private dir(e: Extract<SkEntity, { type: 'line' }>): V2 {
    const a = this.pt(e.p1), b = this.pt(e.p2);
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
  }

  /** Current measured value of a would-be dimension. */
  measure(type: SkConstraintType, refs: string[]): number {
    const P = (id: string) => this.pt(id);
    const E = (id: string) => this.ent(id);
    if (type === 'diameter') return 2 * (E(refs[0]) as { r: number }).r;
    if (type === 'radius') return (E(refs[0]) as { r: number }).r;
    if (type === 'angle') {
      const a = this.dir(E(refs[0]) as Extract<SkEntity, { type: 'line' }>), b = this.dir(E(refs[1]) as Extract<SkEntity, { type: 'line' }>);
      return (Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y))) * 180) / Math.PI;
    }
    if (type === 'hdistance') return P(refs[1]).x - P(refs[0]).x;
    if (type === 'vdistance') return P(refs[1]).y - P(refs[0]).y;
    if (type === 'distance') {
      const e0 = E(refs[0]);
      if (refs.length === 1 && e0?.type === 'line') return Math.hypot(P(e0.p2).x - P(e0.p1).x, P(e0.p2).y - P(e0.p1).y);
      const e1 = refs[1] ? E(refs[1]) : undefined;
      const pointLine = (pid: string, l: Extract<SkEntity, { type: 'line' }>) => {
        const a = P(l.p1), d = this.dir(l), q = P(pid);
        return Math.abs((q.x - a.x) * d.y - (q.y - a.y) * d.x);
      };
      if (e0?.type === 'line' && e1?.type === 'line') return pointLine(e0.p1, e1);
      if (!e0 && e1?.type === 'line') return pointLine(refs[0], e1);
      return Math.hypot(P(refs[1]).x - P(refs[0]).x, P(refs[1]).y - P(refs[0]).y);
    }
    return 0;
  }

  private askDimension(type: SkConstraintType, refs: string[], at: V2, existing?: SkConstraint) {
    this.dimPick = [];
    this.popupRefs = refs;
    this.renderPreview();
    const current = existing?.value ?? this.measure(type, refs);
    const isPP = !existing && type === 'distance' && refs.length === 2 && refs.every((r) => this.sketch.points.some((q) => q.id === r));
    this.openPopup(at, Math.abs(current), type === 'angle' ? '°' : 'mm', isPP, (value, mode) => {
      if (!(value > 0) && type !== 'hdistance' && type !== 'vdistance') return;
      if (existing) {
        this.edit(() => {
          existing.value = existing.type === 'hdistance' || existing.type === 'vdistance' ? Math.sign(existing.value || 1) * value : value;
        }, 'kích thước');
        return;
      }
      let t = type;
      let v = value;
      if (mode === 'h') {
        t = 'hdistance';
        v = Math.sign(this.measure('hdistance', refs) || 1) * value;
      } else if (mode === 'v') {
        t = 'vdistance';
        v = Math.sign(this.measure('vdistance', refs) || 1) * value;
      }
      this.edit(() => this.addConstraint(t, refs, v, [at.x, at.y]), 'kích thước');
    });
  }

  private openPopup(at: V2, value: number, unit: string, withMode: boolean, apply: (v: number, mode: 'aligned' | 'h' | 'v') => void) {
    this.closePopup();
    const world = new THREE.Vector3(at.x, at.y, 0).applyMatrix4(this.matrix).project(this.viewer.camera);
    const r = this.viewer.renderer.domElement.getBoundingClientRect();
    const sx = r.left + ((world.x + 1) / 2) * r.width, sy = r.top + ((1 - world.y) / 2) * r.height;
    const box = document.createElement('div');
    box.className = 'dim-popup';
    box.style.left = `${sx + 12}px`;
    box.style.top = `${sy - 16}px`;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = 'any';
    input.value = String(Number(value.toFixed(4)));
    let mode: 'aligned' | 'h' | 'v' = 'aligned';
    const modes = document.createElement('div');
    if (withMode) {
      modes.className = 'dim-modes';
      for (const [m, label] of [['aligned', 'Thẳng'], ['h', 'Ngang'], ['v', 'Dọc']] as const) {
        const b = document.createElement('button');
        b.textContent = label;
        b.className = m === mode ? 'active' : '';
        b.onclick = () => {
          mode = m;
          modes.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
          const v = m === 'h' ? Math.abs(this.measureHV('x')) : m === 'v' ? Math.abs(this.measureHV('y')) : value;
          input.value = String(Number(v.toFixed(4)));
          input.focus();
        };
        modes.append(b);
      }
    }
    const ok = document.createElement('button');
    ok.textContent = '✓';
    ok.className = 'ok';
    const commit = () => {
      const v = Number(input.value);
      this.closePopup();
      if (Number.isFinite(v)) apply(v, mode);
    };
    ok.onclick = commit;
    input.onkeydown = (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') commit();
      if (ev.key === 'Escape') this.closePopup();
    };
    const unitEl = document.createElement('span');
    unitEl.textContent = unit;
    box.append(input, unitEl, ok);
    if (withMode) box.append(modes);
    document.body.append(box);
    this.popup = box;
    setTimeout(() => {
      input.focus();
      input.select();
    });
  }
  private popupRefs: string[] | null = null;
  private measureHV(axis: 'x' | 'y') {
    const refs = this.lastDimRefs;
    if (!refs) return 0;
    return this.pt(refs[1])[axis] - this.pt(refs[0])[axis];
  }
  private get lastDimRefs(): string[] | null {
    return this.popupRefs;
  }

  private closePopup() {
    this.popup?.remove();
    this.popup = null;
  }

  /** Edit an existing dimension value (double-click on its label). */
  editDimension(c: SkConstraint) {
    const at = c.label ? { x: c.label[0], y: c.label[1] } : this.cursor;
    this.askDimension(c.type, c.refs, at, c);
  }

  // ------------------------------------------------------------------ relations
  /** Relations applicable to the current selection (SolidWorks "Add Relations"). */
  applicableRelations(): SkConstraintType[] {
    const ids = [...this.selection];
    const pts = ids.filter((id) => this.sketch.points.some((p) => p.id === id));
    const ents = ids.map((id) => this.ent(id)).filter(Boolean) as SkEntity[];
    const lines = ents.filter((e) => e.type === 'line');
    const curves = ents.filter((e) => e.type !== 'line');
    const out: SkConstraintType[] = [];
    if (lines.length === 1 && ents.length === 1 && !pts.length) out.push('horizontal', 'vertical');
    if (pts.length === 2 && !ents.length) out.push('coincident', 'horizontal', 'vertical');
    if (lines.length === 2 && ents.length === 2) out.push('parallel', 'perpendicular', 'equal');
    if (curves.length === 2 && ents.length === 2) out.push('equal', 'concentric', 'tangent');
    if (lines.length === 1 && curves.length === 1) out.push('tangent');
    if (pts.length === 1 && ents.length === 1) out.push('onEntity');
    if (pts.length === 1 && lines.length === 1 && ents.length === 1) out.push('midpoint');
    if (pts.length >= 1 && !ents.length) out.push('fix');
    return out;
  }

  addRelation(type: SkConstraintType) {
    const ids = [...this.selection];
    const pts = ids.filter((id) => this.sketch.points.some((p) => p.id === id));
    const ents = ids.filter((id) => this.ent(id));
    this.edit(() => {
      if (type === 'fix') for (const p of pts) this.addConstraint('fix', [p]);
      else if (type === 'onEntity' || type === 'midpoint') this.addConstraint(type, [pts[0], ents[0]]);
      else if (pts.length === 2 && !ents.length) this.addConstraint(type, pts);
      else this.addConstraint(type, ents.length ? ents : pts);
    }, 'quan hệ');
  }

  toggleConstruction() {
    this.edit(() => {
      for (const id of this.selection) {
        const e = this.ent(id);
        if (e) e.construction = !e.construction || undefined;
      }
    });
  }

  deleteSelection() {
    const sel = new Set(this.selection);
    sel.delete('O');
    if (!sel.size) return;
    this.edit(() => {
      const sk = this.sketch;
      // Deleting an entity also deletes its now-unused points.
      const removeEnts = new Set(sk.entities.filter((e) => sel.has(e.id) || this.pointsOf(e.id).some((p) => sel.has(p))).map((e) => e.id));
      sk.entities = sk.entities.filter((e) => !removeEnts.has(e.id));
      const usedPts = new Set<string>(['O']);
      for (const e of sk.entities) this.pointsOf(e.id).forEach((p) => usedPts.add(p));
      sk.points = sk.points.filter((p) => usedPts.has(p.id) && !sel.has(p.id));
      const alive = new Set([...sk.points.map((p) => p.id), ...sk.entities.map((e) => e.id)]);
      sk.constraints = sk.constraints.filter((c) => !sel.has(c.id) && c.refs.every((r) => alive.has(r)));
    }, 'xoá');
    this.selection.clear();
    this.render();
  }

  // ------------------------------------------------------------------ rendering
  private buildGrid(): THREE.Object3D {
    const size = Math.max(this.viewer.modelRadius * 4, 200);
    const step = niceStep(size / 40);
    const grid = new THREE.GridHelper(Math.ceil(size / step) * step, Math.ceil(size / step), 0xb7c3d4, 0xdde3ec);
    grid.rotation.x = Math.PI / 2;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.55;
    (grid.material as THREE.Material).depthWrite = false;
    grid.renderOrder = 1;
    grid.raycast = () => {};
    return grid;
  }

  private entityPoints(e: SkEntity): THREE.Vector3[] {
    if (e.type === 'line') return [this.pt(e.p1), this.pt(e.p2)].map((p) => new THREE.Vector3(p.x, p.y, 0));
    const c = this.pt(e.c);
    let a1 = 0, a2 = Math.PI * 2;
    if (e.type === 'arc') {
      a1 = Math.atan2(this.pt(e.p1).y - c.y, this.pt(e.p1).x - c.x);
      a2 = Math.atan2(this.pt(e.p2).y - c.y, this.pt(e.p2).x - c.x);
      while (a2 <= a1) a2 += Math.PI * 2;
    }
    const n = Math.max(12, Math.ceil(((a2 - a1) / (Math.PI * 2)) * 96));
    return Array.from({ length: n + 1 }, (_, i) => {
      const t = a1 + ((a2 - a1) * i) / n;
      return new THREE.Vector3(c.x + e.r * Math.cos(t), c.y + e.r * Math.sin(t), 0);
    });
  }

  private lineObj(pts: THREE.Vector3[], color: number, dashed = false, width = 1): THREE.Line {
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = dashed
      ? new THREE.LineDashedMaterial({ color, dashSize: this.viewer.pixelSize() * 8, gapSize: this.viewer.pixelSize() * 5, depthTest: false })
      : new THREE.LineBasicMaterial({ color, depthTest: false, linewidth: width });
    const l = new THREE.Line(g, mat);
    if (dashed) l.computeLineDistances();
    l.renderOrder = 80;
    l.raycast = () => {};
    return l;
  }

  private clearGroup(g: THREE.Group) {
    for (const c of [...g.children]) {
      c.traverse((o) => {
        if (o instanceof CSS2DObject) o.element.remove();
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        (m.material as THREE.Material | undefined)?.dispose?.();
      });
      c.removeFromParent();
    }
  }

  render() {
    this.clearGroup(this.geom);
    this.clearGroup(this.labels);
    const base = this.fullyDefined ? COLORS.full : COLORS.under;
    for (const e of this.sketch.entities) {
      const sel = this.selection.has(e.id);
      const col = sel ? COLORS.selected : this.hover === e.id ? COLORS.hover : e.construction ? COLORS.construction : base;
      this.geom.add(this.lineObj(this.entityPoints(e), col, !!e.construction));
    }
    // Points
    const pos: number[] = [], col: number[] = [];
    const c = new THREE.Color();
    for (const p of this.sketch.points) {
      if (p.id === 'O') continue;
      const used = this.sketch.entities.some((e) => this.pointsOf(e.id).includes(p.id));
      if (!used) continue;
      pos.push(p.x, p.y, 0);
      c.setHex(this.selection.has(p.id) ? COLORS.selected : this.hover === p.id ? COLORS.hover : base);
      col.push(c.r, c.g, c.b);
    }
    if (pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      const pts = new THREE.Points(g, new THREE.PointsMaterial({ size: 6, sizeAttenuation: false, vertexColors: true, depthTest: false }));
      pts.renderOrder = 81;
      this.geom.add(pts);
    }
    // Sketch origin (red arrows like SolidWorks).
    const s = this.viewer.pixelSize() * 30;
    this.geom.add(this.lineObj([new THREE.Vector3(0, 0, 0), new THREE.Vector3(s, 0, 0)], 0xd0021b));
    this.geom.add(this.lineObj([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, s, 0)], 0xd0021b));
    this.renderConstraints();
    this.viewer.requestRender();
  }

  private midOf(id: string): V2 {
    const p = this.sketch.points.find((q) => q.id === id);
    if (p) return p;
    const e = this.ent(id)!;
    if (e.type === 'line') {
      const a = this.pt(e.p1), b = this.pt(e.p2);
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
    const c = this.pt(e.c);
    return { x: c.x + e.r * Math.SQRT1_2, y: c.y + e.r * Math.SQRT1_2 };
  }

  private renderConstraints() {
    const px = this.viewer.pixelSize();
    const glyphCount = new Map<string, number>();
    for (const k of this.sketch.constraints) {
      if (!k.refs.every((r) => this.sketch.points.some((p) => p.id === r) || this.ent(r))) continue;
      const glyph = RELATION_GLYPH[k.type];
      const selected = this.selection.has(k.id);
      if (glyph) {
        if (k.type === 'coincident') continue; // shared points already show coincidence
        const anchor = this.midOf(k.refs[k.type === 'onEntity' || k.type === 'midpoint' ? 0 : 0]);
        const n = glyphCount.get(k.refs[0]) ?? 0;
        glyphCount.set(k.refs[0], n + 1);
        const el = document.createElement('div');
        el.className = 'sk-rel' + (selected ? ' selected' : '');
        el.textContent = glyph;
        el.title = k.type;
        el.onpointerdown = (ev) => {
          ev.stopPropagation();
          this.selection.clear();
          this.selection.add(k.id);
          this.render();
        };
        const o = new CSS2DObject(el);
        o.position.set(anchor.x + px * (10 + 14 * n), anchor.y + px * 10, 0);
        this.labels.add(o);
        continue;
      }
      if (k.value === undefined) continue;
      // Dimension: label plus a leader / dimension line.
      const lab = k.label ? { x: k.label[0], y: k.label[1] } : this.midOf(k.refs[0]);
      const text = k.type === 'diameter' ? `Ø${fmt(k.value)}` : k.type === 'radius' ? `R${fmt(k.value)}` : k.type === 'angle' ? `${fmt(k.value)}°` : fmt(Math.abs(k.value));
      const el = document.createElement('div');
      el.className = 'sk-dim' + (selected ? ' selected' : '');
      el.textContent = text;
      el.title = 'Nhấp đúp để sửa kích thước';
      el.onpointerdown = (ev) => {
        ev.stopPropagation();
        if (!(ev.ctrlKey || ev.shiftKey)) this.selection.clear();
        this.selection.add(k.id);
        this.render();
      };
      el.ondblclick = (ev) => {
        ev.stopPropagation();
        this.editDimension(k);
      };
      const o = new CSS2DObject(el);
      o.position.set(lab.x, lab.y, 0);
      this.labels.add(o);
      for (const seg of this.dimensionGraphics(k, lab)) this.labels.add(this.lineObj(seg, selected ? COLORS.selected : COLORS.dim));
    }
  }

  private dimensionGraphics(k: SkConstraint, lab: V2): THREE.Vector3[][] {
    const V = (p: V2) => new THREE.Vector3(p.x, p.y, 0);
    const out: THREE.Vector3[][] = [];
    if (k.type === 'radius' || k.type === 'diameter') {
      const e = this.ent(k.refs[0]) as { c: string; r: number } | undefined;
      if (!e) return out;
      const c = this.pt(e.c);
      const d = Math.hypot(lab.x - c.x, lab.y - c.y) || 1;
      const u = { x: (lab.x - c.x) / d, y: (lab.y - c.y) / d };
      const start = k.type === 'diameter' ? { x: c.x - u.x * e.r, y: c.y - u.y * e.r } : c;
      out.push([V(start), V(lab)]);
      return out;
    }
    let a: V2 | null = null, b: V2 | null = null;
    const e0 = this.ent(k.refs[0]);
    if (k.refs.length === 1 && e0?.type === 'line') [a, b] = [this.pt(e0.p1), this.pt(e0.p2)];
    else if (k.refs.length === 2 && !e0 && !this.ent(k.refs[1])) [a, b] = [this.pt(k.refs[0]), this.pt(k.refs[1])];
    if (!a || !b) {
      out.push([V(this.midOf(k.refs[0])), V(lab)]);
      if (k.refs[1]) out.push([V(this.midOf(k.refs[1])), V(lab)]);
      return out;
    }
    if (k.type === 'hdistance') b = { x: b.x, y: a.y };
    if (k.type === 'vdistance') b = { x: a.x, y: b.y };
    const dx = b.x - a.x, dy = b.y - a.y;
    const L = Math.hypot(dx, dy) || 1;
    const n = { x: -dy / L, y: dx / L };
    const off = (lab.x - a.x) * n.x + (lab.y - a.y) * n.y;
    const a2 = { x: a.x + n.x * off, y: a.y + n.y * off }, b2 = { x: b.x + n.x * off, y: b.y + n.y * off };
    const bb = k.type === 'hdistance' || k.type === 'vdistance' ? this.pt(k.refs[1]) : b;
    out.push([V(a), V(a2)], [V(bb), V(b2)], [V(a2), V(b2)]);
    return out;
  }

  private renderPreview() {
    this.clearGroup(this.previewGroup);
    const cur = this.cursor;
    const add = (pts: V2[], dashed = false) => this.previewGroup.add(this.lineObj(pts.map((p) => new THREE.Vector3(p.x, p.y, 0)), COLORS.preview, dashed));
    if ((this.tool === 'line' || this.tool === 'centerline') && this.chain) {
      const s = this.snap(cur, this.chain.pos);
      add([this.chain.pos, s.pos], this.tool === 'centerline');
      this.hintAt(s.pos, s.pointId ? '●' : s.h ? '⟷' : s.v ? '↕' : '', fmt(Math.hypot(s.pos.x - this.chain.pos.x, s.pos.y - this.chain.pos.y)));
    } else if (this.tool === 'rect' && this.clicks.length === 1) {
      const a = this.clicks[0].pos, b = this.snap(cur).pos;
      add([a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }, a]);
      this.hintAt(b, '', `${fmt(Math.abs(b.x - a.x))} × ${fmt(Math.abs(b.y - a.y))}`);
    } else if (this.tool === 'circle' && this.clicks.length === 1) {
      const c = this.clicks[0].pos;
      const r = Math.hypot(cur.x - c.x, cur.y - c.y);
      add(Array.from({ length: 65 }, (_, i) => ({ x: c.x + r * Math.cos((i / 64) * Math.PI * 2), y: c.y + r * Math.sin((i / 64) * Math.PI * 2) })));
      this.hintAt(cur, '', `R ${fmt(r)}`);
    } else if (this.tool === 'arc' && this.clicks.length >= 1) {
      const a = this.clicks[0].pos;
      if (this.clicks.length === 1) add([a, this.snap(cur).pos], true);
      else {
        const b = this.clicks[1].pos;
        const circ = circleFrom3(a, cur, b);
        if (circ) {
          const ccw = ccwContains(circ.c, a, b, cur);
          const [s, e] = ccw ? [a, b] : [b, a];
          let a1 = Math.atan2(s.y - circ.c.y, s.x - circ.c.x), a2 = Math.atan2(e.y - circ.c.y, e.x - circ.c.x);
          while (a2 <= a1) a2 += Math.PI * 2;
          add(Array.from({ length: 49 }, (_, i) => {
            const t = a1 + ((a2 - a1) * i) / 48;
            return { x: circ.c.x + circ.r * Math.cos(t), y: circ.c.y + circ.r * Math.sin(t) };
          }));
          this.hintAt(cur, '', `R ${fmt(circ.r)}`);
        }
      }
    } else if (this.tool !== 'select' && this.tool !== 'dimension') {
      const s = this.snap(cur);
      if (s.pointId) this.hintAt(s.pos, '●', '');
    }
    this.viewer.requestRender();
  }

  private hintAt(p: V2, glyph: string, text: string) {
    if (!glyph && !text) return;
    const el = document.createElement('div');
    el.className = 'sk-hint';
    el.textContent = `${glyph} ${text}`.trim();
    const o = new CSS2DObject(el);
    const px = this.viewer.pixelSize();
    o.position.set(p.x + px * 18, p.y - px * 14, 0);
    this.previewGroup.add(o);
  }
}

// ---------------------------------------------------------------- helpers
function fmt(v: number) {
  return Number(v.toFixed(3)).toString();
}
const cross2 = (a: V2, b: V2) => a.x * b.y - a.y * b.x;

function niceStep(x: number) {
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const m = x / p;
  return (m < 2 ? 1 : m < 5 ? 2 : 5) * p;
}

export function circleFrom3(a: V2, b: V2, c: V2): { c: V2; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
  const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { c: { x: ux, y: uy }, r: Math.hypot(a.x - ux, a.y - uy) };
}

/** True when going counter-clockwise from s to e around c passes through m. */
export function ccwContains(c: V2, s: V2, e: V2, m: V2) {
  const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const as = Math.atan2(s.y - c.y, s.x - c.x), ae = Math.atan2(e.y - c.y, e.x - c.x), am = Math.atan2(m.y - c.y, m.x - c.x);
  return norm(am - as) < norm(ae - as);
}
