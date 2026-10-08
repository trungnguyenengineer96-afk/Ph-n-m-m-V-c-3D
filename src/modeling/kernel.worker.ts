/// <reference lib="webworker" />
/** Geometry worker: regenerates the feature tree with OpenCascade (replicad). */
import opencascade from 'replicad-opencascadejs';
import wasmUrl from 'replicad-opencascadejs/wasm?url';
import { setOC } from 'replicad';
import { regenerate, shapeToBody } from './kernel';
import type { Feature } from './types';

export type KernelRequest =
  | { id: number; type: 'regen'; features: Feature[]; name: string; upTo?: number }
  | { id: number; type: 'export'; features: Feature[]; format: 'step' | 'stl' };

let ready: Promise<void> | null = null;
function init() {
  if (!ready)
    ready = (opencascade as unknown as (o: { locateFile: () => string }) => Promise<unknown>)({ locateFile: () => wasmUrl }).then((oc) => {
      setOC(oc as never);
    });
  return ready;
}

const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = async (ev: MessageEvent<KernelRequest>) => {
  const req = ev.data;
  try {
    await init();
    const r = regenerate(req.features, req.type === 'regen' ? (req.upTo ?? Infinity) : Infinity);
    if (req.type === 'regen') {
      const body = r.shape ? shapeToBody(r.shape, req.name) : null;
      const transfer: Transferable[] = [];
      if (body) {
        transfer.push(body.positions.buffer as ArrayBuffer, body.indices.buffer as ArrayBuffer);
        if (body.normals) transfer.push(body.normals.buffer as ArrayBuffer);
      }
      post({ id: req.id, body, status: r.status }, transfer);
    } else {
      if (!r.shape) throw new Error('Chưa có khối nào để xuất');
      const blob: Blob = req.format === 'step' ? r.shape.blobSTEP() : (r.shape.blobSTL({ binary: true }) as Blob);
      const buf = await blob.arrayBuffer();
      post({ id: req.id, data: buf }, [buf]);
    }
  } catch (e) {
    post({ id: req.id, error: e instanceof Error ? e.message : String(e) });
  }
};
