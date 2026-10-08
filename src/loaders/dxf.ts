/** DXF drawings → a lines-only body with analytic edges (lines, arcs, circles) and text. */
import DxfParser from 'dxf-parser';
import type { BodyData, EdgeInfo, LoadedModel, TextItem, Vec3 } from '../core/types';

type P = { x: number; y: number; z?: number };
// dxf-parser's entity typings are per-type; we read them structurally.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ent = any;

interface Xf {
  // 2D affine: x' = a*x + c*y + e ; y' = b*x + d*y + f
  a: number; b: number; c: number; d: number; e: number; f: number;
}
const ID: Xf = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const apply = (t: Xf, x: number, y: number): [number, number] => [t.a * x + t.c * y + t.e, t.b * x + t.d * y + t.f];
const compose = (p: Xf, q: Xf): Xf => ({
  a: p.a * q.a + p.c * q.b,
  b: p.b * q.a + p.d * q.b,
  c: p.a * q.c + p.c * q.d,
  d: p.b * q.c + p.d * q.d,
  e: p.a * q.e + p.c * q.f + p.e,
  f: p.b * q.e + p.d * q.f + p.f,
});
const uniformScale = (t: Xf) => {
  const sx = Math.hypot(t.a, t.b), sy = Math.hypot(t.c, t.d);
  return Math.abs(sx - sy) < 1e-9 * Math.max(sx, sy, 1) ? sx : null;
};

