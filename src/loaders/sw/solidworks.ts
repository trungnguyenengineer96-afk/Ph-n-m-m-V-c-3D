/**
 * SolidWorks native files (.sldprt / .sldasm / .slddrw) → LoadedModel.
 *
 * What is read:
 *  - Container streams (modern SW2015+ and legacy OLE2).
 *  - Display tessellation (DisplayLists) with B-rep face/edge ids and analytic
 *    surface types (plane / cylinder / cone with exact radius).
 *  - Preview images (PreviewPNG / DIB "Preview" / per-sheet previews).
 *  - Custom properties and document metadata.
 *  - For assemblies/drawings: the referenced component/model file names.
 *
 * What is NOT decoded (no public specification exists): feature history,
 * sketches, mates, component placement inside assemblies, drawing vectors.
 */
import type { BodyData, DocumentKind, EdgeInfo, FaceInfo, FileInfo, ImageData2, LoadedModel, ModelNode, SurfaceInfo } from '../../core/types';
import { chainSegments, DisjointSet } from '../../core/geometry';
import { readContainer, textOf, unwrapLegacyZlb, type SwContainer } from './container';
import { parseDisplayLists, type DlFace } from './displaylists';
import { decodeDib } from './dib';
import { buildAssembly } from './assembly';

const M_TO_MM = 1000;

export function kindFromName(fileName: string): DocumentKind {
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'sldasm' || ext === 'asm') return 'assembly';
  if (ext === 'slddrw' || ext === 'drw') return 'drawing';
  return 'part';
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isPng = (d: Uint8Array) => d.length > 8 && PNG_SIG.every((x, i) => d[i] === x);

function surfaceFromTag(f: DlFace): SurfaceInfo | undefined {
  if (f.typeTag === undefined || !f.direction || !f.parameters) return undefined;
  const p = f.parameters;
  const axis = f.direction;
  switch (f.typeTag) {
    case 4001:
      return { kind: 'plane', axis, exact: true };
    case 4002:
      return { kind: 'cylinder', axis, origin: [p[0] * M_TO_MM, p[1] * M_TO_MM, p[2] * M_TO_MM], radius: p[6] * M_TO_MM, exact: true };
    case 4003:
      return { kind: 'cone', axis, origin: [p[0] * M_TO_MM, p[1] * M_TO_MM, p[2] * M_TO_MM], radius: p[6] * M_TO_MM, halfAngle: p[7], exact: true };
    case 4004:
      return { kind: 'sphere' };
    case 4005:
      return { kind: 'torus' };
    case 4006:
      return { kind: 'bspline' };
    default:
      return { kind: 'other' };
  }
}

/** Build bodies from display faces. Faces sharing a B-rep edge id belong to the same body. */
export function bodiesFromDisplayFaces(dlFaces: DlFace[], baseName: string): BodyData[] {
  const n = dlFaces.length;
  const ds = new DisjointSet(n);
  const edgeOwner = new Map<number, number>();
  dlFaces.forEach((f, fi) => {
    for (const s of f.boundary) {
      const prev = edgeOwner.get(s.id);
      if (prev === undefined) edgeOwner.set(s.id, fi);
      else ds.union(prev, fi);
    }
  });
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = ds.find(i);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(i);
  }
  const list = [...groups.values()].sort((a, b) => a[0] - b[0]);
  return list.map((faceIds, bi) => buildBody(faceIds.map((i) => dlFaces[i]), list.length > 1 ? `${baseName} — Thân ${bi + 1}` : baseName));
}

