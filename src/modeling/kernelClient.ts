/** Main-thread access to the geometry worker. */
import type { BodyData } from '../core/types';
import type { Feature, FeatureStatus } from './types';

let worker: Worker | null = null;
let seq = 1;
const pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./kernel.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<{ id: number; error?: string }>) => {
      const p = pending.get(ev.data.id);
      if (!p) return;
      pending.delete(ev.data.id);
      if (ev.data.error) p.reject(new Error(ev.data.error));
      else p.resolve(ev.data as never);
    };
  }
  return worker;
}

function call<T>(msg: Record<string, unknown>): Promise<T> {
  const id = seq++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: never) => void, reject });
    getWorker().postMessage({ ...msg, id });
  });
}

export function regenerateRemote(features: Feature[], name: string, upTo?: number) {
  return call<{ body: BodyData | null; status: FeatureStatus[] }>({ type: 'regen', features, name, upTo });
}

export function exportRemote(features: Feature[], format: 'step' | 'stl') {
  return call<{ data: ArrayBuffer }>({ type: 'export', features, format });
}

/** Start loading OpenCascade early (≈23 MB WebAssembly). */
export function warmUpKernel() {
  return call<unknown>({ type: 'regen', features: [], name: '' });
}
