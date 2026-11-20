// Admin UI primitives: toasts, dialogs, drawers, confirm, async buttons.
import { h, replace, trustedSvg } from '../shared/dom.js';
import { errorText } from '../shared/status.js';
import { languageButton } from '../shared/i18n.js';

let toastHost;
export function toast(message, tone) {
  toastHost ||= document.body.appendChild(h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }));
  const el = h('div', { class: ['toast', tone] }, message);
  toastHost.append(el);
  setTimeout(() => el.remove(), tone === 'danger' ? 7000 : 3500);
}

export function errorMessage(error) {
  return error?.code ? errorText(error.code) : (error?.message || '操作未完成。');
}

// Runs fn with the button in a busy state; errors become a toast unless handled.
export async function busy(button, fn, { onError } = {}) {
  if (button?.classList.contains('busy')) return;
  button?.classList.add('busy'); if (button) button.disabled = true;
  try { return await fn(); }
  catch (error) { if (onError) onError(error); else toast(errorMessage(error), 'danger'); }
  finally { button?.classList.remove('busy'); if (button) button.disabled = false; }
}

// Busy state for buttons inside the polled content area. `busy()` above marks
// the DOM button, but polling re-renders the page and replaces that button,
// so a slow request looked finished and could be clicked again. Here the
// pending flag lives outside the DOM (keyed, include the deploymentId) and
// every re-render draws the button as busy until the request really settles.
const pendingActions = new Map();
export function isPending(key) { return pendingActions.has(key); }
export function runPending(app, key, fn, { onError } = {}) {
  if (pendingActions.has(key)) return pendingActions.get(key);       // single-flight: no duplicate request
  const task = (async () => {
    try { return await fn(); }
    catch (error) { if (onError) onError(error); else toast(errorMessage(error), 'danger'); }
    finally { pendingActions.delete(key); app.render(); }
  })();
  pendingActions.set(key, task);
  app.render();
  return task;
}
export function actionButton(app, key, { class: cls = 'btn small', disabled, pendingLabel, ...props } = {}, label, fn, opts) {
  const on = pendingActions.has(key);
  return h('button', { ...props, type: 'button', class: [cls, on && !pendingLabel && 'busy'], disabled: disabled || on, 'aria-busy': on ? 'true' : null,
    onclick: () => runPending(app, key, fn, opts) }, on && pendingLabel ? pendingLabel : label);
}

// Dialog: owns its own DOM, never re-rendered by page polling (F1/F8).
// `onClose` is called for every close path (button, Esc, overlay).
export function openDialog({ title, sub, wide, body, foot, onClose, dismissible = true }) {
  const overlay = h('div', { class: 'overlay modal' });
  const bodyEl = h('div', { class: 'dialog-body' });
  const footEl = h('div', { class: 'dialog-foot' });
  const titleEl = h('h2', { id: 'dlg-' + Math.random().toString(36).slice(2) }, title);
  const subEl = h('div', { class: 'sub' }, sub || '');
  const box = h('div', { class: ['dialog', wide && 'wide'], role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleEl.id },
    h('div', { class: 'dialog-head' }, h('div', null, titleEl, subEl),
      h('div', { class: 'row' }, languageButton(), dismissible ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => close() }, '关闭') : null)),
    bodyEl, footEl);
  const onKey = e => { if (e.key === 'Escape' && dismissible) close(); };
  let closed = false;
  function close() {
    if (closed) return; closed = true;
    document.removeEventListener('keydown', onKey); overlay.remove(); box.remove(); onClose?.();
  }
  const api = {
    close, el: box,
    setTitle(t, s) { titleEl.textContent = t; subEl.textContent = s || ''; },
    setBody(...nodes) { replace(bodyEl, ...nodes); },
    setFoot(...nodes) { replace(footEl, ...nodes); footEl.hidden = !nodes.flat().filter(Boolean).length; },
    get closed() { return closed; },
  };
  if (dismissible) overlay.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.append(overlay, box);
  api.setBody(...[].concat(body || []));
  api.setFoot(...[].concat(foot || []));
  setTimeout(() => box.querySelector('input,select,textarea,button.primary')?.focus(), 0);
  return api;
}