function buildBody(faces: DlFace[], name: string): BodyData {
  let nv = 0, nt = 0;
  for (const f of faces) {
    nv += f.positions.length / 3;
    nt += f.indices.length / 3;
  }
  const positions = new Float32Array(nv * 3);
  const normals = new Float32Array(nv * 3);
  const indices = new Uint32Array(nt * 3);
  const faceInfos: FaceInfo[] = [];
  const edgeSegs = new Map<number, number[]>();
  let vo = 0, to = 0;
  for (const f of faces) {
    const fv = f.positions.length / 3;
    for (let i = 0; i < f.positions.length; i++) positions[vo * 3 + i] = f.positions[i] * M_TO_MM;
    normals.set(f.normals, vo * 3);
    for (let i = 0; i < f.indices.length; i++) indices[to * 3 + i] = f.indices[i] + vo;
    faceInfos.push({ triStart: to, triCount: f.indices.length / 3, surface: surfaceFromTag(f), sourceId: f.faceId });
    // Each B-rep edge appears in both adjacent faces; keep the first copy.
    const local = new Map<number, number[]>();
    for (const s of f.boundary) {
      if (edgeSegs.has(s.id)) continue;
      let arr = local.get(s.id);
      if (!arr) local.set(s.id, (arr = []));
      const a = s.a * 3, b = s.b * 3;
      arr.push(
        f.positions[a] * M_TO_MM, f.positions[a + 1] * M_TO_MM, f.positions[a + 2] * M_TO_MM,
        f.positions[b] * M_TO_MM, f.positions[b + 1] * M_TO_MM, f.positions[b + 2] * M_TO_MM,
      );
    }
    for (const [id, arr] of local) edgeSegs.set(id, arr);
    vo += fv;
    to += f.indices.length / 3;
  }
  const edges: EdgeInfo[] = [];
  for (const [id, seg] of edgeSegs) for (const c of chainSegments(seg)) edges.push({ points: c.points, closed: c.closed, sourceId: id });
  return { name, positions, normals, indices, faces: faceInfos, edges };
}

function parseXmlProps(xml: string, out: Record<string, string>) {
  const re = /<property\b[^>]*\bname="([^"]+)"[^>]*>\s*<vt:\w+>([^<]*)<\/vt:\w+>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out[decodeXml(m[1])] = decodeXml(m[2]);
}

