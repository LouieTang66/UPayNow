// Phone page: confirm one merchant contract deployment (capability link /v2/d/<id>#<token>).
import { h, replace, copyable, notice, field } from '../shared/dom.js';
import { countdown, shortAddr } from '../shared/format.js';
import { errorText } from '../shared/status.js';
import { header, capability, localRecord, capFetch, CLOSED_CODES, ApiError, beginRefused } from './common.js';
import { deterministic, bootstrap, assertDeploymentSender, validateDeploymentTransaction } from '../shared/deployment-guard.js';

const root = document.getElementById('app');
const id = location.pathname.match(/\/d\/([0-9a-f-]{36})$/i)?.[1] || '';
const TERMINAL = ['MINED', 'CANCELLED'];

let token = '', job = null, expiresAt = null, failure = null, closed = false;
let account = null, revision = 0, acting = false, message = null, ackDone = false, ackPending = false, latest = 0, shown = 0;
let hashDraft = null, lastKey = '', reading = false;
let retryStarting = false, retryReadyAt = 0, requestRevision = 0;
const record = localRecord('deploy', id);

// ---------- data ----------
const api = (suffix = '', body) => capFetch('/api/deploy/' + encodeURIComponent(id) + suffix, token, body);

// Ticketed reads: an older GET (success or failure) never overwrites a newer
// result or an already displayed terminal state (F7-style guard).
async function read() {
  if (reading) return;
  reading = true;
  const ticket = ++latest;
  try {
    const v = await api();
    if (ticket < shown || (job?.state === 'MINED' && v.state !== 'MINED') || (v.walletRequestRevision || 0) < (job?.walletRequestRevision || 0)) return;
    shown = ticket; job = v; requestRevision = Math.max(requestRevision, v.walletRequestRevision || 0); expiresAt = v.expiresAt || expiresAt; failure = null;
    if (record.get()?.beginRefused && v.state === 'READY' && !v.from) record.clear();
  } catch (e) {
    if (ticket < shown || job?.state === 'MINED') return;
    failure = e; if (e.status === 410 || CLOSED_CODES.includes(e.code)) closed = true;
  } finally { reading = false; }
  const key = JSON.stringify([job, failure?.code, closed]);
  if (key !== lastKey) render();
}

function applyResult(v) {
  if (v?.state) {
    if (job?.state === 'MINED' && v.state !== 'MINED' || (v.walletRequestRevision || 0) < (job?.walletRequestRevision || 0)) return;
    shown = ++latest; job = { ...job, ...v }; requestRevision = Math.max(requestRevision, v.walletRequestRevision || 0); expiresAt = v.expiresAt || expiresAt; failure = null;
  }
  render();
}

// ---------- wallet ----------
const eth = () => window.ethereum?.request ? window.ethereum : null;
async function session(expectedFrom, expectedRevision) {
  const p = eth(); if (!p) throw new Error('未检测到钱包。请在手机钱包的内置浏览器中打开此链接。');
  const accounts = await p.request({ method: 'eth_accounts' }), chain = Number(await p.request({ method: 'eth_chainId' }));
  if (revision !== expectedRevision || (expectedFrom && accounts?.[0]?.toLowerCase() !== expectedFrom.toLowerCase()) || chain !== Number(job.summary.chainId))
    throw new Error('钱包账户或网络已变化，已停止。不会自动重发。');
  return p;
}
async function connect() {
  const p = eth(); if (!p) throw new Error('未检测到钱包。请在手机钱包的内置浏览器中打开此链接。');
  const s = job.summary, hexId = '0x' + Number(s.chainId).toString(16);
  const accounts = await p.request({ method: 'eth_requestAccounts' });
  if (Number(await p.request({ method: 'eth_chainId' })) !== Number(s.chainId)) {
    try { await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] }); }
    catch (e) { if (Number(e.code) !== 4902) throw new Error('请在钱包中切换到 ' + s.name + '（Chain ID ' + s.chainId + '）。'); throw new Error('钱包中没有这条网络，请先在钱包里添加 ' + s.name + '。'); }
  }
  revision++;
  account = accounts?.[0] || null;
  await session(account, revision);
}

// ---------- actions ----------
async function act(fn) {
  if (acting) return; acting = true; message = null; render();
  try { await fn(); } catch (e) { message = { tone: 'danger', text: e.code ? errorText(e.code) : e.message }; }
  finally { acting = false; render(); }
}

