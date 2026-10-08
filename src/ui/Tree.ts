/** FeatureManager-style model tree. */
import type { LoadedModel, ModelNode } from '../core/types';
import { clear, h } from './dom';
import { icon } from './icons';

export interface TreeCallbacks {
  onSelect(node: ModelNode | null, additive: boolean): void;
  onToggleVisible(node: ModelNode, visible: boolean): void;
  onZoom(node: ModelNode): void;
  onContext(node: ModelNode, x: number, y: number): void;
}

export class ModelTree {
  private rows = new Map<ModelNode, HTMLElement>();
  private hidden = new Set<ModelNode>();
  private selected = new Set<ModelNode>();

  constructor(private host: HTMLElement, private cb: TreeCallbacks) {}

  render(model: LoadedModel | null) {
    clear(this.host);
    this.rows.clear();
    this.hidden.clear();
    this.selected.clear();
    if (!model) {
      this.host.append(h('div', { class: 'empty-note' }, 'Chưa mở tài liệu nào.'));
      return;
    }
    const list = h('ul', { class: 'tree', role: 'tree' });
    list.append(this.row(model.root, model, 0, true));
    this.host.append(list);
  }

  private row(node: ModelNode, model: LoadedModel, depth: number, isRoot = false): HTMLElement {
    const hasChildren = node.children.length > 0 || node.bodies.length > 1;
    const kind = isRoot
      ? model.kind === 'assembly'
        ? 'assembly'
        : model.kind === 'drawing'
          ? 'drawing'
          : 'part'
      : node.missing
        ? 'missing'
        : node.children.length
          ? 'assembly'
          : node.bodies.length
            ? 'part'
            : 'body';
    const caret = h('button', { class: 'caret' + (hasChildren ? '' : ' invisible'), title: 'Mở/thu gọn', 'aria-label': 'Mở/thu gọn' }, icon('caret'));
    const eye = h('button', { class: 'eye', title: 'Ẩn/Hiện (H)', 'aria-label': 'Ẩn/Hiện' }, icon('eye'));
    const label = h(
      'div',
      { class: 'tree-row' + (node.missing ? ' missing' : ''), style: `padding-left:${depth * 14 + 4}px`, role: 'treeitem', title: node.note ?? node.name },
      caret,
      icon(kind),
      h('span', { class: 'tree-name' }, node.name),
      node.missing ? null : eye,
    );
    const li = h('li', {}, label);
    const kids = h('ul', { class: 'tree-children' });
    for (const c of node.children) kids.append(this.row(c, model, depth + 1));
    // Multi-body nodes list their bodies.
    if (node.bodies.length > 1)
      for (const bi of node.bodies) {
        const b = model.bodies[bi];
        kids.append(
          h('li', {}, h('div', { class: 'tree-row body-row', style: `padding-left:${(depth + 1) * 14 + 22}px` }, icon('body'), h('span', { class: 'tree-name' }, b?.name ?? `Thân ${bi + 1}`))),
        );
      }
    if (kids.childElementCount) li.append(kids);
    if (depth >= 2 && node.children.length) li.classList.add('collapsed');
    caret.addEventListener('click', (e) => {
      e.stopPropagation();
      li.classList.toggle('collapsed');
    });
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      const vis = this.hidden.has(node);
      this.setVisible(node, vis);
      this.cb.onToggleVisible(node, vis);
    });
    label.addEventListener('click', (e) => {
      if (node.missing) return;
      this.cb.onSelect(node, e.ctrlKey || e.metaKey || e.shiftKey);
    });
    label.addEventListener('dblclick', () => !node.missing && this.cb.onZoom(node));
    label.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!node.missing) this.cb.onContext(node, e.clientX, e.clientY);
    });
    this.rows.set(node, label);
    return li;
  }

  setVisible(node: ModelNode, visible: boolean) {
    const row = this.rows.get(node);
    if (visible) this.hidden.delete(node);
    else this.hidden.add(node);
    if (row) {
      row.classList.toggle('is-hidden', !visible);
      const eye = row.querySelector('.eye');
      if (eye) eye.replaceChildren(icon(visible ? 'eye' : 'eyeOff'));
    }
  }

  isHidden(node: ModelNode) {
    return this.hidden.has(node);
  }

  setSelection(nodes: ModelNode[]) {
    for (const n of this.selected) this.rows.get(n)?.classList.remove('selected');
    this.selected = new Set(nodes);
    for (const n of nodes) {
      const r = this.rows.get(n);
      if (!r) continue;
      r.classList.add('selected');
      // Expand ancestors and scroll into view.
      let li = r.parentElement?.parentElement?.closest('li');
      while (li) {
        li.classList.remove('collapsed');
        li = li.parentElement?.closest('li') ?? null;
      }
      r.scrollIntoView({ block: 'nearest' });
    }
  }
}
