/** Tiny DOM helpers. */
type Attrs = Record<string, string | number | boolean | EventListener | undefined | null>;
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function clear(el: Element) {
  while (el.firstChild) el.firstChild.remove();
}

export function toast(message: string, kind: 'info' | 'error' | 'ok' = 'info', ms = 4000) {
  let host = document.querySelector('.toasts');
  if (!host) {
    host = h('div', { class: 'toasts' });
    document.body.append(host);
  }
  const t = h('div', { class: `toast toast-${kind}` }, message);
  host.append(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 300);
  }, ms);
}

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** Labeled number input + range slider kept in sync. */
export function slider(opts: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onInput: (v: number) => void;
  digits?: number;
}) {
  const range = h('input', { type: 'range', min: opts.min, max: opts.max, step: opts.step, value: opts.value }) as HTMLInputElement;
  const num = h('input', { type: 'number', step: opts.step, value: opts.value.toFixed(opts.digits ?? 2), class: 'num' }) as HTMLInputElement;
  range.addEventListener('input', () => {
    num.value = Number(range.value).toFixed(opts.digits ?? 2);
    opts.onInput(Number(range.value));
  });
  num.addEventListener('change', () => {
    const v = Number(num.value);
    if (!Number.isFinite(v)) return;
    range.value = String(v);
    opts.onInput(v);
  });
  const set = (v: number, min?: number, max?: number) => {
    if (min !== undefined) range.min = String(min);
    if (max !== undefined) range.max = String(max);
    range.value = String(v);
    num.value = v.toFixed(opts.digits ?? 2);
  };
  const el = h('div', { class: 'slider-row' }, h('label', {}, opts.label), h('div', { class: 'slider-ctl' }, range, num));
  return { el, set, range, num };
}