export function confirmDialog({ title, body, confirmText = '确认', tone = 'primary', requireCheck }) {
  return new Promise(resolve => {
    let done = false;
    const check = requireCheck ? h('input', { type: 'checkbox' }) : null;
    const ok = h('button', { class: ['btn', tone], type: 'button', disabled: !!requireCheck, onclick: () => { done = true; d.close(); resolve(true); } }, confirmText);
    if (check) check.addEventListener('change', () => { ok.disabled = !check.checked; });
    const d = openDialog({ title, body: [].concat(body, check ? h('label', { class: 'check' }, check, requireCheck) : []),
      foot: [h('button', { class: 'btn', type: 'button', onclick: () => d.close() }, '取消'), ok],
      onClose: () => { if (!done) resolve(false); } });
  });
}

export function drawer({ title, sub, body, foot, onClose }) {
  const overlay = h('div', { class: 'overlay' });
  const head = h('div', { class: 'drawer-head' });
  const bodyEl = h('div', { class: 'drawer-body' });
  const footEl = h('div', { class: 'drawer-foot' });
  const el = h('aside', { class: 'drawer', role: 'dialog', 'aria-modal': 'true' }, head, bodyEl, footEl);
  const onKey = e => { if (e.key === 'Escape') close(); };
  function close() { document.removeEventListener('keydown', onKey); overlay.remove(); el.remove(); onClose?.(); }
  const api = {
    close, el,
    render({ title, sub, body, foot }) {
      // Preserve scroll position and <details> open state across re-renders.
      const scroll = bodyEl.scrollTop;
      const openKeys = new Set([...bodyEl.querySelectorAll('details[data-key]')].filter(d => d.open).map(d => d.dataset.key));
      replace(head, h('div', { class: 'grow' }, h('h2', null, title), sub ? h('div', { class: 'muted small' }, sub) : null),
        h('div', { class: 'row' }, languageButton(), h('button', { class: 'btn ghost small', type: 'button', onclick: close }, '关闭')));
      replace(bodyEl, ...[].concat(body || []));
      bodyEl.querySelectorAll('details[data-key]').forEach(d => { if (openKeys.has(d.dataset.key)) d.open = true; });
      replace(footEl, ...[].concat(foot || [])); footEl.hidden = !footEl.childElementCount;
      bodyEl.scrollTop = scroll;
    },
  };
  overlay.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.append(overlay, el);
  api.render({ title, sub, body, foot });
  return api;
}

// <details> whose open/closed choice survives page re-renders (F1). Default
// state applies only the first time; afterwards the user's choice wins.
const expanded = new Map();
export function persistentDetails(key, { defaultOpen = false, className = 'advanced' } = {}, summary, ...content) {
  const el = h('details', { class: className, dataset: { key }, open: expanded.has(key) ? expanded.get(key) : defaultOpen },
    h('summary', null, summary), h('div', { class: 'inner' }, ...content));
  el.addEventListener('toggle', () => expanded.set(key, el.open));
  return el;
}

export function emptyState(title, text, action) {
  return h('div', { class: 'empty' }, h('h3', null, title), text ? h('p', null, text) : null, action || null);
}

export function errorState(error, retry) {
  return h('div', { class: 'state-error' }, h('h3', null, '数据读取失败'), h('p', { class: 'muted' }, errorMessage(error)),
    retry ? h('button', { class: 'btn small section-gap', type: 'button', onclick: retry }, '重试') : null);
}

export function loadingRows(n = 4) {
  return h('div', { class: 'card-body stack' }, Array.from({ length: n }, () => h('div', { class: 'skeleton' })));
}

// One-screen QR handoff: QR on the left, countdown / steps / link / warning on the right.
export function handoffPanel({ qrSvg, url, countdownEl, steps, warning }) {
  const qr = h('div', { class: 'qr-box' }, trustedSvg(qrSvg));
  const copyBtn = h('button', { class: 'btn small', type: 'button', onclick: async () => {
    try { await navigator.clipboard.writeText(url); copyBtn.textContent = '已复制'; } catch { copyBtn.textContent = '请手动复制'; }
    setTimeout(() => { copyBtn.textContent = '复制链接'; }, 1600);
  } }, '复制链接');
  const panel = h('div', { class: 'handoff' }, qr,
    h('div', { class: 'side' }, countdownEl,
      h('ol', null, steps.map(t => h('li', null, t))),
      h('div', { class: 'link-row' }, h('code', { title: url }, url), copyBtn),
      h('p', { class: 'fine' }, h('strong', null, '只交给本次操作的人。'), warning)));
  return { panel, qr };
}
