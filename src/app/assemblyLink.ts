/**
 * SolidWorks assemblies only reference their parts. When the user opens an
 * assembly together with the referenced part files (or STEP exports with the
 * same base name), the parts are inserted into the assembly tree.
 * Component placement (mates/transforms) is not decoded, so inserted parts
 * keep their own coordinate system.
 */
import type { LoadedModel, ModelNode } from '../core/types';

const base = (name: string) => name.replace(/\.[^.]+$/, '').trim().toLowerCase();

export function mergeAssemblyReferences(models: LoadedModel[]): Set<LoadedModel> {
  const consumed = new Set<LoadedModel>();
  const byName = new Map<string, LoadedModel>();
  for (const m of models) byName.set(base(m.info.fileName), m);

  let changed = true;
  for (let guard = 0; changed && guard < 10; guard++) {
    changed = false;
    for (const asm of models) {
      if (consumed.has(asm)) continue;
      const visit = (node: ModelNode) => {
        for (let i = 0; i < node.children.length; i++) {
          const c = node.children[i];
          if (c.missing) {
            const part = byName.get(base(c.name));
            if (part && part !== asm && part.bodies.length && !hasMissing(part.root)) {
              node.children[i] = graft(asm, part, c.name);
              consumed.add(part);
              changed = true;
            }
          } else visit(c);
        }
      };
      visit(asm.root);
    }
  }
  for (const asm of models) {
    if (consumed.has(asm)) continue;
    const linked = countLinked(asm.root);
    if (linked) {
      asm.sheets = undefined;
      const missing = countMissing(asm.root);
      asm.info.warnings = asm.info.warnings.filter((w) => !w.startsWith('Tệp lắp ráp SolidWorks chỉ lưu'));
      asm.info.warnings.push(
        `Đã nạp ${linked} thành phần từ các tệp mở kèm${missing ? `, còn thiếu ${missing}` : ''}. ` +
          'Vị trí lắp (mates) chưa giải mã được nên các chi tiết giữ hệ toạ độ riêng — dùng Tách rời để xem từng chi tiết, hoặc xuất STEP lắp ráp từ SolidWorks để có vị trí chính xác.',
      );
    }
  }
  return consumed;
}

function graft(asm: LoadedModel, part: LoadedModel, name: string): ModelNode {
  const offset = asm.bodies.length;
  asm.bodies.push(...part.bodies);
  const remap = (n: ModelNode): ModelNode => ({
    ...n,
    bodies: n.bodies.map((b) => b + offset),
    children: n.children.map(remap),
  });
  const root = remap(part.root);
  root.name = name;
  root.note = 'Nạp từ ' + part.info.fileName;
  root.linked = true;
  return root;
}

function hasMissing(n: ModelNode): boolean {
  return !!n.missing || n.children.some(hasMissing);
}
function countMissing(n: ModelNode): number {
  return (n.missing ? 1 : 0) + n.children.reduce((s, c) => s + countMissing(c), 0);
}
function countLinked(n: ModelNode): number {
  return (n.linked ? 1 : 0) + n.children.reduce((s, c) => s + countLinked(c), 0);
}
