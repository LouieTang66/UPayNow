// UPayNow merchant console (frontend-v2). Independent of backend/public/app.js.
import { h, replace, trustedSvg, literal } from '../shared/dom.js';
import brandLogo from '../../brand/upaynow-b-coin.svg';
import { installLanguageSupport, languageButton } from '../shared/i18n.js';
installLanguageSupport();
import { liveClient, sequencer } from '../shared/api.js';
import { chainName, shortAddr, relative } from '../shared/format.js';
import { needsRecovery } from '../shared/status.js';
import { clearAuthUI } from './auth.js';
import { toast, errorMessage } from './ui.js';
import { overviewPage } from './pages/overview.js';
import { ordersPage, openOrderDrawer } from './pages/orders.js';
import { collectPage } from './pages/collect.js';
import { chainsPage } from './pages/chains.js';
import { notificationsPage } from './pages/notifications.js';
import { integrationPage } from './pages/integration.js';
import { settingsPage } from './pages/settings.js';
import { loginPage, onboardingPage } from './pages/entry.js';

const NAV = [
  { group: '日常' },
  { id: 'overview', label: '总览' },
  { id: 'orders', label: '订单' },
  { id: 'collect', label: '归集', count: s => s.jobs.filter(needsRecovery).length, countTone: 'unknown' },
  { id: 'notifications', label: '付款通知', count: s => s.notifications.filter(n => n.state === 'FAILED').length },
  { group: '配置' },
  { id: 'chains', label: '链与合约' },
  { id: 'integration', label: '商城接入' },
  { id: 'settings', label: '设置' },
];
const PAGES = { overview: overviewPage, orders: ordersPage, collect: collectPage, chains: chainsPage,
  notifications: notificationsPage, integration: integrationPage, settings: settingsPage };
const POLL_MS = 8000;

const state = {
  client: null, seq: sequencer(),
  auth: 'unknown', online: navigator.onLine,
  deployments: [], selectedId: null, status: null,
  orders: [], jobs: [], notifications: [], handoffConfig: null, deploymentJobs: [],
  loaded: {}, errors: {}, lastRefresh: 0,
  ui: { orderFilter: { q: '', status: 'all', token: 'all' }, selected: new Set(), navOpen: false, collectTab: 'ready', chainsTab: 'list' },
};
const root = document.getElementById('app');
const keptNodes = new Map();
let shellEls = null;
let authEpoch = 0;
let deploymentSelection = 0;

// ---------- data ----------
const scoped = () => ({ deploymentId: state.selectedId });
export const app = {
  state,
  get client() { return state.client; },
  route: () => parseRoute(),
  go(path) { location.hash = '#/' + path; },
  render: () => render(),
  refresh: () => refreshAll(),
  refreshDeployments: () => loadDeployments(),
  selected: () => state.deployments.find(d => d.id === state.selectedId) || null,
  scoped,
  selectDeployment,
  logout,
  listeners: new Set(),   // overlays (drawer) subscribe to refreshed data without being re-created
  // Unsubmitted forms that live inside the polled content area are kept as the
  // same DOM node across re-renders, so typed values, selections and focus
  // survive polling. Scoped to the selected deployment: switching deployments,
  // logging out or forget() drops them, so a draft can never follow another chain.
  keep(key, build) {
    const k = state.selectedId + '|' + key;
    if (!keptNodes.has(k)) { const node = build(); if (!node) return null; keptNodes.set(k, node); }
    return keptNodes.get(k);
  },
  forget(key) { keptNodes.delete(state.selectedId + '|' + key); },
  get authEpoch() { return authEpoch; },
  setAuth(value) {
    authEpoch++; state.seq.reset(); clearAuthUI(); keptNodes.clear(); shellEls = null;
    state.auth = value;
    if (value !== 'in') Object.assign(state, { deployments: [], selectedId: null, status: null, orders: [], jobs: [], notifications: [], handoffConfig: null, walletConfig: null, deploymentJobs: [], loaded: {}, errors: {} });
    render(); if (value === 'in') bootData();
  },
};

async function load(key, task) {
  try {
    const r = await state.seq.run(key, task);
    if (r.stale) return false;               // an older response must not overwrite newer data
    state.errors[key] = null; state.loaded[key] = true;
    return r.value;
  } catch (error) {
    if (error.status === 401) { app.setAuth('out'); return false; }
    state.errors[key] = error; state.loaded[key] = true;
    return false;
  }
}

async function loadDeployments() {
  const epoch = authEpoch;
  const result = await load('deployments', () => state.client.get('deployments'));
  if (!result || epoch !== authEpoch) return;
  state.auth = 'in';
  state.deployments = result.deployments || [];
  const stored = sessionStorage.getItem('v2.deployment');
  if (!state.deployments.some(d => d.id === state.selectedId)) {
    const preferred = state.deployments.find(d => d.id === stored && d.factory) || state.deployments.find(d => d.factory) || state.deployments[0];
    state.selectedId = preferred?.id || null;
  }
}

