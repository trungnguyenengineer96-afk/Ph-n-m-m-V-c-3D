/** PropertyManager-style panels for the tools. */
import * as THREE from 'three';
import type { DocumentView } from '../viewer/DocumentView';
import type { SectionManager, SectionAxis } from '../viewer/Section';
import type { ExplodeManager, ExplodeDirection, ExplodeLevel } from '../viewer/Explode';
import type { MeasureTool } from '../tools/MeasureTool';
import type { Viewer } from '../viewer/Viewer';
import type { LoadedModel, ModelNode } from '../core/types';
import { massProperties, MATERIALS, type MassInput } from '../core/mass';
import { fmtArea, fmtLength, fmtNumber, fmtValue, fmtVolume, settings } from '../core/units';
import { fmtVec } from '../core/measure';
import { clear, fmtBytes, h, slider, toast } from './dom';
import { icon } from './icons';

export interface PanelContext {
  viewer: Viewer;
  doc(): DocumentView | null;
  section: SectionManager;
  explode: ExplodeManager;
  measure: MeasureTool;
  selectedNodes(): ModelNode[];
  /** Ask the user to click a planar face; resolves with world normal and point. */
  pickPlanarFace(prompt: string): Promise<{ normal: THREE.Vector3; point: THREE.Vector3 } | null>;
  setDragMode(on: boolean): void;
  dragMode(): boolean;
  closeTool(): void;
}

export function panelShell(title: string, iconName: string, onClose: () => void, ...body: HTMLElement[]) {
  return h(
    'div',
    { class: 'pm' },
    h('div', { class: 'pm-head' }, icon(iconName), h('span', { class: 'pm-title' }, title), h('button', { class: 'icon-btn', title: 'Đóng (Esc)', onclick: onClose }, icon('close'))),
    h('div', { class: 'pm-body' }, ...body),
  );
}

// ---------------- Measure ----------------
export function measurePanel(ctx: PanelContext) {
  const sel = h('div', { class: 'pm-selection' });
  const table = h('table', { class: 'kv' });
  const keep = h('input', { type: 'checkbox' }) as HTMLInputElement;
  keep.checked = ctx.measure.keepHistory;
  keep.addEventListener('change', () => (ctx.measure.keepHistory = keep.checked));
  const update = () => {
    clear(sel);
    if (!ctx.measure.selection.length) sel.append(h('div', { class: 'hint' }, 'Nhấp chọn đỉnh, cạnh hoặc mặt. Giữ Ctrl để chọn thêm. Chọn 2 đối tượng để đo khoảng cách/góc.'));
    ctx.measure.selection.forEach((s, i) =>
      sel.append(h('div', { class: `chip chip-${i === 0 ? 'a' : 'b'}` }, `${i + 1}. ${s.entity.label}`)),
    );
    clear(table);
    for (const r of ctx.measure.result?.rows ?? [])
      table.append(h('tr', { class: r.primary ? 'primary' : '' }, h('th', {}, r.label), h('td', {}, fmtValue(r.value, r.unit))));
  };
  ctx.measure.onChange.push(update);
  update();
  const copy = () => {
    const rows = ctx.measure.result?.rows ?? [];
    if (!rows.length) return;
    navigator.clipboard?.writeText(rows.map((r) => `${r.label}\t${fmtValue(r.value, r.unit)}`).join('\n'));
    toast('Đã sao chép kết quả đo', 'ok', 1800);
  };
  return panelShell(
    'Đo (Measure)',
    'measure',
    ctx.closeTool,
    sel,
    table,
    h('label', { class: 'check' }, keep, 'Giữ lại kích thước trên màn hình'),
    h(
      'div',
      { class: 'btn-row' },
      h('button', { class: 'btn', onclick: () => ctx.measure.clear() }, icon('trash'), 'Xoá chọn'),
      h('button', { class: 'btn', onclick: () => { ctx.measure.pinCurrent(); ctx.viewer.requestRender(); } }, icon('pin'), 'Ghim'),
      h('button', { class: 'btn', onclick: () => ctx.measure.clearHistory() }, 'Xoá ghim'),
      h('button', { class: 'btn', onclick: copy }, icon('copy'), 'Sao chép'),
    ),
  );
}

