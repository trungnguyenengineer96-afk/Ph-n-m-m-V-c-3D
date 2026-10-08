/**
 * Fill SolidWorks assembly components that have no cached geometry with part
 * files (or STEP exports with the same base name) opened at the same time.
 * Components keep the placement read from the assembly (node.matrix).
 */
import type { LoadedModel, ModelNode } from '../core/types';

const base = (name: string) => name.replace(/\.[^.]+$/, '').trim().toLowerCase();

export function mergeAssemblyReferences(models: LoadedModel[]): Set<LoadedModel> {
  const consumed = new Set<LoadedModel>();
  const byName = new Map<string, LoadedModel>();
  for (const m of models) byName.set(base(m.info.fileName), m);

  for (const asm of models) {
    if (asm.kind !== 'assembly' || consumed.has(asm)) continue;
    // Bodies of a part are appended once and shared by all its instances.
    const offsets = new Map<LoadedModel, number>();
    let linked = 0;
    const visit = (node: ModelNode) => {
      for (let i = 0; i < node.children.length; i++) {
        const c = node.children[i];
        if (!c.missing) {
          visit(c);
          continue;
        }
        const part = byName.get(base(c.refFile ?? c.name));
        if (!part || part === asm || !part.bodies.length || hasMissing(part.root)) continue;
        let offset = offsets.get(part);
        if (offset === undefined) {
          offset = asm.bodies.length;
          asm.bodies.push(...part.bodies);
          offsets.set(part, offset);
        }
        const remap = (n: ModelNode): ModelNode => ({ ...n, bodies: n.bodies.map((b) => b + offset!), children: n.children.map(remap) });
        const grafted = remap(part.root);
        node.children[i] = { ...grafted, name: c.name, matrix: c.matrix ?? grafted.matrix, refFile: c.refFile, missing: undefined, linked: true, note: 'Nạp từ ' + part.info.fileName };
        consumed.add(part);
        linked++;
      }
    };
    visit(asm.root);
    if (linked) {
      asm.sheets = undefined;
      const missing = countMissing(asm.root);
      asm.info.warnings = asm.info.warnings.filter((w) => !/không có lưới lưu sẵn|chỉ lưu tham chiếu|không có cây thành phần/.test(w));
      asm.info.warnings.push(`Đã nạp ${linked} thành phần từ các tệp mở kèm${missing ? `, còn thiếu ${missing}` : ''}.`);
    }
  }
  return consumed;
}

function hasMissing(n: ModelNode): boolean {
  return !!n.missing || n.children.some(hasMissing);
}
function countMissing(n: ModelNode): number {
  return (n.missing ? 1 : 0) + n.children.reduce((s, c) => s + countMissing(c), 0);
}
