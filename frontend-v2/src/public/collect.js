// Phone page: confirm one approved collection batch (capability link /v2/c/<id>#<token>).
import { h, replace, notice, field } from '../shared/dom.js';
import { amount, countdown, shortAddr } from '../shared/format.js';
import { errorText } from '../shared/status.js';
import { header, capability, localRecord, capFetch, CLOSED_CODES, ApiError, beginRefused } from './common.js';

const root = document.getElementById('app');
const id = location.pathname.match(/\/c\/([0-9a-f-]{36})$/i)?.[1] || '';
const TERMINAL = ['MINED', 'CANCELLED', 'REPLACED', 'ABANDONED', 'EXPIRED'];

let token = '', view = null, failure = null, closed = false, account = null, revision = 0;
let acting = false, message = null, latest = 0, shown = 0, hashDraft = null, lastKey = '', review = null, reading = false;
let retryStarting = false, retryReadyAt = 0, requestRevision = 0;
const record = localRecord('collect', id);

const api = (suffix = '', body) => capFetch('/api/handoffs/' + encodeURIComponent(id) + suffix, token, body);

const isTerminal = () => TERMINAL.includes(view?.job?.state);
// Older reads never overwrite newer data; errors never hide a displayed terminal result (F7).
async function read() {
  if (reading) return;
  reading = true;
  const ticket = ++latest;
  try {
    const v = await api();
    if (ticket < shown) return;
    shown = ticket; view = v; failure = null;
    if (record.get()?.beginRefused && v.job?.state === 'PREPARED') record.clear();
  }
  catch (e) { if (ticket < shown || isTerminal()) return; failure = e; if (e.status === 410 || CLOSED_CODES.includes(e.code)) closed = true; }
  finally { reading = false; }
  if (JSON.stringify([view, failure?.code, closed]) !== lastKey) render();
}
function applyJob(job) { if (job?.state) { shown = ++latest; view = { ...view, job: { ...view.job, ...job } }; failure = null; } render(); }