// ---------------- Section ----------------
export function sectionPanel(ctx: PanelContext) {
  const sm = ctx.section;
  const blocks: HTMLElement[] = [];
  const sliders: ReturnType<typeof slider>[] = [];
  const refreshRanges = () => {
    sm.states.forEach((s, i) => {
      const [lo, hi] = sm.range(i);
      sliders[i]?.set(s.offset, lo, hi);
    });
  };
  sm.states.forEach((s, i) => {
    const enabled = h('input', { type: 'checkbox' }) as HTMLInputElement;
    enabled.checked = s.enabled;
    const axis = h(
      'select',
      {},
      ...(['x', 'y', 'z', 'custom'] as SectionAxis[]).map((a) =>
        h('option', { value: a, selected: s.axis === a }, { x: 'Mặt YZ (vuông góc X)', y: 'Mặt XZ (vuông góc Y) — Top', z: 'Mặt XY (vuông góc Z) — Front', custom: 'Theo mặt đã chọn' }[a]),
      ),
    ) as HTMLSelectElement;
    const [lo, hi] = sm.range(i);
    const off = slider({ label: 'Vị trí (mm)', min: lo, max: hi, step: (hi - lo) / 1000 || 0.01, value: s.offset, digits: 3, onInput: (v) => { s.offset = v; sm.updatePlanes(); } });
    sliders[i] = off;
    const rotA = slider({ label: 'Xoay 1 (°)', min: -90, max: 90, step: 0.5, value: s.rotA, digits: 1, onInput: (v) => { s.rotA = v; sm.updatePlanes(); refreshRanges(); } });
    const rotB = slider({ label: 'Xoay 2 (°)', min: -90, max: 90, step: 0.5, value: s.rotB, digits: 1, onInput: (v) => { s.rotB = v; sm.updatePlanes(); refreshRanges(); } });
    const flip = h('input', { type: 'checkbox' }) as HTMLInputElement;
    flip.checked = s.flip;
    flip.addEventListener('change', () => { s.flip = flip.checked; sm.updatePlanes(); });
    const pickBtn = h('button', { class: 'btn' }, 'Chọn mặt phẳng…');
    pickBtn.addEventListener('click', async () => {
      const r = await ctx.pickPlanarFace('Nhấp vào một mặt phẳng để đặt mặt cắt');
      if (!r) return;
      s.axis = 'custom';
      s.normal.copy(r.normal);
      s.rotA = s.rotB = 0;
      rotA.set(0);
      rotB.set(0);
      axis.value = 'custom';
      s.offset = r.normal.clone().normalize().dot(r.point);
      s.enabled = true;
      enabled.checked = true;
      sm.rebuild();
      refreshRanges();
    });
    enabled.addEventListener('change', () => { s.enabled = enabled.checked; sm.rebuild(); });
    axis.addEventListener('change', async () => {
      if (axis.value === 'custom') {
        pickBtn.click();
        return;
      }
      s.axis = axis.value as SectionAxis;
      const [l, hh] = sm.range(i);
      s.offset = (l + hh) / 2;
      sm.updatePlanes();
      refreshRanges();
    });
    blocks.push(
      h(
        'fieldset',
        { class: 'pm-group' },
        h('legend', {}, h('label', { class: 'check' }, enabled, `Mặt cắt ${i + 1}`)),
        h('div', { class: 'field' }, h('label', {}, 'Mặt tham chiếu'), axis),
        pickBtn,
        off.el,
        rotA.el,
        rotB.el,
        h('label', { class: 'check' }, flip, 'Đảo chiều cắt'),
      ),
    );
  });
  const caps = h('input', { type: 'checkbox' }) as HTMLInputElement;
  caps.checked = sm.showCaps;
  caps.addEventListener('change', () => { sm.showCaps = caps.checked; sm.rebuild(); });
  const hatch = h('input', { type: 'checkbox' }) as HTMLInputElement;
  hatch.checked = sm.hatch;
  hatch.addEventListener('change', () => { sm.hatch = hatch.checked; sm.rebuild(); });
  const outline = h('input', { type: 'checkbox' }) as HTMLInputElement;
  outline.checked = sm.showPlane;
  outline.addEventListener('change', () => { sm.showPlane = outline.checked; sm.rebuild(); });
  const color = h('input', { type: 'color', value: sm.capColor }) as HTMLInputElement;
  color.addEventListener('input', () => { sm.capColor = color.value; sm.rebuild(); });
  return panelShell(
    'Mặt cắt (Section View)',
    'section',
    ctx.closeTool,
    ...blocks,
    h(
      'fieldset',
      { class: 'pm-group' },
      h('legend', {}, 'Hiển thị'),
      h('label', { class: 'check' }, caps, 'Tô mặt cắt (cap)'),
      h('label', { class: 'check' }, hatch, 'Gạch mặt cắt (hatch)'),
      h('label', { class: 'check' }, outline, 'Hiện khung mặt cắt'),
      h('div', { class: 'field' }, h('label', {}, 'Màu mặt cắt'), color),
    ),
    h('div', { class: 'hint' }, 'Mẹo: kết hợp với công cụ Đo để đo trên mặt cắt; dùng phím 8 (Normal To) để nhìn vuông góc.'),
  );
}

