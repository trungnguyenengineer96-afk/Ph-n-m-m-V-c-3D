import { defineConfig } from 'vitest/config';
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// OpenCascade (occt-import-js) is an Emscripten build loaded by a classic worker,
// so its .js/.wasm files are served as static assets from public/occt.
function copyOcct() {
  const src = resolve(__dirname, 'node_modules/occt-import-js/dist');
  const dst = resolve(__dirname, 'public/occt');
  if (!existsSync(dst)) mkdirSync(dst, { recursive: true });
  for (const f of ['occt-import-js.js', 'occt-import-js.wasm']) {
    copyFileSync(resolve(src, f), resolve(dst, f));
  }
}

export default defineConfig(() => {
  copyOcct();
  return {
    base: './',
    worker: { format: 'es' as const },
    // Worker-only CommonJS deps: pre-bundle at startup so the first file load does not trigger a reload.
    optimizeDeps: { include: ['pako', 'cfb', 'dxf-parser'], exclude: ['replicad-opencascadejs', '@salusoft89/planegcs'] },
    build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
    test: { environment: 'node' as const },
  };
});
