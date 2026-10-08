/**
 * SolidWorks assembly (.SLDASM, SW2015+) structure.
 *
 * Two streams make an assembly viewable without its part files:
 *
 *  - swXmlContents/COMPINSTANCETREE: an XML component tree. Every configuration
 *    of every referenced model is an <swModel>; component instances are
 *    <swReference> children carrying swModelRef and a 4×4 swTransform (metres,
 *    column-major with the translation in elements 12–14). The assembly's own
 *    configurations are <swConfiguration> entries pointing at their <swModel>.
 *
 *  - FaceTessellations/*: the cached display tessellation of each referenced
 *    model, in that model's own coordinates, stored as DisplayLists face
 *    records. FaceTessellations/Directory maps component paths
 *    ("Child-1@Sub/Grandchild-2@Child") to a block: an 8-byte block id, the
 *    stream name and the block index inside that stream. Instances of the same
 *    model point at the first instance's block id instead of a stream.
 *
 * Layout determined from SW2023 (DisplayLists version 17000) files.
 */
import type { BodyData, ModelNode } from '../../core/types';
import { parseDisplayLists, type DlFace } from './displaylists';
import { bodiesFromDisplayFaces } from './solidworks';
import type { SwStream } from './container';

// ---------------------------------------------------------------- XML tree
export interface SwRef {
  name: string;
  refNumber: string;
  modelRef: string;
  config: string;
  transform: number[] | null;
  suppressed: boolean;
  hidden: boolean;
}
export interface SwModelEntry {
  id: string;
  name: string;
  config: string;
  fileRef: string;
  bbox: number[] | null;
  refs: SwRef[];
}
export interface SwTree {
  files: Map<string, { path: string; type: string }>;
  models: Map<string, SwModelEntry>;
  configs: { name: string; modelRef: string; active: boolean }[];
}

const attrRe = /([\w:]+)="([^"]*)"/g;
function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(attrRe)) out[m[1]] = decodeXml(m[2]);
  return out;
}
function decodeXml(s: string) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
const nums = (s: string | undefined) => (s ? s.trim().split(/\s+/).map(Number) : null);

export function parseCompInstanceTree(xml: string): SwTree {
  const tree: SwTree = { files: new Map(), models: new Map(), configs: [] };
  const stack: SwModelEntry[] = [];
  for (const m of xml.matchAll(/<(\/?)(sw\w+)\b([^>]*?)(\/?)>/g)) {
    const [, close, tag, body, self] = m;
    if (close) {
      if (tag === 'swModel') stack.pop();
      continue;
    }
    const a = attrs(body);
    if (tag === 'swFile') tree.files.set(a.id, { path: a.swPath ?? '', type: a.swDocType ?? '' });
    else if (tag === 'swModel') {
      const entry: SwModelEntry = { id: a.id, name: a.swName ?? '', config: a.swConfigurationName ?? '', fileRef: a.swFileRef ?? '', bbox: nums(a.swBoundingBox), refs: [] };
      tree.models.set(a.id, entry);
      if (!self) stack.push(entry);
    } else if (tag === 'swReference' && stack.length) {
      const t = nums(a.swTransform);
      stack[stack.length - 1].refs.push({
        name: a.swName ?? a.swComponentName ?? '',
        refNumber: a.swReferenceNumber ?? '1',
        modelRef: a.swModelRef ?? '',
        config: a.swConfigurationName ?? '',
        transform: t && t.length === 16 && t.every(Number.isFinite) ? t : null,
        suppressed: a.swSuppressed === 'YES',
        hidden: a.swHidden === 'YES',
      });
    } else if (tag === 'swConfiguration') {
      tree.configs.push({ name: a.swName ?? '', modelRef: a.swModelRef ?? '', active: a.swMostRecentConfiguration === 'YES' });
    }
  }
  return tree;
}