// ---------------- Explode ----------------
export function explodePanel(ctx: PanelContext) {
  const ex = ctx.explode;
  const level = h(
    'select',
    {},
    h('option', { value: 'top', selected: ex.level === 'top' }, 'Cụm cấp 1 (sub-assembly)'),
    h('option', { value: 'parts', selected: ex.level === 'parts' }, 'Từng chi tiết (part)'),
    h('option', { value: 'bodies', selected: ex.level === 'bodies' }, 'Từng thân (body)'),
  ) as HTMLSelectElement;
  const dir = h(
    'select',
    {},
    h('option', { value: 'radial' }, 'Toả ra từ tâm'),
    h('option', { value: 'x' }, 'Theo trục X'),
    h('option', { value: 'y' }, 'Theo trục Y'),
    h('option', { value: 'z' }, 'Theo trục Z'),
  ) as HTMLSelectElement;
  dir.value = ex.direction;
  const amt = slider({ label: 'Mức tách (%)', min: 0, max: 100, step: 1, value: ex.factor * 100, digits: 0, onInput: (v) => ex.setFactor(v / 100) });
  level.addEventListener('change', () => { ex.setLevel(level.value as ExplodeLevel); });
  dir.addEventListener('change', () => ex.setDirection(dir.value as ExplodeDirection));
  const drag = h('input', { type: 'checkbox' }) as HTMLInputElement;
  drag.checked = ctx.dragMode();
  drag.addEventListener('change', () => ctx.setDragMode(drag.checked));
  let animating = false;
  const animate = () => {
    if (animating) return;
    animating = true;
    const from = ex.factor, to = from > 0.5 ? 0 : 1;
    const t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / 1200);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const f = from + (to - from) * e;
      ex.setFactor(f);
      amt.set(f * 100);
      if (k < 1) requestAnimationFrame(step);
      else animating = false;
    };
    step();
  };
  const note = ex.hasUnits ? null : h('div', { class: 'warn' }, 'Mô hình chỉ có một thành phần — hãy chọn mức "Từng thân" hoặc mở tệp lắp ráp.');
  return panelShell(
    'Tách rời (Exploded View)',
    'explode',
    ctx.closeTool,
    h('div', { class: 'hint' }, 'Tách tạm thời để xem kết cấu. Không thay đổi tệp gốc.'),
    note ?? h('span'),
    h('div', { class: 'field' }, h('label', {}, 'Đơn vị tách'), level),
    h('div', { class: 'field' }, h('label', {}, 'Hướng'), dir),
    amt.el,
    h('label', { class: 'check' }, drag, 'Kéo thả từng chi tiết (gizmo)'),
    h(
      'div',
      { class: 'btn-row' },
      h('button', { class: 'btn', onclick: animate }, icon('play'), 'Hoạt cảnh tách/gộp'),
      h('button', { class: 'btn', onclick: () => { ex.reset(); amt.set(0); } }, 'Thu gọn (Reset)'),
    ),
  );
}

