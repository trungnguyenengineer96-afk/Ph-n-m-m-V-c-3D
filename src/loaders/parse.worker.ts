/// <reference lib="webworker" />
/** Off-main-thread parsing and mesh post-processing. */
import type { LoadedModel } from '../core/types';
import { loadSolidWorks } from './sw/solidworks';
import { loadDxf } from './dxf';
import { fromOcct, fromRawMeshes, type OcctResult, type RawMesh, type RawNode } from './convert';

export type WorkerRequest =
  | { id: number; type: 'sw'; buffer: ArrayBuffer; fileName: string }
  | { id: number; type: 'dxf'; buffer: ArrayBuffer; fileName: string }
  | { id: number; type: 'occt'; result: OcctResult; fileName: string; format: string; fileSize: number }
  | { id: number; type: 'meshes'; meshes: RawMesh[]; tree: RawNode; fileName: string; format: string; fileSize: number };

export type WorkerResponse = { id: number; model: LoadedModel } | { id: number; error: string };

function transferables(m: LoadedModel): Transferable[] {
  const out = new Set<ArrayBuffer>();
  const add = (a?: { buffer: ArrayBufferLike }) => {
    if (a && a.buffer instanceof ArrayBuffer) out.add(a.buffer);
  };
  for (const b of m.bodies) {
    add(b.positions);
    add(b.normals);
    add(b.indices);
    for (const e of b.edges) add(e.points);
  }
  return [...out];
}

function decodeText(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  // Older DXF files are often ANSI (cp1252/cp1258); fall back if UTF-8 looks broken.
  if (utf8.includes('�')) {
    try {
      return new TextDecoder('windows-1252').decode(bytes);
    } catch {
      return utf8;
    }
  }
  return utf8;
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    let model: LoadedModel;
    switch (req.type) {
      case 'sw':
        model = loadSolidWorks(new Uint8Array(req.buffer), req.fileName);
        break;
      case 'dxf':
        model = loadDxf(decodeText(req.buffer), req.fileName, req.buffer.byteLength);
        break;
      case 'occt':
        model = fromOcct(req.result, req.fileName, req.format, req.fileSize);
        break;
      case 'meshes':
        model = fromRawMeshes(req.meshes, req.tree, req.fileName, req.format, req.fileSize);
        break;
    }
    // Buffers may be shared (subarray views); transfer each underlying buffer once.
    (self as unknown as Worker).postMessage({ id: req.id, model } satisfies WorkerResponse, transferables(model));
  } catch (e) {
    (self as unknown as Worker).postMessage({ id: req.id, error: (e as Error).message || String(e) } satisfies WorkerResponse);
  }
};