// ---------------------------------------------------------------- tessellation directory
export interface TessEntry {
  path: string;
  blockId: string; // hex of the 8-byte id of the block holding the geometry
  stream: string; // empty when shared with another instance
  blockIndex: number;
}

/** Read an MFC CString (0xFF 0xFE 0xFF, length byte or 0xFF+u16, UTF-16LE). */
function cstring(b: Uint8Array, o: number): { s: string; end: number } | null {
  if (b[o] !== 0xff || b[o + 1] !== 0xfe || b[o + 2] !== 0xff) return null;
  let n = b[o + 3];
  let p = o + 4;
  if (n === 0xff) {
    n = b[p] | (b[p + 1] << 8);
    p += 2;
  }
  if (p + 2 * n > b.length) return null;
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[p + 2 * i] | (b[p + 2 * i + 1] << 8));
  return { s, end: p + 2 * n };
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export function parseTessDirectory(d: Uint8Array): TessEntry[] {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const out: TessEntry[] = [];
  let o = 16;
  while (o < d.length) {
    const path = cstring(d, o);
    if (!path) {
      o++;
      continue;
    }
    // u32 stamp, 8 bytes, 8-byte source block id (zero if none), 8-byte own id
    const p = path.end;
    if (p + 28 > d.length) break;
    const sourceId = d.subarray(p + 12, p + 20);
    const ownId = d.subarray(p + 20, p + 28);
    const stream = cstring(d, p + 28);
    if (!stream) {
      o = p;
      continue;
    }
    const blockIndex = stream.end + 4 <= d.length ? dv.getInt32(stream.end, true) : -1;
    const shared = sourceId.some((x) => x !== 0);
    out.push({ path: path.s, blockId: hex(shared ? sourceId : ownId), stream: stream.s, blockIndex });
    // Trailing fields vary in length; scan for the next CString.
    o = stream.end + 4;
  }
  return out;
}

/** Split the face records of one tessellation stream into blocks keyed by block id. */
export function splitTessBlocks(data: Uint8Array, ids: Map<number, string>): Map<string, DlFace[]> {
  // Block k starts with u32 k followed by its 8-byte id.
  const starts: { off: number; id: string }[] = [];
  for (const [k, id] of ids) {
    const pat = new Uint8Array(12);
    new DataView(pat.buffer).setUint32(0, k, true);
    for (let i = 0; i < 8; i++) pat[4 + i] = parseInt(id.slice(i * 2, i * 2 + 2), 16);
    const off = indexOf(data, pat);
    if (off >= 0) starts.push({ off, id });
  }
  starts.sort((a, b) => a.off - b.off);
  const res = parseDisplayLists(data, false);
  const out = new Map<string, DlFace[]>();
  for (const f of res.faces) {
    let lo = 0, hi = starts.length - 1, at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid].off <= f.offset) {
        at = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (at < 0) continue;
    const id = starts[at].id;
    let l = out.get(id);
    if (!l) out.set(id, (l = []));
    l.push(f);
  }
  return out;
}

function indexOf(h: Uint8Array, n: Uint8Array): number {
  const last = h.length - n.length;
  outer: for (let i = 0; i <= last; i++) {
    if (h[i] !== n[0]) continue;
    for (let j = 1; j < n.length; j++) if (h[i + j] !== n[j]) continue outer;
    return i;
  }
  return -1;
}

// ---------------------------------------------------------------- assembly model
export interface AssemblyBuild {
  root: ModelNode;
  bodies: BodyData[];
  configName: string;
  instanceCount: number;
  withGeometry: number;
  bbox: number[] | null;
}