// ---------------- Mass properties ----------------
export function massPanel(ctx: PanelContext) {
  const target = h('select', {}, h('option', { value: 'all' }, 'Toàn bộ (đang hiển thị)'), h('option', { value: 'sel' }, 'Thành phần đang chọn')) as HTMLSelectElement;
  if (ctx.selectedNodes().length) target.value = 'sel';
  const mat = h('select', {}, ...MATERIALS.map((m) => h('option', { value: String(m.density) }, `${m.name} — ${m.density} kg/m³`))) as HTMLSelectElement;
  const dens = h('input', { type: 'number', value: '7850', step: '10', class: 'num' }) as HTMLInputElement;
  mat.addEventListener('change', () => { dens.value = mat.value; compute(); });
  dens.addEventListener('change', compute);
  target.addEventListener('change', compute);
  const out = h('div');
  function compute() {
    clear(out);
    const doc = ctx.doc();
    if (!doc) return;
    let meshes = doc.meshes.filter((m) => doc.isEffectivelyVisible(m));
    if (target.value === 'sel') {
      const nodes = ctx.selectedNodes();
      if (!nodes.length) {
        out.append(h('div', { class: 'warn' }, 'Chưa chọn thành phần nào trong cây/viewport.'));
        return;
      }
      meshes = nodes.flatMap((n) => doc.meshesOf(n));
    }
    if (!meshes.length) {
      out.append(h('div', { class: 'warn' }, 'Không có hình khối nào để tính.'));
      return;
    }
    // Use rest positions (explode offsets do not change mass properties of parts, but do the centroid).
    const inputs: MassInput[] = meshes.map((m) => ({ positions: m.userData.cad.body.positions, indices: m.userData.cad.body.indices, matrix: m.matrixWorld.elements }));
    const mp = massProperties(inputs);
    const rho = Number(dens.value) || 0; // kg/m³
    const mass = mp.volume * 1e-9 * rho; // kg
    const I = mp.principalMoments.map((x) => x * rho * 1e-9); // kg·mm²
    const size = new THREE.Vector3(mp.bboxMax[0] - mp.bboxMin[0], mp.bboxMax[1] - mp.bboxMin[1], mp.bboxMax[2] - mp.bboxMin[2]);
    const rows: [string, string][] = [
      ['Khối lượng', `${fmtNumber(mass, Math.max(3, settings.decimals))} kg`],
      ['Thể tích', fmtVolume(mp.volume)],
      ['Diện tích bề mặt', fmtArea(mp.area)],
      ['Trọng tâm X', fmtLength(mp.centroid[0])],
      ['Trọng tâm Y', fmtLength(mp.centroid[1])],
      ['Trọng tâm Z', fmtLength(mp.centroid[2])],
      ['Kích thước bao (X×Y×Z)', `${fmtNumber(size.x, 2)} × ${fmtNumber(size.y, 2)} × ${fmtNumber(size.z, 2)} mm`],
      ['Mô-men quán tính chính Px', `${fmtNumber(I[0], 3)} kg·mm²`],
      ['Mô-men quán tính chính Py', `${fmtNumber(I[1], 3)} kg·mm²`],
      ['Mô-men quán tính chính Pz', `${fmtNumber(I[2], 3)} kg·mm²`],
      ['Trục chính Ix', fmtVec(mp.principalAxes[0], 4)],
      ['Trục chính Iy', fmtVec(mp.principalAxes[1], 4)],
      ['Trục chính Iz', fmtVec(mp.principalAxes[2], 4)],
    ];
    const t = h('table', { class: 'kv' }, ...rows.map(([k, v], i) => h('tr', { class: i === 0 ? 'primary' : '' }, h('th', {}, k), h('td', {}, v))));
    const Lc = mp.inertia.map((x) => x * rho * 1e-9);
    const tensor = h(
      'table',
      { class: 'matrix' },
      ...[0, 1, 2].map((r) => h('tr', {}, ...[0, 1, 2].map((c) => h('td', {}, fmtNumber(Lc[r * 3 + c], 3))))),
    );
    out.append(t, h('div', { class: 'sub' }, 'Ten-xơ quán tính tại trọng tâm (kg·mm², hệ toạ độ đầu ra):'), tensor);
    if (!mp.closedHint) out.append(h('div', { class: 'warn' }, 'Lưới có thể không kín — thể tích/khối lượng có thể không chính xác.'));
    if (ctx.explode.isExploded) out.append(h('div', { class: 'warn' }, 'Đang ở chế độ tách rời: trọng tâm tính theo vị trí hiện tại.'));
    out.append(h('div', { class: 'hint' }, `Số tam giác: ${inputs.reduce((s, x) => s + x.indices.length / 3, 0).toLocaleString('vi-VN')} — giá trị tính trên lưới tam giác, sai số phụ thuộc độ mịn.`));
  }
  compute();
  return {
    el: panelShell(
      'Thuộc tính khối lượng',
      'mass',
      ctx.closeTool,
      h('div', { class: 'field' }, h('label', {}, 'Đối tượng'), target),
      h('div', { class: 'field' }, h('label', {}, 'Vật liệu'), mat),
      h('div', { class: 'field' }, h('label', {}, 'Khối lượng riêng (kg/m³)'), dens),
      h('button', { class: 'btn', onclick: compute }, 'Tính lại'),
      out,
    ),
    refresh: compute,
  };
}