async function deploy() {
  if (!account || job.state !== 'READY' || record.get() || expired()) throw new Error('当前不能开始部署，请刷新状态。');
  const from = account, rev = revision;
  const approvedJob = job;
  assertDeploymentSender(job, from);
  await session(from, rev);
  record.set({ state: 'BEGIN_SENT' }, true);           // durable before begin; never released by guesswork
  let begun;
  try { begun = await api('/begin', { from }); }
  catch (e) {
    if (beginRefused(e)) {
      record.set({ state: 'BEGIN_SENT', beginRefused: true });
      // The server answered (e.g. BUSY / estimate failure). Only if a fresh read
      // AFTER that answer still shows READY did begin provably not start (F10).
      try { const v = await api(); if (v.state === 'READY' && !v.from) { record.clear(); applyResult(v); throw new Error(`后台确认部署尚未开始（${errorText(e.code)}），可以重新尝试。`); } applyResult(v); }
      catch (inner) { if (inner instanceof Error && !(inner instanceof ApiError)) throw inner; }
    }
    throw new Error('开始状态不明，没有调用钱包。请刷新状态或到电脑后台核对，不要重复部署。');
  }
  return requestWallet(begun, from, rev, approvedJob);
}

const hasKnownHash = () => !!(record.get()?.hash || job?.candidateHash || job?.txHash);
async function requestWallet(begun, from, rev, approvedJob = job) {
  if (hasKnownHash() || job?.state === 'MINED') return;
  const attempt = begun.job.walletRequestRevision || 0;
  if (attempt < requestRevision) return;
  requestRevision = attempt;
  record.set({ ...(record.get() || {}), state: 'UNKNOWN', rejected: false, requestRevision: attempt });
  applyResult(begun.job);
  const tx = begun.transaction;
  validateDeploymentTransaction(tx, { address: from, chainId: Number(approvedJob.summary.chainId) }, approvedJob, begun.intent || begun.job?.intent);
  const p = await session(from, rev);
  if (expired() || closed) throw new Error('入口已关闭或到期，没有调用钱包。请回电脑后台核对原任务。');
  if (attempt !== requestRevision || hasKnownHash() || job?.state === 'MINED') return;
  let hash;
  try {
    const pending = p.request({ method: 'eth_sendTransaction', params: [tx] });
    acting = false; retryStarting = false; render();
    hash = await pending;
  } catch (e) {
    if (attempt !== requestRevision || hasKnownHash() || job?.state === 'MINED') return;
    if (Number(e.code) === 4001) {
      record.set({ ...(record.get() || {}), state: 'UNKNOWN', rejected: true, requestRevision: attempt });
      return registerRejection(attempt);
    }
    if (Number(e.code) === -32002) throw new Error('钱包中仍有待确认请求，请回钱包继续原请求。');
    throw new Error('钱包暂未返回交易结果。请先核对钱包是否已有发送记录；未发送时可手动重新请求确认，已有哈希则登记原交易。');
  }
  if (!/^0x[0-9a-f]{64}$/i.test(hash || '')) throw new Error('钱包没有返回有效哈希。请在钱包中查找原交易后登记。');
  const previous = record.get() || {};
  record.set({ ...previous, state: 'UNKNOWN', hash: previous.hash || hash,
    hashes: [...new Set([...(previous.hashes || []), ...(previous.hash ? [previous.hash] : []), hash])] });
  render();
  try { applyResult(await api('/attach', { transactionHash: hash, requestRevision: attempt })); }
  catch (e) { if (job?.state !== 'MINED') throw e; }
}

function canRetry() {
  return !!job?.from && !closed && !expired() && !hasKnownHash()
    && (job.state === 'UNKNOWN' || job.state === 'CANCELLED' && job.outcome === 'REJECTED');
}
async function retry() {
  if (retryStarting || Date.now() < retryReadyAt || !canRetry()) return;
  retryStarting = true; message = null; render();
  try {
    if (!account) await connect();
    const from = account, rev = revision, approvedJob = job;
    if (from?.toLowerCase() !== job.from?.toLowerCase()) throw new Error('请连接原部署请求使用的钱包账户。');
    assertDeploymentSender(job, from); await session(from, rev);
    const begun = await api('/retry', {});
    if (!begun.transaction) { applyResult(begun.job); return; }
    retryReadyAt = Date.now() + 1000; setTimeout(() => render(), 1000);
    await requestWallet(begun, from, rev, approvedJob);
  } catch (e) { message = { tone: 'danger', text: e.code ? errorText(e.code) : e.message }; }
  finally { retryStarting = false; render(); }
}
async function registerRejection(attempt = requestRevision) {
  if (attempt !== requestRevision || hasKnownHash() || job?.state === 'MINED') return;
  let result;
  try { result = await api('/reject', { requestRevision: attempt }); }
  catch (e) { if (e.code === 'STALE_WALLET_REQUEST') return; throw e; }
  if (attempt !== requestRevision) return;
  applyResult(result);
  message = { tone: null, text: '已取消本次钱包确认，可在原有效期内重新请求；如果交易其实已经发出，请登记原哈希。' };
}