/** SolidWorks column-major transform (metres) → three.js column-major matrix (mm). */
function toMatrixMm(t: number[]): number[] {
  const m = t.slice();
  m[12] *= 1000;
  m[13] *= 1000;
  m[14] *= 1000;
  return m;
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function buildAssembly(streams: SwStream[], asmName: string, configName?: string): AssemblyBuild | null {
  const xmlStream = streams.find((s) => /COMPINSTANCETREE$/i.test(s.name));
  if (!xmlStream) return null;
  const tree = parseCompInstanceTree(new TextDecoder().decode(xmlStream.data));
  const cfg = (configName && tree.configs.find((c) => c.name === configName)) || tree.configs.find((c) => c.active) || tree.configs[0];
  const top = cfg ? tree.models.get(cfg.modelRef) : null;
  if (!top) return null;

  // Geometry per component path.
  const dirStream = streams.find((s) => /FaceTessellations\/Directory$/i.test(s.name));
  const entries = dirStream ? parseTessDirectory(dirStream.data) : [];
  const blockOfPath = new Map<string, string>();
  const idsByStream = new Map<string, Map<number, string>>();
  for (const e of entries) {
    blockOfPath.set(e.path, e.blockId);
    if (e.stream && e.blockIndex >= 0) {
      let m = idsByStream.get(e.stream);
      if (!m) idsByStream.set(e.stream, (m = new Map()));
      m.set(e.blockIndex, e.blockId);
    }
  }
  const facesOfBlock = new Map<string, DlFace[]>();
  for (const [name, ids] of idsByStream) {
    const s = streams.find((x) => x.name === `FaceTessellations/${name}`);
    if (!s) continue;
    for (const [id, faces] of splitTessBlocks(s.data, ids)) facesOfBlock.set(id, faces);
  }

  const bodies: BodyData[] = [];
  const bodiesOfBlock = new Map<string, number[]>();
  const bodiesFor = (blockId: string, label: string): number[] => {
    let ix = bodiesOfBlock.get(blockId);
    if (ix) return ix;
    const faces = facesOfBlock.get(blockId);
    ix = [];
    if (faces?.length) {
      for (const b of bodiesFromDisplayFaces(faces, label)) {
        ix.push(bodies.length);
        bodies.push(b);
      }
    }
    bodiesOfBlock.set(blockId, ix);
    return ix;
  };

  let instanceCount = 0, withGeometry = 0;
  const topFile = tree.files.get(top.fileRef);
  const topLabel = topFile ? baseName(topFile.path).replace(/\.[^.]+$/, '') : asmName;

  // Component path segments look like "Name-N@Parent" (Parent = file title of the owner).
  const build = (model: SwModelEntry, ownerTitle: string, prefix: string, depth: number): ModelNode[] => {
    const out: ModelNode[] = [];
    if (depth > 20) return out;
    for (const r of model.refs) {
      if (r.suppressed) continue;
      instanceCount++;
      const child = tree.models.get(r.modelRef);
      const seg = `${r.name}-${r.refNumber}@${ownerTitle}`;
      const path = prefix ? `${prefix}/${seg}` : seg;
      const file = child ? tree.files.get(child.fileRef) : undefined;
      const node: ModelNode = {
        name: `${r.name}<${r.refNumber}>${r.config && r.config !== 'Default' ? ` (${r.config})` : ''}`,
        bodies: [],
        children: [],
        matrix: r.transform ? toMatrixMm(r.transform) : undefined,
        refFile: file ? baseName(file.path) : `${r.name}.SLDPRT`,
        hiddenInSource: r.hidden || undefined,
      };
      if (child && child.refs.length) {
        const childTitle = file ? baseName(file.path).replace(/\.[^.]+$/, '') : r.name;
        node.children = build(child, childTitle, path, depth + 1);
      } else {
        const block = blockOfPath.get(path);
        node.bodies = block ? bodiesFor(block, r.name) : [];
        if (node.bodies.length) withGeometry++;
        else {
          node.missing = true;
          node.note = 'Không có lưới lưu sẵn — mở kèm tệp ' + node.refFile;
        }
      }
      out.push(node);
    }
    return out;
  };
  const root: ModelNode = { name: asmName, bodies: [], children: build(top, topLabel, '', 0) };
  return { root, bodies, configName: cfg?.name ?? '', instanceCount, withGeometry, bbox: top.bbox };
}