// ---------------- File information ----------------
export function infoPanel(model: LoadedModel | null): HTMLElement {
  if (!model) return h('div', { class: 'empty-note' }, 'Chưa mở tài liệu nào.');
  const i = model.info;
  const tris = model.bodies.reduce((s, b) => s + b.indices.length / 3, 0);
  const faces = model.bodies.reduce((s, b) => s + b.faces.length, 0);
  const edges = model.bodies.reduce((s, b) => s + b.edges.length, 0);
  const rows: [string, string][] = [
    ['Tên tệp', i.fileName],
    ['Định dạng', i.format],
    ['Dung lượng', fmtBytes(i.fileSize)],
    ['Loại tài liệu', { part: 'Chi tiết (Part)', assembly: 'Lắp ráp (Assembly)', drawing: 'Bản vẽ (Drawing)' }[model.kind]],
    ['Số thân / mặt / cạnh', `${model.bodies.length} / ${faces.toLocaleString('vi-VN')} / ${edges.toLocaleString('vi-VN')}`],
    ['Số tam giác', tris.toLocaleString('vi-VN')],
    ...Object.entries(i.properties),
  ];
  const el = h('div', { class: 'info' });
  for (const p of i.previews.slice(0, 4)) {
    const img = previewImg(p);
    if (img) el.append(h('figure', { class: 'preview' }, img, h('figcaption', {}, p.name)));
  }
  el.append(h('table', { class: 'kv' }, ...rows.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v)))));
  if (i.warnings.length) el.append(h('div', { class: 'warn-list' }, ...i.warnings.map((w) => h('div', { class: 'warn' }, w))));
  if (i.references.length)
    el.append(h('details', { open: true }, h('summary', {}, `Tệp tham chiếu (${i.references.length})`), h('ul', { class: 'refs' }, ...i.references.map((r) => h('li', {}, r)))));
  if (i.streams?.length)
    el.append(
      h('details', {}, h('summary', {}, `Luồng dữ liệu trong tệp (${i.streams.length})`), h('ul', { class: 'refs mono' }, ...i.streams.map((s) => h('li', {}, `${s.name} — ${fmtBytes(s.size)}`)))),
    );
  return el;
}

export function previewImg(p: { png?: Uint8Array; rgba?: Uint8ClampedArray; width?: number; height?: number }): HTMLImageElement | HTMLCanvasElement | null {
  if (p.png) {
    const img = new Image();
    img.src = URL.createObjectURL(new Blob([p.png as BlobPart], { type: 'image/png' }));
    return img;
  }
  if (p.rgba && p.width && p.height) {
    const c = document.createElement('canvas');
    c.width = p.width;
    c.height = p.height;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(p.rgba), p.width, p.height), 0, 0);
    return c;
  }
  return null;
}