function rgbOf(color: number | undefined): Vec3 {
  if (color === undefined || color === null || color < 0) return [0.1, 0.1, 0.1];
  // White/near white lines are drawn dark on the light drawing background.
  if (color >= 0xf0f0f0) return [0.1, 0.1, 0.1];
  return [((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255];
}

export function cleanMText(s: string): string {
  return s
    .replace(/\\P/g, '\n')
    .replace(/\\[ACFHQTWfhcpLlOoKk][^;\\{}]*;?/g, '')
    .replace(/\\S([^;]*)\^([^;]*);/g, '$1/$2')
    .replace(/[{}]/g, '')
    .replace(/%%[cC]/g, 'Ø')
    .replace(/%%[dD]/g, '°')
    .replace(/%%[pP]/g, '±')
    .replace(/\\~/g, ' ');
}

function arcPoints(cx: number, cy: number, r: number, a0: number, a1: number, full: boolean): number[] {
  let sweep = full ? Math.PI * 2 : a1 - a0;
  if (!full) while (sweep <= 0) sweep += Math.PI * 2;
  const n = Math.max(8, Math.ceil((Math.abs(sweep) / (Math.PI * 2)) * 72));
  const pts: number[] = [];
  const count = full ? n : n + 1;
  for (let i = 0; i < count; i++) {
    const t = a0 + (sweep * i) / n;
    pts.push(cx + r * Math.cos(t), cy + r * Math.sin(t));
  }
  return pts;
}

/** Points of a polyline with bulges (LWPOLYLINE / POLYLINE). */
function bulgePolyline(vs: { x: number; y: number; bulge?: number }[], closed: boolean): number[] {
  const out: number[] = [];
  const n = vs.length;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = vs[i], p1 = vs[(i + 1) % n];
    if (i === 0) out.push(p0.x, p0.y);
    const b = p0.bulge || 0;
    if (Math.abs(b) < 1e-9) {
      out.push(p1.x, p1.y);
      continue;
    }
    const theta = 4 * Math.atan(b);
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const chord = Math.hypot(dx, dy);
    if (chord < 1e-12) continue;
    const r = chord / (2 * Math.sin(theta / 2));
    const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
    const h = r * Math.cos(theta / 2);
    const cx = mx - (dy / chord) * h, cy = my + (dx / chord) * h;
    const a0 = Math.atan2(p0.y - cy, p0.x - cx);
    const steps = Math.max(4, Math.ceil((Math.abs(theta) / (Math.PI * 2)) * 72));
    for (let k = 1; k <= steps; k++) {
      const t = a0 + (theta * k) / steps;
      out.push(cx + Math.abs(r) * Math.cos(t), cy + Math.abs(r) * Math.sin(t));
    }
  }
  if (closed && out.length >= 4) {
    // drop duplicated closing point
    const L = out.length;
    if (Math.abs(out[0] - out[L - 2]) < 1e-12 && Math.abs(out[1] - out[L - 1]) < 1e-12) out.length = L - 2;
  }
  return out;
}

/** Evaluate a B-spline (non-rational approximation if weights are absent). */
function splinePoints(e: Ent): number[] {
  const cps: P[] = e.controlPoints || [];
  const knots: number[] = e.knotValues || [];
  const deg: number = e.degreeOfSplineCurve || 3;
  if (cps.length >= deg + 1 && knots.length === cps.length + deg + 1) {
    const out: number[] = [];
    const t0 = knots[deg], t1 = knots[knots.length - deg - 1];
    const n = Math.max(16, cps.length * 8);
    for (let s = 0; s <= n; s++) {
      const t = Math.min(t0 + ((t1 - t0) * s) / n, t1 - 1e-12);
      let k = deg;
      while (k < knots.length - deg - 2 && t >= knots[k + 1]) k++;
      const d = Array.from({ length: deg + 1 }, (_, j) => ({ x: cps[j + k - deg].x, y: cps[j + k - deg].y }));
      for (let r = 1; r <= deg; r++)
        for (let j = deg; j >= r; j--) {
          const i = j + k - deg;
          const den = knots[i + deg - r + 1] - knots[i];
          const alpha = den === 0 ? 0 : (t - knots[i]) / den;
          d[j] = { x: (1 - alpha) * d[j - 1].x + alpha * d[j].x, y: (1 - alpha) * d[j - 1].y + alpha * d[j].y };
        }
      out.push(d[deg].x, d[deg].y);
    }
    return out;
  }
  const pts: P[] = e.fitPoints?.length ? e.fitPoints : cps;
  return pts.flatMap((p) => [p.x, p.y]);
}

export function loadDxf(text: string, fileName: string, fileSize: number): LoadedModel {
  const parser = new DxfParser();
  const dxf = parser.parseSync(text);
  if (!dxf) throw new Error('Không đọc được tệp DXF');
  const edges: EdgeInfo[] = [];
  const colors: Vec3[] = [];
  const texts: TextItem[] = [];
  const warnings: string[] = [];
  const skipped = new Map<string, number>();
  const layers: Record<string, { color?: number; visible?: boolean; frozen?: boolean }> =
    (dxf.tables as Ent)?.layer?.layers || {};

  const colorFor = (e: Ent, inherited?: number) => {
    let c = e.color;
    if (e.colorIndex === 0 && inherited !== undefined) c = inherited; // BYBLOCK
    if (c === undefined || e.colorIndex === 256) c = layers[e.layer]?.color;
    return c;
  };

  const pushPoly = (flat: number[], closed: boolean, t: Xf, color: number | undefined, extra?: Partial<EdgeInfo>) => {
    const n = flat.length / 2;
    if (n < 2) return;
    const pts = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const [x, y] = apply(t, flat[i * 2], flat[i * 2 + 1]);
      pts[i * 3] = x;
      pts[i * 3 + 1] = y;
      pts[i * 3 + 2] = 0;
    }
    edges.push({ points: pts, closed, ...extra });
    colors.push(rgbOf(color));
  };

  const emit = (e: Ent, t: Xf, depth: number, inheritedColor?: number) => {
    const layer = layers[e.layer];
    if (e.visible === false || layer?.visible === false || layer?.frozen) return;
    const color = colorFor(e, inheritedColor);
    switch (e.type) {
      case 'LINE': {
        const v: P[] = e.vertices;
        pushPoly([v[0].x, v[0].y, v[1].x, v[1].y], false, t, color);
        break;
      }
      case 'LWPOLYLINE':
      case 'POLYLINE': {
        const vs = (e.vertices || []).filter((v: Ent) => !v.faces);
        pushPoly(bulgePolyline(vs, !!e.shape), !!e.shape, t, color);
        break;
      }
      case 'CIRCLE':
      case 'ARC': {
        const full = e.type === 'CIRCLE';
        const flat = arcPoints(e.center.x, e.center.y, e.radius, full ? 0 : e.startAngle, full ? 0 : e.endAngle, full);
        const s = uniformScale(t);
        const [cx, cy] = apply(t, e.center.x, e.center.y);
        const extra: Partial<EdgeInfo> = s
          ? { kind: full ? 'circle' : 'arc', center: [cx, cy, 0], radius: e.radius * s, normal: [0, 0, 1] }
          : {};
        if (extra.kind) {
          let sweep = full ? Math.PI * 2 : e.endAngle - e.startAngle;
          while (sweep <= 0) sweep += Math.PI * 2;
          extra.length = e.radius * s! * sweep;
        }
        pushPoly(flat, full, t, color, extra);
        break;
      }
      case 'ELLIPSE': {
        const c = e.center, m = e.majorAxisEndPoint;
        const a = Math.hypot(m.x, m.y), rot = Math.atan2(m.y, m.x), bAx = a * e.axisRatio;
        let s0 = e.startAngle ?? 0, s1 = e.endAngle ?? Math.PI * 2;
        while (s1 <= s0) s1 += Math.PI * 2;
        const full = Math.abs(s1 - s0 - Math.PI * 2) < 1e-6;
        const n = 72;
        const flat: number[] = [];
        for (let i = 0; i <= (full ? n - 1 : n); i++) {
          const u = s0 + ((s1 - s0) * i) / n;
          const x = a * Math.cos(u), y = bAx * Math.sin(u);
          flat.push(c.x + x * Math.cos(rot) - y * Math.sin(rot), c.y + x * Math.sin(rot) + y * Math.cos(rot));
        }
        pushPoly(flat, full, t, color);
        break;
      }
      case 'SPLINE':
        pushPoly(splinePoints(e), !!e.closed, t, color);
        break;
      case 'SOLID':
      case '3DFACE': {
        const v: P[] = (e.points || e.vertices || []).slice(0, 4);
        if (v.length >= 3) pushPoly(v.flatMap((p) => [p.x, p.y]), true, t, color);
        break;
      }
      case 'TEXT':
      case 'MTEXT':
      case 'ATTDEF': {
        const p: P = e.position || e.startPoint;
        if (!p || !e.text) break;
        const [x, y] = apply(t, p.x, p.y);
        const sc = uniformScale(t) ?? 1;
        let rot = ((e.rotation || 0) * Math.PI) / 180;
        if (e.directionVector) rot = Math.atan2(e.directionVector.y, e.directionVector.x);
        rot += Math.atan2(t.b, t.a);
        texts.push({
          text: cleanMText(e.text),
          position: [x, y, 0],
          height: (e.textHeight || e.height || 2.5) * sc,
          rotation: rot,
          color: rgbOf(color),
          anchor: e.type === 'MTEXT' && (e.attachmentPoint ?? 1) <= 3 ? 'top' : 'baseline',
        });
        break;
      }
      case 'INSERT':
      case 'DIMENSION': {
        if (depth > 12) break;
        const blk = dxf.blocks?.[e.type === 'INSERT' ? e.name : e.block];
        if (!blk) break;
        const base = blk.position || { x: 0, y: 0 };
        let xf = ID;
        if (e.type === 'INSERT') {
          const sx = e.xScale ?? 1, sy = e.yScale ?? 1;
          const r = ((e.rotation || 0) * Math.PI) / 180;
          const cos = Math.cos(r), sin = Math.sin(r);
          const pos = e.position || { x: 0, y: 0 };
          // translate(pos) * rotate(r) * scale(sx,sy) * translate(-base)
          const local: Xf = { a: cos * sx, b: sin * sx, c: -sin * sy, d: cos * sy, e: 0, f: 0 };
          local.e = pos.x - (local.a * base.x + local.c * base.y);
          local.f = pos.y - (local.b * base.x + local.d * base.y);
          xf = local;
        }
        const cols = e.type === 'INSERT' ? Math.max(1, e.columnCount || 1) : 1;
        const rows = e.type === 'INSERT' ? Math.max(1, e.rowCount || 1) : 1;
        for (let ci = 0; ci < cols; ci++)
          for (let ri = 0; ri < rows; ri++) {
            const off: Xf = { ...ID, e: ci * (e.columnSpacing || 0), f: ri * (e.rowSpacing || 0) };
            const tt = compose(t, compose(off, xf));
            for (const be of blk.entities || []) emit(be, tt, depth + 1, color);
          }
        break;
      }
      case 'POINT':
      case 'VIEWPORT':
      case 'ATTRIB':
        break;
      default:
        skipped.set(e.type, (skipped.get(e.type) || 0) + 1);
    }
  };

  const all: Ent[] = dxf.entities || [];
  const model = all.filter((e) => !e.inPaperSpace);
  for (const e of model.length ? model : all) emit(e, ID, 0);
  for (const [type, n] of skipped) warnings.push(`Bỏ qua ${n} đối tượng ${type} chưa hỗ trợ`);
  if (!edges.length && !texts.length) throw new Error('Bản vẽ DXF không có đối tượng hiển thị được');

  const baseName = fileName.replace(/\.[^.]+$/, '');
  const body: BodyData = {
    name: baseName,
    positions: new Float32Array(0),
    indices: new Uint32Array(0),
    faces: [],
    edges,
    edgeColors: colors,
    texts,
    linesOnly: true,
  };
  return {
    kind: 'drawing',
    name: baseName,
    root: { name: baseName, bodies: [0], children: [] },
    bodies: [body],
    is2D: true,
    info: {
      format: 'DXF (AutoCAD Drawing Exchange)',
      fileName,
      fileSize,
      properties: {
        'Số đối tượng': String(edges.length),
        'Số chữ': String(texts.length),
        'Đơn vị ($INSUNITS)': String((dxf.header as Ent)?.$INSUNITS ?? 'không rõ'),
      },
      previews: [],
      references: [],
      warnings,
    },
  };
}