const eth = () => window.ethereum?.request ? window.ethereum : null;
async function session(from, rev) {
  const p = eth(); if (!p) throw new Error('未检测到钱包。请在手机钱包的内置浏览器中打开此链接。');
  const accounts = await p.request({ method: 'eth_accounts' }), chain = Number(await p.request({ method: 'eth_chainId' }));
  if (rev !== revision || accounts?.[0]?.toLowerCase() !== from.toLowerCase() || chain !== Number(view.chainId)) throw new Error('钱包账户或网络已变化，已停止。不会自动重发。');
  return p;
}
async function connect() {
  const p = eth(); if (!p) throw new Error('未检测到钱包。请在手机钱包的内置浏览器中打开此链接。');
  const accounts = await p.request({ method: 'eth_requestAccounts' });
  if (Number(await p.request({ method: 'eth_chainId' })) !== Number(view.chainId)) {
    try { await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x' + Number(view.chainId).toString(16) }] }); }
    catch { throw new Error(`请在钱包中切换到 ${view.chainName}（Chain ID ${view.chainId}）。`); }
  }
  revision++; account = accounts?.[0] || null; await session(account, revision);
}
async function act(fn) {
  if (acting) return; acting = true; message = null; render();
  try { await fn(); } catch (e) { message = { tone: 'danger', text: e.code ? errorText(e.code) : e.message }; }
  finally { acting = false; render(); }
}

async function prepareReview() {
  if (record.get() || closed || Date.now() >= new Date(view.expiresAt).getTime() || (view.job && view.job.state !== 'PREPARED') || (!view.job && view.state !== 'READY')) throw new Error('当前不能开始归集，请刷新状态。');
  const from = account, rev = revision; await session(from, rev);
  const r = await api('/prepare', { from });
  if (!r.job) { message = { tone: null, text: '余额已被归集或条件变化，没有需要发送的交易，不消耗 gas。' }; await read(); return; }
  const sm = r.summary;
  if (!sm || Number(sm.chainId) !== Number(view.chainId) || sm.from?.toLowerCase() !== from.toLowerCase() || sm.to?.toLowerCase() !== view.factory.toLowerCase() || BigInt(sm.value ?? -1) !== 0n)
    throw new Error('审核摘要与当前钱包或收款合约不一致，已停止。');
  review = { from, rev }; applyJob(r.job);
}

async function send() {
  const { from, rev } = review || {}; if (!from) throw new Error('请先核对交易。');
  if (record.get() || view.job?.state !== 'PREPARED' || closed || Date.now() >= new Date(view.expiresAt).getTime()) throw new Error('当前不能发送，请刷新状态。');
  await session(from, rev);
  record.set({ state: 'BEGIN_SENT' }, true);
  let begun;
  try { begun = await api('/begin', {}); }
  catch (e) {
    if (beginRefused(e)) {
      record.set({ state: 'BEGIN_SENT', beginRefused: true });
      try { const v = await api(); if (v.job?.state === 'PREPARED') { record.clear(); shown = ++latest; view = v; throw new Error(`后台确认尚未开始发送（${errorText(e.code)}），可以重试。`); } }
      catch (inner) { if (!(inner instanceof ApiError)) throw inner; }
    }
    throw new Error('开始状态不明，没有调用钱包。请刷新状态，或到电脑后台“异常恢复”核对；不要重复发起。');
  }
  record.set({ state: 'UNKNOWN' });
  return requestWallet(begun, from, rev);
}

async function requestWallet(begun, from, rev) {
  if (record.get()?.hash || view.job?.txHash || view.job?.candidateHash) return;
  const attempt = begun.job.walletRequestRevision || 0;
  requestRevision = attempt;
  record.set({ ...(record.get() || {}), state: 'UNKNOWN', rejected: false, requestRevision: attempt });
  applyJob(begun.job);
  const tx = begun.transaction;
  if (!tx || 'nonce' in tx || !/^0x(?:[0-9a-f]{2})+$/i.test(tx.data || '') || Number(tx.chainId) !== Number(view.chainId) || tx.from?.toLowerCase() !== from.toLowerCase() || tx.to?.toLowerCase() !== view.factory.toLowerCase() || BigInt(tx.value ?? -1) !== 0n)
    throw new Error('交易参数与本批归集不符，已停止，没有调用钱包。请到电脑后台核对。');
  const p = await session(from, rev);
  if (closed || Date.now() >= new Date(view.expiresAt).getTime()) throw new Error('入口已关闭或到期，没有调用钱包。请回电脑后台核对原任务。');
  if (attempt !== requestRevision || record.get()?.hash || view.job?.txHash || view.job?.candidateHash) return;
  let hash;
  try {
    const pending = p.request({ method: 'eth_sendTransaction', params: [tx] });
    // Waiting on a hidden wallet dialog must not disable the explicit retry/recovery controls.
    acting = false; retryStarting = false; render();
    hash = await pending;
  } catch (e) {
    if (attempt !== requestRevision || view.job?.txHash || view.job?.candidateHash) return;
    if (Number(e.code) === 4001) {
      record.set({ ...(record.get() || {}), state: 'UNKNOWN', rejected: true, requestRevision: attempt });
      let rejected;
      try { rejected = await api('/reject', { requestRevision: attempt }); }
      catch (error) { if (error.code === 'STALE_WALLET_REQUEST') return; throw error; }
      if (attempt === requestRevision) { applyJob(rejected); message = { tone: null, text: '已取消本次确认，可以重新请求钱包确认。' }; }
      return;
    }
    if (Number(e.code) === -32002) throw new Error('钱包中仍有待确认请求，请回钱包继续原请求。');
    throw new Error('钱包暂未返回交易结果，可重新请求确认；如已有交易记录，也可登记原交易哈希。');
  }
  if (!/^0x[0-9a-f]{64}$/i.test(hash || '')) throw new Error('钱包未返回有效哈希，请在钱包查找原交易，不能重发。');
  const previous = record.get() || {};
  record.set({ ...previous, state: 'UNKNOWN', hash: previous.hash || hash,
    hashes: [...new Set([...(previous.hashes || []), ...(previous.hash ? [previous.hash] : []), hash])] });
  render();
  applyJob(await api('/attach', { transactionHash: hash, requestRevision: attempt }));
}

function canRetry() {
  const j = view?.job;
  return !!j && !closed && Date.now() < new Date(view.expiresAt).getTime()
    && !j.txHash && !j.candidateHash && !record.get()?.hash
    && (j.state === 'UNKNOWN' || j.state === 'CANCELLED' && j.error === 'USER_REJECTED');
}
async function retry() {
  if (retryStarting || Date.now() < retryReadyAt || !canRetry()) return;
  retryStarting = true; message = null; render();
  try {
    if (!account) await connect();
    const from = account, rev = revision;
    if (from?.toLowerCase() !== view.job.from?.toLowerCase()) throw new Error('请连接原归集请求使用的钱包账户。');
    await session(from, rev);
    record.set({ ...(record.get() || {}), state: 'UNKNOWN' }, true);
    const begun = await api('/retry', {});
    if (!begun.transaction) { applyJob(begun.job); return; }
    retryReadyAt = Date.now() + 1000;
    setTimeout(() => render(), 1000);
    await requestWallet(begun, from, rev);
  } catch (e) { message = { tone: 'danger', text: e.code ? errorText(e.code) : e.message }; }
  finally { retryStarting = false; render(); }
}

async function attach(hash) {
  if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error(errorText('INVALID_TRANSACTION_HASH'));
  record.set({ ...(record.get() || {}), state: 'UNKNOWN', hash });
  applyJob(await api('/attach', { transactionHash: hash }));
  message = { tone: 'ok', text: '已登记原交易哈希，正在核对回执。没有发送新交易。' };
}

const left = h('span', { class: 'countdown' });
function tick() { if (!view?.expiresAt) return; const ms = new Date(view.expiresAt).getTime() - Date.now(); left.textContent = ms > 0 ? `入口剩余 ${countdown(ms)}` : '入口已到期'; left.classList.toggle('low', ms < 60000); }

function status() {
  const j = view.job, r = record.get();
  if (j?.state === 'MINED') {
    if (j.outcome === 'NO_BALANCE') return ['neutral', '归集交易已执行，未转出余额', '链上已确认，这笔交易可能已消耗 gas。'];
    if (j.outcome === 'PARTIAL_SUCCESS') return ['info', '归集完成，部分订单无余额', '请按逐笔结果核对。'];
    return j.outcome === 'SUCCESS' ? ['ok', '归集完成', '本批每一笔都已转入固定收款钱包。'] : j.outcome === 'PARTIAL_FAILURE' ? ['warn', '归集部分失败', '失败的订单资金仍在原地址，可在电脑后台处理后重新归集。'] : ['danger', '交易已回滚', '没有资金被转移。'];
  }
  if (j?.state === 'SUBMITTED') return ['info', '已提交，等待链上确认', '无需再次操作。'];
  if (j?.state === 'CANCELLED') return ['neutral', '已取消', j.error === 'USER_REJECTED' ? '已取消本次确认，可以重新请求钱包确认。' : '本批没有发送交易。'];
  if (j?.state === 'ABANDONED') return ['unknown', '已由后台人工结束追踪', '这不证明交易没有发出。请回电脑后台核对，不要重复发起。'];
  if (j?.state === 'REPLACED') return ['warn', '原交易已被替换', '请回电脑后台核对替换交易，不要重复发起。'];
  if (j?.state === 'EXPIRED' || (!j && ['EXPIRED', 'REVOKED'].includes(view.state))) return ['neutral', '入口已关闭或到期', '请回到电脑后台查看结果。'];
  if (!j && view.state === 'EMPTY') return ['neutral', '没有可归集余额', '余额或条件已经变化，本批没有发送交易，不消耗 gas。'];
  if (j?.state === 'UNKNOWN' || r) return ['unknown', '等待钱包结果', '可继续在钱包中确认，或重新请求钱包确认；已有交易哈希时可直接登记。'];
  if (j?.state === 'PREPARED') return ['info', '请核对后确认', '确认后钱包会弹出一笔交易，由你支付 gas。'];
  return ['info', '等待确认归集', '核对本批订单和收款钱包，然后连接钱包。'];
}

function render() {
  const shell = (...body) => replace(root, h('div', { class: 'pub' }, header('确认资金归集', view && (!isTerminal() || canRetry()) ? left : null), ...body));
  if (!id || !token) return shell(h('div', { class: 'panel' }, h('div', { class: 'panel-body' }, notice('danger', '链接不完整', '请重新扫描电脑上显示的二维码。'))));
  if (!view) return shell(h('div', { class: 'panel' }, h('div', { class: 'panel-body' }, failure
    ? notice(null, closed ? '这个手机入口已关闭或到期' : '暂时无法读取', closed ? '这不代表归集失败。请回到电脑后台查看结果。' : errorText(failure.code))
    : h('div', { class: 'row' }, h('span', { class: 'spinner' }), '正在读取…'))));
  const [tone, title, desc] = status(), j = view.job, r = record.get(), terminal = isTerminal();
  const ev = entry => (j?.events || []).find(e => e.forwarder?.toLowerCase() === entry.address.toLowerCase() && (!e.token || e.token.toLowerCase() === entry.token.toLowerCase()));
  const focused = document.activeElement?.dataset?.key;
  const hashInput = h('input', { class: 'input mono', placeholder: '0x…（66 位）', value: hashDraft ?? (r?.hash || ''), dataset: { key: 'hash' }, autocomplete: 'off', spellcheck: 'false', oninput: e => { hashDraft = e.target.value; } });
  const available = !r && !closed && Date.now() < new Date(view.expiresAt).getTime();
  const fresh = available && ((!j && view.state === 'READY') || (j?.state === 'PREPARED' && !review));
  const reviewing = available && j?.state === 'PREPARED' && review;
  tick();
  shell(h('div', { class: 'panel' },
    h('div', { class: 'panel-body' }, h('div', { class: ['pay-status', tone] }, h('span', { class: 'dot' }), h('div', null, h('div', { class: 't' }, title), h('div', { class: 'd' }, desc))),
      closed && !terminal ? notice(null, '手机入口已关闭', '这只表示本页无法继续操作，不代表归集失败。请回到电脑后台核对。') : null,
      failure && !closed && !terminal ? notice('warn', '状态刷新失败', '下方是上一次读取的结果。') : null,
      message ? notice(message.tone, null, message.text) : null),
    h('div', { class: 'panel-body' }, h('dl', { class: 'facts' },
      h('div', null, h('dt', null, '网络'), h('dd', { translate: 'no' }, `${view.chainName} · Chain ID ${view.chainId}`)),
      h('div', null, h('dt', null, '资金去向（固定）'), h('dd', null, h('code', null, view.payout))),
      h('div', null, h('dt', null, 'gas'), h('dd', null, `由你的钱包支付 ${view.nativeSymbol}`)))),
    h('div', { class: 'panel-body stack' }, h('h3', null, `本批订单（${view.entries.length}）`),
      view.entries.map(e => { const x = ev(e); return h('div', { class: 'entry' },
        h('div', { class: 'top' }, h('span', { translate: 'no' }, e.reference), h('span', null, amount(e.balance), ' ', e.symbol)),
        h('div', { class: 'meta' }, `应付 ${amount(e.expectedAmount)} ${e.symbol} · 地址 ${shortAddr(e.address, 8, 6)}`),
        x ? h('div', { class: 'meta' }, x.name === 'Collected' ? '✓ 已归集' : x.name === 'CollectFailed' ? '✗ 归集失败，资金仍在原地址' : x.name) : null); }),
      h('p', { class: 'muted small' }, '金额是创建入口时的余额。实际归集执行时该币种的全部余额（含超额）。')),
    fresh ? h('div', { class: 'panel-body actions' },
      account ? h('div', { class: 'muted small' }, '已连接 ', h('code', null, shortAddr(account, 8, 6))) : null,
      account ? h('button', { class: 'btn primary lg', type: 'button', disabled: acting, onclick: () => act(prepareReview) }, '核对交易')
        : h('button', { class: 'btn primary lg', type: 'button', disabled: acting, onclick: () => act(connect) }, '连接钱包')) : null,
    reviewing ? h('div', { class: 'panel-body actions' }, notice('info', '确认后只发送一笔批量交易', `发送钱包 ${shortAddr(review.from, 8, 6)}，资金只会转入上面的固定收款钱包。`),
      h('button', { class: 'btn primary lg', type: 'button', disabled: acting, onclick: () => act(send) }, '确认归集并支付 gas')) : null,
    (!terminal || canRetry()) && (r || j?.state === 'UNKNOWN' || canRetry()) ? h('div', { class: 'panel-body stack' }, h('h3', null, '恢复操作'),
      canRetry() ? h('button', { class: 'btn primary block', type: 'button', disabled: retryStarting || Date.now() < retryReadyAt, onclick: retry }, retryStarting ? '正在请求钱包…' : '重新请求钱包确认') : null,
      h('button', { class: 'btn block', type: 'button', disabled: acting, onclick: () => act(async () => { await read(); message = { tone: null, text: '已刷新（只查询，不发交易）。' }; }) }, '刷新状态'),
      !j?.txHash && !j?.candidateHash ? h('form', { class: 'stack', onsubmit: e => { e.preventDefault(); act(() => attach(hashInput.value.trim())); } },
        field('登记原交易哈希', hashInput, { hint: '在钱包交易记录中复制。登记不会发送新交易。' }), h('button', { class: 'btn', type: 'submit', disabled: acting }, '登记原交易哈希')) : null,
      r?.rejected && j?.state === 'UNKNOWN' && !j?.candidateHash && !j?.txHash ? h('button', { class: 'btn', type: 'button', disabled: acting, onclick: () => act(async () => { applyJob(await api('/reject', { requestRevision: r.requestRevision || 0 })); }) }, '重试登记明确拒签') : null) : null),
    h('p', { class: 'pub-foot' }, '入口最长开放 5 分钟。关闭或到期不会取消已签名的交易。'));
  lastKey = JSON.stringify([view, failure?.code, closed]);
  if (focused) root.querySelector(`[data-key="${focused}"]`)?.focus();
}

(async () => {
  token = capability('collect', id);
  window.ethereum?.on?.('accountsChanged', () => { revision++; account = null; review = null; message = { tone: 'warn', text: '钱包账户已变化，请重新连接。' }; render(); });
  window.ethereum?.on?.('chainChanged', () => { revision++; account = null; review = null; render(); });
  render();
  if (token) await read();
  window.addEventListener('online', () => { if (token && !acting && !closed) read(); });
  document.addEventListener('visibilitychange', () => { if (token && !document.hidden && !acting && !closed) read(); });
  setInterval(() => { if (!acting && !closed && (!isTerminal() || canRetry())) read(); }, 5000);
  setInterval(tick, 1000);
})();