function parseCoreProps(xml: string, out: Record<string, string>) {
  const map: Record<string, string> = {
    'dc:title': 'Tiêu đề',
    'dc:creator': 'Người tạo',
    'cp:lastModifiedBy': 'Sửa lần cuối bởi',
    'dcterms:created': 'Ngày tạo',
    'dcterms:modified': 'Ngày sửa',
    'dc:subject': 'Chủ đề',
    'cp:keywords': 'Từ khoá',
  };
  for (const [tag, label] of Object.entries(map)) {
    const m = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`).exec(xml);
    if (m && m[1].trim()) out[label] = decodeXml(m[1].trim());
  }
}

function decodeXml(s: string) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** Collect referenced SolidWorks file names from ASCII and UTF-16LE strings in all streams. */
export function findReferences(c: SwContainer, selfName: string): string[] {
  const refs = new Map<string, string>();
  const reAscii = /([A-Za-z]:\\[^\x00-\x1f"<>|*?]{1,240}?|[^\x00-\x1f"<>|*?\\/:]{1,200}?)\.(sldprt|sldasm|slddrw)/gi;
  const add = (raw: string) => {
    const base = raw.split(/[\\/]/).pop()!.trim();
    if (!base || base.length < 8) return;
    if (base.toLowerCase() === selfName.toLowerCase()) return;
    if (!/^[\p{L}\p{N} _\-().,+#&'[\]]+\.(sldprt|sldasm|slddrw)$/iu.test(base)) return;
    const key = base.toLowerCase();
    if (!refs.has(key)) refs.set(key, base);
  };
  for (const s of c.streams) {
    if (/displaylist|partition|preview/i.test(s.name)) continue;
    const d = s.data;
    // ASCII view.
    let ascii = '';
    for (let i = 0; i < d.length; i++) ascii += d[i] >= 0x20 && d[i] < 0x7f ? String.fromCharCode(d[i]) : '\n';
    for (const m of ascii.matchAll(reAscii)) add(m[0]);
    // UTF-16LE view at both alignments.
    for (let off = 0; off < 2; off++) {
      let u = '';
      for (let i = off; i + 1 < d.length; i += 2) {
        const ch = d[i] | (d[i + 1] << 8);
        u += ch >= 0x20 && ch !== 0xfffe && ch !== 0xffff && !(ch >= 0xd800 && ch <= 0xdfff) ? String.fromCharCode(ch) : '\n';
      }
      for (const m of u.matchAll(reAscii)) add(m[0]);
    }
  }
  return [...refs.values()];
}

export function loadSolidWorks(buf: Uint8Array, fileName: string): LoadedModel {
  const kind = kindFromName(fileName);
  const baseName = fileName.replace(/\.[^.]+$/, '');
  const c = readContainer(buf);
  const info: FileInfo = {
    format: `SolidWorks ${kind === 'part' ? 'Part' : kind === 'assembly' ? 'Assembly' : 'Drawing'} (${c.format === 'modern' ? 'SW2015+' : 'OLE2, ≤ SW2014'})`,
    fileName,
    fileSize: buf.length,
    properties: {},
    streams: c.streams.map((s) => ({ name: s.name, size: s.data.length })),
    previews: [],
    references: [],
    warnings: [...c.warnings],
  };
  if (!c.streams.length) throw new Error('Không tìm thấy dữ liệu SolidWorks hợp lệ trong tệp (tệp hỏng hoặc phiên bản trước 2011?)');

  // ---- metadata ----
  for (const s of c.streams) {
    const lower = s.name.toLowerCase();
    if (lower.endsWith('custom.xml') || /config-\d+-properties\.xml$/.test(lower)) parseXmlProps(textOf(s.data), info.properties);
    else if (lower.endsWith('core.xml')) parseCoreProps(textOf(s.data), info.properties);
  }
  const ver = c.streams.map((s) => /_MO_VERSION_(\d+)/.exec(s.name)?.[1]).find(Boolean);
  if (ver) info.properties['Phiên bản định dạng'] = ver;

  // ---- previews ----
  const previews: ImageData2[] = [];
  for (const s of c.streams) {
    if (isPng(s.data)) previews.push({ name: s.name, png: s.data });
  }
  if (!previews.length) {
    for (const s of c.streams) {
      if (!/preview/i.test(s.name)) continue;
      const img = decodeDib(s.data);
      if (img) previews.push({ name: s.name, rgba: img.rgba, width: img.width, height: img.height });
    }
  }
  // Main preview first; per-configuration previews are often blank placeholders.
  previews.sort((a, b) => rank(a.name) - rank(b.name));
  info.previews = previews.filter((p, i) => i === 0 || !/^Config-\d+-Preview/.test(p.name));

  // ---- geometry ----
  const dlStreams = c.streams.filter((s) => /displaylists?(__zlb)?$/i.test(s.name.split('/').pop() || ''));
  const bodies: BodyData[] = [];
  const dlErrors: string[] = [];
  for (const s of dlStreams) {
    try {
      const legacy = c.format === 'ole2';
      let data = s.data;
      if (/__zlb$/i.test(s.name)) data = unwrapLegacyZlb(data);
      const r = parseDisplayLists(data, legacy);
      info.warnings.push(...r.warnings);
      if (r.faces.length) bodies.push(...bodiesFromDisplayFaces(r.faces, dlStreams.length > 1 ? `${baseName} [${s.name}]` : baseName));
    } catch (e) {
      dlErrors.push((e as Error).message);
    }
  }

  const references = kind === 'part' ? [] : findReferences(c, fileName);
  info.references = references;

  let root: ModelNode = { name: baseName, bodies: [], children: [] };
  // Assemblies: component tree with placements, and cached part tessellations.
  const asm = kind === 'assembly' ? buildAssembly(c.streams, baseName) : null;
  if (asm && asm.root.children.length) {
    bodies.length = 0;
    bodies.push(...asm.bodies);
    root = asm.root;
    info.properties['Cấu hình đang dùng'] = asm.configName;
    info.properties['Số thành phần'] = String(asm.instanceCount);
    const missing = countMissing(root);
    if (missing)
      info.warnings.push(
        `${missing} thành phần không có lưới lưu sẵn trong tệp lắp ráp. Mở kèm các tệp chi tiết (hoặc cả thư mục) để nạp — chúng sẽ được đặt đúng vị trí.`,
      );
  } else {
    if (bodies.length === 1) root.bodies = [0];
    else bodies.forEach((b, i) => root.children.push({ name: b.name.replace(`${baseName} — `, ''), bodies: [i], children: [] }));
    if (kind !== 'part') {
      for (const r of references)
        root.children.push({ name: r, bodies: [], children: [], missing: true, refFile: r, note: 'Tham chiếu — mở kèm tệp này để nạp' });
    }
  }

  // Drawings: one image per sheet, named from SheetPreviews/SheetNames when present.
  if (kind === 'drawing') {
    const sheets = drawingSheets(c);
    if (sheets.length) {
      info.previews = previews.filter((p) => !/^Images\/Sheet_/.test(p.name)).concat(sheets.slice(0, 1));
      info.properties['Số trang bản vẽ'] = String(sheets.length);
      previews.length = 0;
      previews.push(...sheets);
    }
  }

  if (!bodies.length) {
    if (kind === 'part')
      info.warnings.push(
        'Không đọc được lưới hiển thị (DisplayLists) trong tệp này' + (dlErrors.length ? `: ${dlErrors[0]}` : '') + '. Chỉ hiển thị ảnh xem trước.',
      );
    else if (kind === 'assembly')
      info.warnings.push(
        'Tệp lắp ráp này không có cây thành phần đọc được (phiên bản cũ?). Hãy mở cùng lúc tệp .SLDASM và các tệp .SLDPRT, hoặc xuất STEP từ SolidWorks.',
      );
    else
      info.warnings.push(
        'Bản vẽ SolidWorks hiển thị bằng ảnh trang lưu sẵn trong tệp (độ phân giải do SolidWorks lưu). Để đo chính xác trên bản vẽ hãy xuất DXF từ SolidWorks.',
      );
  }

  const model: LoadedModel = { kind, name: baseName, root, bodies, info };
  if (kind === 'drawing' || !bodies.length) model.sheets = previews;
  return model;
}


function countMissing(n: ModelNode): number {
  return (n.missing ? 1 : 0) + n.children.reduce((s, c) => s + countMissing(c), 0);
}

/** Read an MFC CString list (u16/u32 count, then 0xFF 0xFE 0xFF + length + UTF-16LE). */
function readCStrings(d: Uint8Array): string[] {
  const out: string[] = [];
  for (let o = 0; o + 4 <= d.length; ) {
    if (d[o] === 0xff && d[o + 1] === 0xfe && d[o + 2] === 0xff) {
      let n = d[o + 3];
      let p = o + 4;
      if (n === 0xff) {
        n = d[p] | (d[p + 1] << 8);
        p += 2;
      }
      let s = '';
      for (let i = 0; i < n && p + 2 * i + 1 < d.length; i++) s += String.fromCharCode(d[p + 2 * i] | (d[p + 2 * i + 1] << 8));
      out.push(s);
      o = p + 2 * n;
    } else o++;
  }
  return out;
}

function drawingSheets(c: SwContainer): ImageData2[] {
  const imgs = c.streams
    .map((s) => ({ s, m: /^Images\/Sheet_(\d+)$/.exec(s.name) }))
    .filter((x) => x.m && isPng(x.s.data))
    .sort((a, b) => Number(a.m![1]) - Number(b.m![1]));
  const namesStream = c.streams.find((s) => /SheetNames$/i.test(s.name));
  const names = namesStream ? readCStrings(namesStream.data) : [];
  // SheetNames does not always list every sheet; only trust it when the counts agree.
  const useNames = names.length === imgs.length;
  return imgs.map((x, i) => ({ name: useNames ? names[i] : `Trang ${Number(x.m![1]) + 1}`, png: x.s.data }));
}

function rank(name: string) {
  if (name === 'PreviewPNG') return 0;
  if (name === 'Preview') return 1;
  if (/^Images\//.test(name)) return 3;
  return 2;
}