async function attach(hash) {
  if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error(errorText('INVALID_TRANSACTION_HASH'));
  record.set({ ...(record.get() || {}), state: 'UNKNOWN', hash });
  applyResult(await api('/attach', { transactionHash: hash }));
  message = { tone: 'ok', text: '已登记原交易哈希，正在核验。没有发送新交易。' };
}

function acknowledge() {
  if (!TERMINAL.includes(job?.state) || canRetry() || ackDone || ackPending || expired()) return;
  ackPending = true;
  // Two frames: the terminal result is painted before the backend may close the tunnel.
  requestAnimationFrame(() => requestAnimationFrame(async () => {
    try { if (canRetry() || !TERMINAL.includes(job?.state)) return; await api('/ack', {}); ackDone = true; } catch { /* a lost ACK never changes the shown result */ } finally { ackPending = false; }
  }));
}

// ---------- view ----------
const expired = () => !expiresAt || Date.now() >= new Date(expiresAt).getTime();
const left = h('span', { class: 'countdown' });
function tick() { if (!expiresAt) return; const ms = new Date(expiresAt).getTime() - Date.now(); left.textContent = ms > 0 ? `入口剩余 ${countdown(ms)}` : '入口已到期'; left.classList.toggle('low', ms < 60000); }

function statusBlock() {
  const r = record.get();
  if (job.state === 'MINED' && job.outcome === 'SUCCESS') return bootstrap(job)
    ? ['ok', '公共入口已准备就绪', '尚未注册商户部署。请回电脑部署记录，主动点击“部署商户合约”创建下一笔任务；不会自动发送。']
    : ['ok', '部署成功', '合约已通过链上核验并加入商户后台。可以关闭此页面。'];
  if (job.state === 'MINED') return ['danger', '部署交易已上链，但没有成功', '没有添加任何收款合约。请回到电脑后台查看原因。'];
  if (job.state === 'CANCELLED') return ['neutral', '已取消本次钱包确认', '可在原有效期内重新请求钱包确认。如果交易其实已经发出，请登记原交易哈希。'];
  if (job.state === 'UNKNOWN' && job.candidateHash) return ['info', '已登记交易哈希，正在等待确认', '达到确认数并核验后会自动完成。无需再次操作。'];
  if (job.state === 'UNKNOWN' || r) return ['unknown', '等待钱包结果', '请先检查钱包是否已有发送记录；未发送时可手动重新请求钱包确认，已有交易哈希时只登记原交易。'];
  return ['info', '等待你确认部署', '请核对下方全部参数，确认无误后连接钱包并确认。'];
}

