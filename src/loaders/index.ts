/** Main-thread entry for loading any supported file into a LoadedModel. */
import * as THREE from 'three';
import type { LoadedModel, Vec3 } from '../core/types';
import type { OcctResult, RawMesh, RawNode } from './convert';
import type { WorkerRequest, WorkerResponse } from './parse.worker';
import { cacheGet, cacheKey, cachePut } from './cache';

export const SUPPORTED = {
  solidworks: ['sldprt', 'sldasm', 'slddrw', 'prtdot', 'asmdot', 'drwdot'],
  occt: ['step', 'stp', 'iges', 'igs', 'brep', 'brp'],
  mesh: ['stl', 'obj', 'gltf', 'glb', '3mf', 'ply'],
  drawing: ['dxf'],
};
export const ACCEPT = Object.values(SUPPORTED)
  .flat()
  .map((e) => '.' + e)
  .join(',');

export const extOf = (name: string) => (name.toLowerCase().split('.').pop() || '').trim();

export function isSupported(name: string) {
  const e = extOf(name);
  return Object.values(SUPPORTED).some((l) => l.includes(e));
}

// ---------- worker plumbing ----------
let parseWorker: Worker | null = null;
let seq = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; worker: Worker }>();

function onReply(ev: MessageEvent<{ id: number; error?: string }>) {
  const p = pending.get(ev.data.id);
  if (!p) return;
  pending.delete(ev.data.id);
  if (ev.data.error) p.reject(new Error(ev.data.error));
  else p.resolve(ev.data);
}

function getParseWorker() {
  if (!parseWorker) {
    parseWorker = new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' });
    parseWorker.onmessage = onReply;
  }
  return parseWorker;
}

/**
 * A small pool of OpenCascade workers so several STEP/IGES files load in
 * parallel. Each worker holds its own WebAssembly instance, so the pool is
 * kept small to bound memory.
 */
const OCCT_POOL = Math.max(1, Math.min(3, Math.floor((navigator.hardwareConcurrency || 2) / 2)));
const occtWorkers: Worker[] = [];

function busyCount(w: Worker) {
  let n = 0;
  for (const p of pending.values()) if (p.worker === w) n++;
  return n;
}

function getOcctWorker() {
  const idle = occtWorkers.find((w) => busyCount(w) === 0);
  if (idle) return idle;
  if (occtWorkers.length < OCCT_POOL) {
    const w = new Worker(new URL(`${import.meta.env.BASE_URL}occt/occt-worker.js`, location.href));
    w.onmessage = onReply;
    w.onerror = (e) => {
      for (const [id, p] of pending)
        if (p.worker === w) {
          p.reject(new Error('Lỗi tải OpenCascade: ' + (e.message || 'không rõ')));
          pending.delete(id);
        }
      occtWorkers.splice(occtWorkers.indexOf(w), 1);
    };
    occtWorkers.push(w);
    return w;
  }
  return occtWorkers.reduce((a, b) => (busyCount(b) < busyCount(a) ? b : a));
}

function call<T>(w: Worker, msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
  const id = seq++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, worker: w });
    w.postMessage({ ...msg, id }, transfer);
  });
}

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

async function parseInWorker(req: WithoutId<WorkerRequest>, transfer: Transferable[]): Promise<LoadedModel> {
  const res = await call<WorkerResponse & { model: LoadedModel }>(getParseWorker(), req as Record<string, unknown>, transfer);
  return res.model;
}

// ---------- OpenCascade ----------
export interface TessellationQuality {
  linearDeflection: number; // ratio of bounding box
  angularDeflection: number; // radians
}
export const QUALITY: Record<string, TessellationQuality> = {
  low: { linearDeflection: 0.003, angularDeflection: 0.8 },
  normal: { linearDeflection: 0.001, angularDeflection: 0.5 },
  high: { linearDeflection: 0.0003, angularDeflection: 0.25 },
};

interface DesktopImport {
  importNative?(name: string, data: ArrayBuffer, linearDeflection: number, angularDeflection: number): Promise<ArrayBuffer>;
}

async function loadOcct(buffer: ArrayBuffer, fileName: string, quality: TessellationQuality): Promise<LoadedModel> {
  const e = extOf(fileName);
  const format = e === 'step' || e === 'stp' ? 'step' : e === 'iges' || e === 'igs' ? 'iges' : 'brep';
  const size = buffer.byteLength;
  const params = {
    linearUnit: 'millimeter',
    linearDeflectionType: 'bounding_box_ratio',
    linearDeflection: quality.linearDeflection,
    angularDeflection: quality.angularDeflection,
  };
  const label = { step: 'STEP (ISO 10303)', iges: 'IGES', brep: 'OpenCascade BREP' }[format];
  // Desktop app: the bundled native OpenCascade importer is several times faster
  // than the WebAssembly build; fall back to WebAssembly if it fails.
  const desktop = (globalThis as { cadDesktop?: DesktopImport }).cadDesktop;
  if (desktop?.importNative) {
    try {
      const out = await desktop.importNative(fileName, buffer, quality.linearDeflection, quality.angularDeflection);
      return await parseInWorker({ type: 'cvmesh', buffer: out, fileName, format: label, fileSize: size }, [out]);
    } catch (e) {
      console.warn('Native importer failed, using WebAssembly:', e);
    }
  }
  const res = await call<{ result: OcctResult }>(getOcctWorker(), { format, buffer, params }, [buffer]);
  const transfer: Transferable[] = [];
  for (const m of res.result.meshes) {
    transfer.push(m.attributes.position.array.buffer as ArrayBuffer, m.index.array.buffer as ArrayBuffer);
    if (m.attributes.normal) transfer.push(m.attributes.normal.array.buffer as ArrayBuffer);
  }
  return parseInWorker({ type: 'occt', result: res.result, fileName, format: label, fileSize: size }, transfer);
}

