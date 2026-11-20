// Focused offline auth UI execution. No server, port, real key or merchant data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { build } from 'esbuild';
const base = new URL('./', import.meta.url);
const src = file => fs.readFileSync(new URL('src/' + file, base), 'utf8');
const strip = text => text.replace(/^import .*;\n/gm, '').replaceAll('export ', '');
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.handlers = {}; this.value = ''; this.disabled = false; this.checked = false; this.className = ''; this._text = ''; this.classList = { contains: c => this.className.split(' ').includes(c), add: c => { this.className += ' ' + c; }, remove: c => { this.className = this.className.split(' ').filter(x => x !== c).join(' '); }, toggle() {} }; }
  append(...nodes) { for (const n of nodes) { if (n.parentElement) n.remove(); n.parentElement = this; this.children.push(n); } }
  appendChild(n) { this.append(n); return n; }
  replaceChildren(...nodes) { this.children.forEach(n => { n.parentElement = null; }); this.children = []; this._text = ''; this.append(...nodes); }
  remove() { if (this.parentElement) { this.parentElement.children = this.parentElement.children.filter(x => x !== this); this.parentElement = null; } }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(k, fn) { (this.handlers[k] ||= []).push(fn); }
  dispatch(k) { for (const fn of this.handlers[k] || []) fn({ preventDefault() {}, currentTarget: this, target: this }); }
  focus() {}
  click() { if (!this.disabled) this.dispatch('click'); }
  get textContent() { return this._text + this.children.map(x => x.textContent).join(''); }
  set textContent(v) { this.replaceChildren(); this._text = String(v); }
  querySelectorAll(selector) { const tags = selector.split(','); return this.children.flatMap(n => [...(tags.includes(n.tagName) ? [n] : []), ...n.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
const tick = () => new Promise(setImmediate);
function fixture(passwordSet = true) {
  const body = new Element('body'), calls = [], copies = [], storageWrites = [], kept = new Map();
  const context = vm.createContext({ Node: Element, document: { body, createElement: tag => new Element(tag), createTextNode: text => { const el = new Element('#text'); el.textContent = text; return el; }, addEventListener() {}, removeEventListener() {} },
    location: { hash: '#/login' }, navigator: { clipboard: { async writeText(v) { copies.push(v); } } }, URL, Blob, setTimeout: () => 0, clearTimeout() {},
    localStorage: { setItem() { storageWrites.push('local'); } }, sessionStorage: { setItem() { storageWrites.push('session'); } },
    languageButton: () => new Element('button'), trustedSvg: () => new Element('svg'), brandLogo: '',
  });
  // Execute real DOM, error vocabulary, busy/dialog primitives and auth code.
  const dom = strip(src('shared/dom.js')).replace(/^\{ literalText as literal \}.*$/m, '');
  vm.runInContext(dom + '\ntrustedSvg = () => document.createElement("svg");\n' + strip(src('shared/status.js')) + '\n' + strip(src('admin/ui.js')) + '\n' + strip(src('admin/auth.js')) + '\n' + strip(src('admin/pages/entry.js')) + '\nglobalThis.api = {loginPage, openAuthDialog, passwordError, clearAuthUI, secretPanel};', context);
  const app = { authEpoch: 0, state: { auth: 'out' }, keep(k, fn) { if (!kept.has(k)) kept.set(k, fn()); return kept.get(k); }, setAuth(v) { this.authEpoch++; context.api.clearAuthUI(); kept.clear(); this.state.auth = v; }, client: {
    async get(route) { calls.push({ route }); return { passwordSet, passwordMinLength: 12 }; },
    async post(route, payload) { calls.push({ route, payload: { ...payload } }); return route === 'auth/reset' || route === 'auth/recovery-key' ? { ok: true, recoveryKey: 'fixture-new-recovery' } : { ok: true, apiKey: 'fixture-api' }; },
  } };
  return { ...context.api, app, body, calls, copies, storageWrites };
}
const findButton = (root, text) => root.querySelectorAll('button').find(n => n.textContent === text);

test('password validation preserves spaces; bounds, whitespace and mismatch are rejected', () => {
  const f = fixture();
  for (const v of ['short', ' '.repeat(12), 'x'.repeat(129)]) assert(f.passwordError(v));
  assert.equal(f.passwordError(' ' + 'x'.repeat(10) + ' '), '');
  assert.equal(f.passwordError('x'.repeat(128)), '');
  assert(f.passwordError('x'.repeat(12), 'y'.repeat(12)));
});

test('password login uses only password, survives render, blocks duplicate submit and clears on auth change', async () => {
  const f = fixture(); const page = f.loginPage(f.app); await tick();
  const form = page.querySelector('form'), input = page.querySelector('input'); input.value = '  exact-pass  ';
  assert.equal(f.loginPage(f.app), page); assert.equal(input.value, '  exact-pass  ');
  form.dispatch('submit'); form.dispatch('submit'); await tick();
  assert.equal(f.calls.filter(x => x.route === 'login').length, 1);
  assert.deepEqual(f.calls.at(-1).payload, { password: '  exact-pass  ' });
  assert.equal(input.value, ''); assert.equal(f.app.state.auth, 'in'); assert.deepEqual(f.storageWrites, []);
});

test('first setup requires recovery proof and confirmation; rotates key without login, requires saved acknowledgement', async () => {
  const f = fixture(false); const page = f.loginPage(f.app); await tick();
  assert.match(page.textContent, /首次设置/);
  const [key, pass, confirm] = page.querySelectorAll('input'), form = page.querySelector('form');
  key.value = 'fixture-old-key'; pass.value = 'new-password-123'; confirm.value = 'mismatch'; form.dispatch('submit'); await tick();
  assert.equal(f.calls.length, 1); assert.match(page.textContent, /不一致/);
  confirm.value = pass.value; form.dispatch('submit'); form.dispatch('submit'); await tick();
  assert.deepEqual(f.calls.at(-1).payload, { recoveryKey: 'fixture-old-key', newPassword: 'new-password-123' });
  assert.equal(f.app.state.auth, 'out'); for (const el of [key, pass, confirm]) assert.equal(el.value, '');
  const out = page.querySelector('textarea'); assert.equal(out.value, 'fixture-new-recovery'); assert.deepEqual(f.copies, []);
  findButton(page, '复制').click(); await tick(); assert.deepEqual(f.copies, ['fixture-new-recovery']);
  const done = findButton(page, '已保存，返回密码登录'); assert.equal(done.disabled, true);
  const ack = page.querySelector('input'); ack.checked = true; ack.dispatch('change'); done.click();
  assert.equal(out.value, ''); assert.equal(page.querySelector('input').getAttribute('autocomplete'), 'current-password'); assert.deepEqual(f.storageWrites, []);
});

test('forgot password changes only the form; stale login/status cannot restore auth after logout', async () => {
  const f = fixture(); const page = f.loginPage(f.app); await tick();
  findButton(page, '忘记密码').click(); assert.match(page.textContent, /重置登录密码/);
  findButton(page, '返回密码登录').click();
  let resolve; f.app.client.post = () => new Promise(r => { resolve = r; });
  page.querySelector('input').value = 'valid-password'; page.querySelector('form').dispatch('submit');
  f.app.setAuth('out'); resolve({ ok: true }); await tick(); assert.equal(f.app.state.auth, 'out'); assert.equal(page.querySelectorAll('input').length, 0);
  const g = fixture(); let ready; g.app.client.get = () => new Promise(r => { ready = r; }); const pending = g.loginPage(g.app); g.app.setAuth('out'); ready({ passwordSet: true }); await tick(); assert.equal(pending.querySelectorAll('input').length, 0);
});

test('credential dialogs demand current password, reveal only after verification, clear on close and ignore late responses', async () => {
  for (const kind of ['api-key', 'recovery-key']) {
    const f = fixture(); f.app.state.auth = 'in'; f.openAuthDialog(f.app, kind);
    let dialog = f.body.children.find(n => n.attrs.role === 'dialog');
    assert.equal(dialog.querySelector('textarea'), null); dialog.querySelector('form').dispatch('submit'); assert.equal(f.calls.length, 0);
    const password = dialog.querySelector('input'); password.value = 'current-pass-123'; dialog.querySelector('form').dispatch('submit'); await tick();
    assert.equal(f.calls.at(-1).route, 'auth/' + kind); assert.deepEqual(f.calls.at(-1).payload, { password: 'current-pass-123' });
    assert.equal(password.value, ''); const out = dialog.querySelector('textarea'); assert(out.value); assert.deepEqual(f.copies, []);
    findButton(dialog, '关闭').click(); assert.equal(out.value, ''); assert.equal(dialog.parentElement, null);
    let resolve; f.app.client.post = () => new Promise(r => { resolve = r; }); f.openAuthDialog(f.app, kind); dialog = f.body.children.find(n => n.attrs.role === 'dialog');
    dialog.querySelector('input').value = 'current-pass-123'; dialog.querySelector('form').dispatch('submit'); f.app.setAuth('out'); resolve({ apiKey: 'late', recoveryKey: 'late' }); await tick();
    assert.equal(dialog.querySelector('textarea'), null); assert.equal(dialog.parentElement, null); assert.deepEqual(f.storageWrites, []);
  }
});

test('password change validates confirmation and logs out on success', async () => {
  const f = fixture(); f.app.state.auth = 'in'; f.openAuthDialog(f.app, 'password'); const dialog = f.body.children.find(n => n.attrs.role === 'dialog');
  const [current, pass, confirm] = dialog.querySelectorAll('input'); current.value = 'current-password'; pass.value = 'new-password-123'; confirm.value = 'bad';
  dialog.querySelector('form').dispatch('submit'); assert.equal(f.calls.length, 0);
  confirm.value = pass.value; dialog.querySelector('form').dispatch('submit'); await tick();
  assert.deepEqual(f.calls.at(-1).payload, { currentPassword: 'current-password', newPassword: 'new-password-123' }); assert.equal(f.app.state.auth, 'out');
  for (const input of [current, pass, confirm]) assert.equal(input.value, '');
});

test('every auth route is global and keeps same-origin cookie/security fetch options', async () => {
  const requests = [], context = vm.createContext({ AbortController, setTimeout, clearTimeout, fetch: async (url, options) => { requests.push({ url, ...options }); return { ok: true, async json() { return { ok: true }; } }; } });
  vm.runInContext(strip(src('shared/api.js')) + '\nglobalThis.client = liveClient();', context);
  await context.client.get('auth/status');
  for (const route of ['auth/reset', 'auth/password', 'auth/api-key', 'auth/recovery-key']) await context.client.post(route, {}, { deploymentId: 'must-not-leak' });
  for (const r of requests) { assert.equal(r.headers['X-Upay-Deployment'], undefined); assert.equal(r.credentials, 'same-origin'); assert.equal(r.redirect, 'error'); assert.equal(r.cache, 'no-store'); }
});

test('session teardown invalidates in-flight deployment success/errors and gates login until logout settles', async () => {
  const names = ['overviewPage', 'ordersPage', 'collectPage', 'chainsPage', 'notificationsPage', 'integrationPage', 'settingsPage'];
  let cleanups = 0;
  const context = vm.createContext({ navigator: { onLine: true }, document: { getElementById: () => new Element('div') },
    installLanguageSupport() {}, clearAuthUI() { cleanups++; }, needsRecovery: () => false,
    ...Object.fromEntries(names.map(n => [n, () => null])),
  });
  vm.runInContext(strip(src('shared/api.js')) + '\n' + strip(src('admin/main.js')).replace(/\nboot\(\);\s*$/, '') + '\nrender = () => {}; bootData = async () => {}; globalThis.subject = { app, state, loadDeployments, load, logout };', context);
  const { app, state, loadDeployments, load, logout } = context.subject;
  app.setAuth('in'); let resolve;
  state.client = { get: () => new Promise(r => { resolve = r; }) };
  const waiting = loadDeployments(); app.setAuth('out'); resolve({ deployments: [{ id: 'late' }] }); await waiting;
  assert.equal(state.auth, 'out'); assert.equal(state.deployments.length, 0);
  app.setAuth('in'); let reject;
  const failed = load('old-request', () => new Promise((_, r) => { reject = r; })); app.setAuth('out'); app.setAuth('in');
  reject(Object.assign(new Error('old 401'), { status: 401 })); await failed; assert.equal(state.auth, 'in');
  state.client = { post: () => new Promise(r => { resolve = r; }) }; const ending = logout(); assert.equal(state.auth, 'unknown');
  resolve({ ok: true }); await ending; assert.equal(state.auth, 'out'); assert(cleanups >= 5);
});

test('all authentication UI literals have English translations', () => {
  const catalogs = Object.assign({}, ...['admin-pages', 'admin-shared'].map(n => JSON.parse(fs.readFileSync(new URL(`src/shared/locales/${n}.en.json`, base), 'utf8'))));
  for (const file of ['admin/auth.js', 'admin/pages/entry.js']) {
    const source = file.endsWith('entry.js') ? src(file).split('export function onboardingPage')[0] : src(file);
    for (const match of source.matchAll(/'([^'\n]*[\u4e00-\u9fff][^'\n]*)'/g)) assert(catalogs[match[1]], `missing translation: ${match[1]}`);
  }
});

test('admin bundle compiles in memory without writing dist or starting a service', async () => {
  const result = await build({ entryPoints: [new URL('src/admin/main.js', base).pathname], bundle: true, write: false, loader: { '.svg': 'text' }, format: 'iife', target: 'es2020', logLevel: 'silent' });
  assert(result.outputFiles[0].text.length > 1000);
});