function render() {
  if (!id || !token) return replace(root, h('div', { class: 'pub' }, header('确认部署'), h('div', { class: 'panel' }, h('div', { class: 'panel-body' },
    notice('danger', '链接不完整', '请重新扫描电脑上显示的二维码，或在同一个标签页中打开完整链接。')))));
  if (!job) return replace(root, h('div', { class: 'pub' }, header('确认部署'), h('div', { class: 'panel' }, h('div', { class: 'panel-body' },
    failure ? notice(closed ? null : 'danger', closed ? '这个手机入口已关闭或到期' : '暂时无法读取部署记录', closed ? '入口关闭不代表部署失败。请回到电脑后台的“部署记录”查看结果。' : errorText(failure.code))
      : h('div', { class: 'row' }, h('span', { class: 'spinner' }), '正在读取…')))));
  const s = job.summary || {}, [tone, title, desc] = statusBlock(), r = record.get(), terminal = TERMINAL.includes(job.state);
  const hashInput = h('input', { class: 'input mono', placeholder: '0x…（66 位）', value: hashDraft ?? (r?.hash || job.candidateHash || ''), autocomplete: 'off', spellcheck: 'false',
    dataset: { key: 'hash' }, oninput: e => { hashDraft = e.target.value; } });
  const focused = document.activeElement?.dataset?.key;
  const canStart = job.state === 'READY' && !r && !expired() && !closed;
  const showRecovery = !terminal || job.state === 'CANCELLED';
  tick();
  replace(root, h('div', { class: 'pub' },
    header('确认部署收款合约', terminal && !canRetry() ? null : left),
    h('div', { class: 'panel' },
      h('div', { class: 'panel-body' }, h('div', { class: ['pay-status', tone] }, h('span', { class: 'dot' }), h('div', null, h('div', { class: 't' }, title), h('div', { class: 'd' }, desc))),
        closed && !terminal ? notice(null, '手机入口已关闭', '这只表示本页无法继续操作，不代表部署失败。请回到电脑后台核对。') : null,
        failure && !closed && !terminal ? notice('warn', '状态刷新失败', '下方是上一次读取的结果，不能据此判断部署失败。') : null,
        message ? notice(message.tone, null, message.text) : null),
      deterministic(job) ? h('div', { class: 'panel-body' }, notice('warn', bootstrap(job) ? '准备同地址部署入口' : '部署商户合约', `预期 Factory：${s.predictedFactory}。必须由固定收款钱包 ${s.payout} 签名；不能签名的地址不支持。每次仅发送本阶段一笔交易。`)) : null,
      h('div', { class: 'panel-body' }, h('dl', { class: 'facts' },
        h('div', null, h('dt', null, '网络'), h('dd', { translate: 'no' }, `${s.name} · Chain ID ${s.chainId}`)),
        h('div', null, h('dt', null, 'gas 支付'), h('dd', null, `由你的钱包支付 ${s.nativeSymbol}`)),
        h('div', null, h('dt', null, '固定收款钱包'), h('dd', null, h('code', null, s.payout))),
        h('div', null, h('dt', null, '付款确认数'), h('dd', null, String(s.confirmations))),
        h('div', null, h('dt', null, '支持币种'), h('dd', null, h('div', { class: 'stack tight' }, (s.tokens || []).map(t => h('div', null, h('strong', { translate: 'no' }, t.symbol || ''), ' ', h('code', null, t.address || t)))))),
        job.factory ? h('div', null, h('dt', null, 'Factory'), h('dd', null, h('code', null, job.factory))) : null),
        h('p', { class: 'muted small' }, '收款钱包和支持币种会写入合约，部署后不可修改。')),
      canStart ? h('div', { class: 'panel-body actions' },
        account ? h('div', { class: 'muted small' }, '已连接 ', h('code', null, shortAddr(account, 8, 6)), '（仅连接，尚未签名）') : null,
        account ? h('button', { class: 'btn primary lg', type: 'button', disabled: acting, onclick: () => act(deploy) }, bootstrap(job) ? '准备同地址部署入口（发送一次）' : '确认部署（发送一次）')
          : h('button', { class: 'btn primary lg', type: 'button', disabled: acting, onclick: () => act(connect) }, '连接钱包')) : null,
      showRecovery && !canStart ? h('div', { class: 'panel-body stack' },
        h('h3', null, '恢复操作'),
        canRetry() ? h('div', { class: 'stack' },
          notice('warn', '先核对钱包是否已经发送', '重新请求不会自动取消之前的钱包弹窗。若已有发送记录，请登记原哈希，不要再次确认；此操作不延长入口有效期。'),
          h('button', { class: 'btn primary block', type: 'button', disabled: acting || retryStarting || Date.now() < retryReadyAt, onclick: retry }, retryStarting ? '正在请求…' : '重新请求钱包确认')) : null,
        h('div', null, h('button', { class: 'btn block', type: 'button', disabled: acting, onclick: () => act(async () => { await read(); message = { tone: null, text: '已刷新状态（只查询，不发交易）。' }; }) }, '刷新状态')),
        !job.candidateHash ? h('form', { class: 'stack', onsubmit: e => { e.preventDefault(); act(() => attach(hashInput.value.trim())); } },
          field('登记原交易哈希', hashInput, { hint: '在钱包交易记录中复制“创建合约”交易的哈希。登记不会发送新交易。' }),
          h('button', { class: 'btn', type: 'submit', disabled: acting }, '登记原交易哈希')) : null,
        r?.rejected && job.state === 'UNKNOWN' && !job.candidateHash ? h('button', { class: 'btn', type: 'button', disabled: acting, onclick: () => act(() => registerRejection()) }, '重试登记明确拒签') : null) : null),
    h('p', { class: 'pub-foot' }, '入口最长开放 5 分钟。关闭或到期不会取消已签名的交易。')));
  lastKey = JSON.stringify([job, failure?.code, closed]);
  if (focused) root.querySelector(`[data-key="${focused}"]`)?.focus();
  if (terminal) acknowledge();
}

(async () => {
  token = capability('deploy', id);
  window.ethereum?.on?.('accountsChanged', () => { revision++; account = null; message = { tone: 'warn', text: '钱包账户已变化，请重新连接。未知任务不会自动重发。' }; render(); });
  window.ethereum?.on?.('chainChanged', () => { revision++; account = null; render(); });
  render();
  if (token) await read();
  setInterval(() => { if (!acting && !closed && !(TERMINAL.includes(job?.state) && ackDone)) read(); }, 5000);
  setInterval(tick, 1000);
})();
