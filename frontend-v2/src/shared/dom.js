// Minimal DOM builder. All text goes through textContent / text nodes, never
// innerHTML, so order fields, token symbols and chain metadata cannot inject
// markup. The only exception is `trustedSvg`, used for server-generated QR SVG
// after it has been parsed and stripped of scripts and event handlers.

export { literalText as literal } from './i18n.js';

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (['value', 'checked', 'disabled', 'hidden', 'selected', 'open', 'readOnly', 'required', 'multiple'].includes(key)) el[key] = value;
    else if (key === 'text') el.textContent = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function replace(el, ...children) { el.replaceChildren(); append(el, children); return el; }

export function badge(text, tone = 'neutral', plain = false) {
  return h('span', { class: ['badge', tone, plain && 'plain'] }, text);
}

export function copyable(value, { full = false, label = '复制', title } = {}) {
  if (!value) return h('span', { class: 'subtle' }, '—');
  const button = h('button', { type: 'button', 'aria-label': `${label} ${title || ''}`.trim(), onclick: async e => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(value); button.textContent = '已复制'; }
    catch { button.textContent = '请手动复制'; }
    setTimeout(() => { button.textContent = label; }, 1600);
  } }, label);
  return h('span', { class: 'copy' }, h('span', { class: ['value', full && 'full'], title: value }, value), button);
}

export function notice(tone, title, ...body) {
  return h('div', { class: ['notice', tone], role: tone === 'danger' ? 'alert' : 'status' },
    h('div', { class: 'notice-body' }, title ? h('strong', null, title) : null, ...body));
}

export function field(label, control, { hint, error, id } = {}) {
  const fid = id || control.id || 'f-' + Math.random().toString(36).slice(2, 9);
  control.id = fid;
  return h('div', { class: ['field', error && 'invalid'] }, h('label', { for: fid }, label), control,
    hint ? h('div', { class: 'hint' }, hint) : null, error ? h('div', { class: 'error-text' }, error) : null);
}

export function kv(pairs) {
  return h('dl', { class: 'kv' }, pairs.filter(Boolean).flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v ?? '—')]));
}

// Server-generated QR SVG (from the `qrcode` package). Parse it as SVG, keep
// only geometry, and drop scripts, foreignObject and on* attributes.
export function trustedSvg(svgText) {
  const doc = new DOMParser().parseFromString(String(svgText || ''), 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'svg') return h('span', { class: 'subtle' }, '二维码不可用');
  root.querySelectorAll('script,foreignObject,a,image,use').forEach(n => n.remove());
  for (const node of [root, ...root.querySelectorAll('*')]) {
    for (const attr of [...node.attributes]) if (/^on/i.test(attr.name) || /href/i.test(attr.name)) node.removeAttribute(attr.name);
  }
  if (!root.getAttribute('viewBox') && root.getAttribute('width') && root.getAttribute('height'))
    root.setAttribute('viewBox', `0 0 ${parseFloat(root.getAttribute('width'))} ${parseFloat(root.getAttribute('height'))}`);
  root.removeAttribute('width'); root.removeAttribute('height');   // size is controlled by CSS
  return document.importNode(root, true);
}