// ---------- mesh formats via three.js loaders ----------
async function loadMeshFormat(buffer: ArrayBuffer, fileName: string): Promise<LoadedModel> {
  const e = extOf(fileName);
  let object: THREE.Object3D;
  if (e === 'stl') {
    const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
    const g = new STLLoader().parse(buffer);
    object = new THREE.Mesh(g);
    object.name = fileName.replace(/\.[^.]+$/, '');
  } else if (e === 'obj') {
    const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
    object = new OBJLoader().parse(new TextDecoder().decode(buffer));
  } else if (e === 'ply') {
    const { PLYLoader } = await import('three/examples/jsm/loaders/PLYLoader.js');
    object = new THREE.Mesh(new PLYLoader().parse(buffer));
  } else if (e === '3mf') {
    const { ThreeMFLoader } = await import('three/examples/jsm/loaders/3MFLoader.js');
    object = new ThreeMFLoader().parse(buffer);
  } else {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const gltf = await new GLTFLoader().parseAsync(buffer, '');
    object = gltf.scene;
    // glTF is metres by convention.
    object.scale.multiplyScalar(1000);
  }
  object.updateMatrixWorld(true);
  const meshes: RawMesh[] = [];
  const conv = (o: THREE.Object3D): RawNode => {
    const node: RawNode = { name: o.name || ((o as THREE.Mesh).isMesh ? 'Thân' : 'Nhóm'), meshes: [], children: [] };
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry?.attributes.position) {
      const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      const pos = g.attributes.position as THREE.BufferAttribute;
      const positions = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) positions.set([pos.getX(i), pos.getY(i), pos.getZ(i)], i * 3);
      const indices = g.index ? new Uint32Array(g.index.array) : null;
      const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial | undefined;
      let color: Vec3 | undefined;
      if (mat?.color && !(e === 'stl' || e === 'ply')) color = [mat.color.r, mat.color.g, mat.color.b];
      node.meshes.push(meshes.length);
      meshes.push({ name: mesh.name || `Thân ${meshes.length + 1}`, positions, indices, color });
    }
    for (const c of o.children) {
      const child = conv(c);
      if (child.meshes.length || child.children.length) node.children.push(child);
    }
    // Collapse trivial wrappers.
    if (!node.meshes.length && node.children.length === 1) return node.children[0];
    return node;
  };
  const tree = conv(object);
  tree.name = fileName.replace(/\.[^.]+$/, '');
  if (!meshes.length) throw new Error('Tệp không chứa lưới tam giác nào');
  const transfer: Transferable[] = [];
  for (const m of meshes) {
    transfer.push(m.positions.buffer as ArrayBuffer);
    if (m.indices) transfer.push(m.indices.buffer as ArrayBuffer);
  }
  const label = { stl: 'STL', obj: 'Wavefront OBJ', ply: 'PLY', '3mf': '3MF', gltf: 'glTF', glb: 'glTF (GLB)' }[e] || e.toUpperCase();
  return parseInWorker({ type: 'meshes', meshes, tree, fileName, format: label, fileSize: buffer.byteLength }, transfer);
}

export async function loadFile(file: File, quality: TessellationQuality = QUALITY.normal): Promise<LoadedModel> {
  const e = extOf(file.name);
  const isOcct = SUPPORTED.occt.includes(e);
  const cacheable = isOcct || SUPPORTED.solidworks.includes(e);
  const key = cacheKey(file, isOcct ? `${quality.linearDeflection}/${quality.angularDeflection}` : 'sw');
  if (cacheable && file.size > 256 * 1024) {
    const hit = await cacheGet(key);
    if (hit) {
      hit.info.properties['Nguồn'] = 'Bộ nhớ đệm (mở lại nhanh)';
      return hit;
    }
  }
  const model = await loadUncached(file, e, quality);
  if (cacheable && file.size > 256 * 1024) void cachePut(key, model);
  return model;
}

async function loadUncached(file: File, e: string, quality: TessellationQuality): Promise<LoadedModel> {
  const buffer = await file.arrayBuffer();
  if (SUPPORTED.solidworks.includes(e)) return parseInWorker({ type: 'sw', buffer, fileName: file.name }, [buffer]);
  if (SUPPORTED.drawing.includes(e)) return parseInWorker({ type: 'dxf', buffer, fileName: file.name }, [buffer]);
  if (SUPPORTED.occt.includes(e)) return loadOcct(buffer, file.name, quality);
  if (SUPPORTED.mesh.includes(e)) return loadMeshFormat(buffer, file.name);
  throw new Error(`Định dạng .${e} chưa được hỗ trợ`);
}