async function refreshAll() {
  if (state.auth !== 'in') return;
  const epoch = authEpoch;
  const id = state.selectedId;
  const scoped = () => ({ deploymentId: id }); // captured once, including delayed continuations
  const tasks = [
    load('deploymentJobs', () => state.client.get('deployment-jobs')).then(v => { if (v) state.deploymentJobs = v; }),
  ];
  if (id) tasks.push(
    load('status', () => state.client.get('status', scoped())).then(v => { if (v && id === state.selectedId) state.status = v; }),
    load('orders', () => state.client.get('orders', scoped())).then(v => { if (v && id === state.selectedId) state.orders = v; }),
    load('jobs', () => state.client.get('jobs', scoped())).then(v => { if (v && id === state.selectedId) state.jobs = v; }),
    load('notifications', () => state.client.get('notifications', scoped())).then(v => { if (v && id === state.selectedId) state.notifications = v; }),
    load('handoffConfig', () => state.client.get('handoffs/config', scoped())).then(v => { if (v && id === state.selectedId) state.handoffConfig = v; }),
    load('walletConfig', () => state.client.get('wallet/config', scoped())).then(v => { if (v && id === state.selectedId) state.walletConfig = v; }),
  );
  await Promise.all(tasks);
  if (epoch !== authEpoch || state.auth !== 'in') return;
  state.lastRefresh = Date.now();
  render();
  for (const fn of app.listeners) try { fn(); } catch {}
}

async function selectDeployment(id) {
  const selection = ++deploymentSelection, epoch = authEpoch;
  if (!id || id === state.selectedId) return;
  // A completed phone deployment can precede the cached registry. Never select
  // an absent option: browsers would display the first chain while requests use another.
  if (!state.deployments.some(d => d.id === id)) {
    await loadDeployments();
    if (selection !== deploymentSelection || epoch !== authEpoch) return;
    if (!state.deployments.some(d => d.id === id)) {
      toast(errorMessage(state.errors.deployments || { code: 'DEPLOYMENT_NOT_FOUND' }), 'danger');
      return;
    }
  }
  keptNodes.clear();                         // drafts belong to the previous deployment
  state.selectedId = id;
  sessionStorage.setItem('v2.deployment', id);
  state.seq.reset();                         // drop every in-flight response of the previous deployment
  Object.assign(state, { status: null, orders: [], jobs: [], notifications: [], handoffConfig: null, walletConfig: null });
  state.loaded = { deployments: true, deploymentJobs: state.loaded.deploymentJobs };
  state.ui.selected = new Set();
  render();
  await refreshAll();
}

async function bootData() {
  await loadDeployments();
  if (state.auth !== 'in') return render();
  render();
  await refreshAll();
}

// ---------- routing ----------
function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { page: parts[0] || 'overview', arg: parts[1] || null, rest: parts.slice(1) };
}

// ---------- rendering ----------
function sidebar(route) {
  return h('nav', { class: 'sidebar', 'aria-label': '主导航' },
    h('div', { class: 'brand' }, h('div', { class: 'brand-mark brand-logo', role: 'img', 'aria-label': 'UPayNow Logo' }, trustedSvg(brandLogo)),
      h('div', null, h('div', { class: 'brand-name' }, 'UPayNow'), h('div', { class: 'brand-sub' }, '自托管收款后台'))),
    NAV.map(item => item.group ? h('div', { class: 'nav-group' }, item.group) : (() => {
      const n = item.count ? item.count(state) : 0;
      return h('a', { class: ['nav-item', route.page === item.id && 'active'], href: '#/' + item.id, onclick: () => { state.ui.navOpen = false; } },
        h('span', null, item.label), n ? h('span', { class: ['nav-count', item.countTone] }, String(n)) : null);
    })()),
    h('div', { class: 'sidebar-foot' },
      h('div', null, '已登录 · 密码会话'),
      h('button', { class: 'btn small', type: 'button', onclick: logout }, '退出登录')));
}

function syncIndicator() {
  if (!state.online) return h('span', { class: 'sync offline' }, h('span', { class: 'dot' }), '离线 · 显示的是最后一次读取的数据');
  const s = state.status;
  if (state.errors.status) return h('span', { class: 'sync error' }, h('span', { class: 'dot' }), '无法读取同步状态');
  if (!s) return h('span', { class: 'sync offline' }, h('span', { class: 'dot' }), state.selectedId ? '读取中…' : '未配置');
  if (!s.configured) return h('span', { class: 'sync offline' }, h('span', { class: 'dot' }), '未配置');
  if (s.syncError) return h('span', { class: 'sync error', title: s.syncError }, h('span', { class: 'dot' }), '链上同步异常');
  const fresh = s.lastSync && Date.now() - s.lastSync < 60000 && s.cursor >= (s.head ?? 0);
  return h('span', { class: ['sync', !fresh && 'stale'] }, h('span', { class: 'dot' }),
    fresh ? `已同步 · ${relative(s.lastSync)}` : `同步落后 · 区块 ${s.cursor ?? '—'} / ${s.head ?? '—'}`);
}

