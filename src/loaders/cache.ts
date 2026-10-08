/**
 * Converted-model cache in IndexedDB: re-opening the same file (same name,
 * size, modification time and tessellation quality) skips the slow import.
 * Every operation is best effort; failures simply mean a cache miss.
 */
import type { LoadedModel } from '../core/types';

const DB = 'cadviewer-cache';
const STORE = 'models';
const MAX_ENTRIES = 24;
const MAX_BYTES = 600 * 1024 * 1024;

let dbPromise: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  if (!dbPromise)
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  return dbPromise;
}

interface Entry {
  model: LoadedModel;
  t: number;
  bytes: number;
}

export function cacheKey(file: File, variant: string) {
  return `${file.name}|${file.size}|${file.lastModified}|${variant}`;
}

function modelBytes(m: LoadedModel) {
  let n = 0;
  for (const b of m.bodies) {
    n += b.positions.byteLength + b.indices.byteLength + (b.normals?.byteLength ?? 0);
    for (const e of b.edges) n += e.points.byteLength;
  }
  return n;
}

export async function cacheGet(key: string): Promise<LoadedModel | null> {
  const d = await db();
  if (!d) return null;
  return new Promise((resolve) => {
    try {
      const tx = d.transaction(STORE, 'readwrite');
      const st = tx.objectStore(STORE);
      const req = st.get(key);
      req.onsuccess = () => {
        const e = req.result as Entry | undefined;
        if (!e) return resolve(null);
        e.t = Date.now();
        st.put(e, key);
        resolve(e.model);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function cachePut(key: string, model: LoadedModel): Promise<void> {
  const bytes = modelBytes(model);
  if (bytes > MAX_BYTES / 3) return;
  const d = await db();
  if (!d) return;
  try {
    const tx = d.transaction(STORE, 'readwrite');
    const st = tx.objectStore(STORE);
    st.put({ model, t: Date.now(), bytes } satisfies Entry, key);
    // Evict least recently used entries beyond the limits.
    const all: { key: IDBValidKey; t: number; bytes: number }[] = [];
    const cur = st.openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) {
        const v = c.value as Entry;
        all.push({ key: c.key, t: v.t, bytes: v.bytes });
        c.continue();
        return;
      }
      all.sort((a, b) => b.t - a.t);
      let total = 0;
      all.forEach((e, i) => {
        total += e.bytes;
        if (i >= MAX_ENTRIES || total > MAX_BYTES) st.delete(e.key);
      });
    };
  } catch {
    /* quota or private mode */
  }
}

export async function cacheClear(): Promise<void> {
  const d = await db();
  if (!d) return;
  try {
    d.transaction(STORE, 'readwrite').objectStore(STORE).clear();
  } catch {
    /* ignore */
  }
}