function topbar() {
  const options = state.deployments.map(d => h('option', { value: d.id, selected: d.id === state.selectedId },
    literal(chainName(d.chainId, d.name)), d.chainId ? ' · ' + d.chainId : '', d.factory ? ' · ' + shortAddr(d.factory) : ' · 未配置', d.error ? ' · 加载失败' : ''));
  const current = app.selected();
  return h('header', { class: 'topbar' },
    h('button', { class: 'btn ghost small menu-btn', type: 'button', 'aria-label': '打开导航', onclick: () => { state.ui.navOpen = !state.ui.navOpen; shellEls.shell.classList.toggle('nav-open', state.ui.navOpen); } }, '菜单'),
    h('div', { class: 'context' },
      h('div', { class: 'context-select' }, h('select', { 'aria-label': '当前管理的部署', disabled: !options.length, onchange: e => selectDeployment(e.target.value) }, options.length ? options : h('option', { value: '' }, '尚无部署'))),
      current?.payout ? h('div', { class: 'context-meta' }, '收款钱包', h('code', { title: current.payout }, shortAddr(current.payout, 8, 6))) : null),
    h('div', { class: 'top-actions' }, syncIndicator(), languageButton()));
}

function pageContent(route) {
  const deployment = app.selected();
  const anyConfigured = state.deployments.some(d => d.factory);
  if (state.loaded.deployments && !anyConfigured && !['chains', 'settings', 'integration'].includes(route.page)) return onboardingPage(app);
  const page = PAGES[route.page] || overviewPage;
  if (deployment?.error) return h('div', { class: 'card card-body' }, h('h2', null, '该部署当前无法加载'), h('p', { class: 'muted' }, '服务端保留了它的历史数据，但启动时读取失败。请检查服务端日志后重启服务；其他部署不受影响。'));
  return page(app, route);
}

function render() {
  const route = parseRoute();
  if (state.auth === 'out') {
    shellEls = null;
    return replace(root, loginPage(app));
  }
  if (state.auth === 'unknown') return replace(root, h('div', { class: 'boot' }, '正在验证登录状态…'));

  // Preserve focus/caret of keyed inputs across re-renders (F1: polling must not steal UI state).
  const active = document.activeElement, key = active?.dataset?.key;
  let caret = null;
  try { if (active && typeof active.selectionStart === 'number') caret = [active.selectionStart, active.selectionEnd]; } catch {}
  const scroll = window.scrollY;

  if (!shellEls) {
    const content = h('main', { class: 'content', id: 'content' });
    const main = h('div', { class: 'main' });
    const shell = h('div', { class: 'shell' });
    shellEls = { shell, main, content };
    replace(root, shell);
  }
  const { shell, main, content } = shellEls;
  shell.classList.toggle('nav-open', state.ui.navOpen);
  replace(shell, sidebar(route), main);
  replace(main, topbar(), content);
  replace(content, pageContent(route));
  // A kept node is the same element: re-attaching it drops focus, so give it back.
  const again = active && active !== document.body && active.isConnected && content.contains(active) ? active
    : key ? content.querySelector(`[data-key="${CSS.escape(key)}"]`) : null;
  if (again && document.activeElement !== again) {
    again.focus({ preventScroll: true });
    if (caret) try { again.setSelectionRange(...caret); } catch {}
  }
  window.scrollTo(0, scroll);
}

async function logout() {
  // Invalidate requests immediately, but do not allow a new login to race the
  // logout response (which clears the same cookie).
  if (state.auth === 'unknown') return;
  authEpoch++; state.seq.reset(); clearAuthUI(); keptNodes.clear();
  state.auth = 'unknown'; render();
  try { await state.client.post('logout', {}); } catch {}
  app.setAuth('out');
}

// ---------- boot ----------
async function boot() {
  const client = liveClient();
  state.client = { ...client, async post(...args) {
    const epoch = authEpoch;
    try { return await client.post(...args); }
    catch (error) {
      // A wrong current password is not an expired cookie. Keep the dialog and
      // session so the owner can correct a typo; SESSION_REQUIRED still logs out.
      const wrongReauthentication = /^auth\//.test(args[0]) && error.code === 'UNAUTHORIZED';
      if (epoch === authEpoch && error.status === 401 && state.auth === 'in' && !wrongReauthentication) app.setAuth('out');
      throw error;
    }
  } };
  window.addEventListener('hashchange', () => {
    const r = parseRoute();
    render();
    if (r.page === 'orders' && r.arg) openOrderDrawer(app, r.arg);
  });
  window.addEventListener('online', () => { state.online = true; render(); refreshAll(); });
  window.addEventListener('offline', () => { state.online = false; render(); });
  await bootData();
  const r = parseRoute();
  if (r.page === 'orders' && r.arg) openOrderDrawer(app, r.arg);
  setInterval(() => {
    if (state.auth !== 'in' || !state.online || document.hidden) return;
    refreshAll().catch(error => toast(errorMessage(error), 'danger'));
  }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.auth === 'in') refreshAll(); });
}
boot();
