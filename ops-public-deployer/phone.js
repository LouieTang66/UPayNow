'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const SINGLETON = '0xce0042b868300000d44a59004da54a005ffdcf9f';
  const ROOT = '0x17f45eff0a2cb4805180b62034f49c18d66e35ee';
  const id = location.pathname.match(/^\/o\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i)?.[1];
  const storageKey = 'upay-ops-phone:' + id;
  let record, view, account = null, busy = false, changed = false, timer, acknowledged = false;
  const status = text => { $('status').textContent = text; };
  function save() { sessionStorage.setItem(storageKey, JSON.stringify(record)); }
  try {
    if (!id) throw Error('invalid');
    record = JSON.parse(sessionStorage.getItem(storageKey) || '{}');
    const fragment = location.hash.slice(1);
    if (fragment) {
      // Keep the raw fragment only in this tab's session storage, never in queries or logs.
      if (record.token && record.token !== fragment) throw Error('token mismatch');
      record.token = fragment; save();
    }
    if (!record.token || /[\r\n]/.test(record.token)) throw Error('missing');
  } catch (_) {
    history.replaceState(null, '', location.pathname);
    status('链接无效或浏览器无法安全保存会话。请回桌面处理，不要重复发送。'); return;
  }
  history.replaceState(null, '', location.pathname);
  const expired = () => !view || !Number.isFinite(new Date(view.expiresAt).getTime()) || Date.now() >= new Date(view.expiresAt).getTime();
  const ended = () => !view || expired() || !!view.closedAt || !!view.ready;
  function controls() {
    $('connect').disabled = busy || ended() || !!record.pending || !!record.hash || view.state !== 'READY';
    $('send').disabled = busy || ended() || !account || changed || !!record.pending || !!record.hash || view.state !== 'READY';
    $('verify').disabled = busy || !view;
  }
  async function api(action = '', input) {
    const options = { method: input === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'omit', redirect: 'error', headers: { Authorization: 'Bearer ' + record.token } };
    if (input !== undefined) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(input); }
    const r = await fetch('/api/ops/' + encodeURIComponent(id) + (action ? '/' + action : ''), options);
    if (!r.ok) throw Error('会话请求失败，请回桌面只读核验（HTTP ' + r.status + '）。');
    return r.json();
  }
  function validView(v) {
    if (!v || v.id !== id || !['READY', 'UNKNOWN', 'MINED'].includes(v.state) || v.singleton?.toLowerCase() !== SINGLETON || v.deployer?.toLowerCase() !== ROOT || !Number.isSafeInteger(v.chainId) || v.chainId <= 0) throw Error('固定部署会话参数不符。');
    return v;
  }
  async function render(v) {
    view = validView(v);
    $('details').textContent = JSON.stringify({ chainId: view.chainId, state: view.state, from: view.from, hash: record.hash || view.hash, requestRevision: view.requestRevision, expiresAt: view.expiresAt, creationCodeHash: view.creationCodeHash, runtimeCodeHash: view.runtimeCodeHash }, null, 2);
    if (view.ready) {
      record.pending = false; save(); clearTimeout(timer);
      status('公共入口已就绪。无需再次部署。');
      if (!acknowledged) { await api('ack', {}); acknowledged = true; }
    } else if (view.closedAt || expired()) {
      clearTimeout(timer); status('会话已关闭或过期，禁止新发送。请回桌面只读核验；已有交易不会因此取消。');
    } else if (record.hash) status('已保存交易哈希，仅上报和只读核验，不会再次发送。');
    else if (record.pending || view.state !== 'READY') status('发送结果未知或交易处理中，禁止重复发送。请检查钱包记录并只读核验。');
    else status('请核对链与固定地址，连接 OneKey 钱包后点击部署。链接有效期 5 分钟。');
    controls();
  }
  async function run(fn) {
    if (busy) return; busy = true; controls();
    try { await fn(); } catch (e) { status(e.message || '操作未完成，请回桌面只读核验；不会自动重发。'); }
    finally { busy = false; controls(); }
  }
  function wallet() {
    if (!window.ethereum?.request) throw Error('未检测到钱包。请用 OneKey 内置浏览器打开原链接。');
    return window.ethereum;
  }
  async function checkWallet(w, from, chainId) {
    const accounts = await w.request({ method: 'eth_accounts' });
    const chain = await w.request({ method: 'eth_chainId' });
    if (changed || accounts[0]?.toLowerCase() !== from.toLowerCase() || BigInt(chain) !== BigInt(chainId)) throw Error('钱包账户或链发生变化，禁止发送；请只读核验。');
  }
  function checkedTransaction(v, from) {
    const tx = v.transaction;
    const allowed = ['from', 'to', 'chainId', 'value', 'gas', 'data'];
    if (!tx || Object.keys(tx).some(k => !allowed.includes(k)) || allowed.some(k => !Object.hasOwn(tx, k))) throw Error('交易字段不符合白名单。');
    const quantity = x => typeof x === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(x);
    if (tx.from?.toLowerCase() !== from.toLowerCase() || tx.to?.toLowerCase() !== SINGLETON || !quantity(tx.chainId) || BigInt(tx.chainId) !== BigInt(v.chainId) || !quantity(tx.value) || BigInt(tx.value) !== 0n || !quantity(tx.gas) || BigInt(tx.gas) <= 0n || typeof tx.data !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(tx.data) || !/^0x[0-9a-f]{64}$/i.test(v.creationCodeHash) || !/^0x[0-9a-f]{64}$/i.test(v.runtimeCodeHash)) throw Error('固定交易地址、账户、链、零金额、gas 或部署数据不符。');
    return Object.fromEntries(allowed.map(k => [k, tx[k]]));
  }
  async function reportHash() {
    if (record.hash) await render(await api('attach', { transactionHash: record.hash, requestRevision: record.requestRevision }));
  }
  $('connect').onclick = () => run(async () => {
    const w = wallet(); changed = false;
    const accounts = await w.request({ method: 'eth_requestAccounts' });
    const from = accounts[0]; if (!/^0x[0-9a-f]{40}$/i.test(from || '')) throw Error('钱包账户无效。');
    if (BigInt(await w.request({ method: 'eth_chainId' })) !== BigInt(view.chainId)) await w.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x' + BigInt(view.chainId).toString(16) }] });
    // A deliberate switch during connection is allowed; future changes invalidate sending.
    changed = false; await checkWallet(w, from, view.chainId); account = from;
    status('钱包已连接：' + from + '。请再次核对参数后点击部署。');
  });
  $('send').onclick = () => run(async () => {
    if (ended() || record.pending || record.hash || changed || !account || view.state !== 'READY') throw Error('当前状态禁止发送，请只读核验。');
    const w = wallet(), from = account, chainId = view.chainId;
    await checkWallet(w, from, chainId);
    if (!confirm('仅部署固定公共入口，由钱包支付 gas。确认继续？')) return;
    if (ended()) throw Error('会话已过期，请回桌面核验。');
    const initial = view;
    const prepared = validView(await api('begin', { from }));
    if (prepared.ready) { await render(prepared); return; }
    if (prepared.requestRevision === undefined || prepared.requestRevision === null) throw Error('缺少请求版本，禁止发送。');
    record.pending = true; record.from = from; record.requestRevision = prepared.requestRevision; save();
    view = prepared;
    if (prepared.chainId !== chainId || prepared.from?.toLowerCase() !== from.toLowerCase() || prepared.creationCodeHash !== initial.creationCodeHash || prepared.runtimeCodeHash !== initial.runtimeCodeHash || ended()) throw Error('会话参数变化或已过期，禁止发送；请只读核验。');
    const tx = checkedTransaction(prepared, from);
    await checkWallet(w, from, chainId);
    if (ended()) throw Error('会话已过期，禁止发送。');
    let hash;
    try { hash = await w.request({ method: 'eth_sendTransaction', params: [tx] }); }
    catch (e) {
      if (Number(e.code) === 4001) {
        const rejected = await api('reject', { requestRevision: record.requestRevision });
        validView(rejected);
        if (rejected.state === 'READY' && !rejected.hash) { record.pending = false; delete record.requestRevision; save(); await render(rejected); }
        throw Error('钱包明确拒绝。仅成功释放请求后才可再次尝试。');
      }
      throw Error('钱包结果未知，禁止重发；请核对钱包记录并回桌面只读核验。');
    }
    if (!/^0x[0-9a-f]{64}$/i.test(hash || '')) throw Error('钱包未返回有效哈希，禁止重发。');
    // Hash is saved before any network call; reporting never depends on the wallet's current chain.
    record.hash = hash; save();
    await reportHash();
  });
  $('verify').onclick = () => run(async () => { await reportHash(); if (!view?.ready) await render(await api('verify', {})); else await render(view); });
  const w = window.ethereum;
  if (w?.on) {
    const invalidate = () => { changed = true; account = null; controls(); };
    w.on('accountsChanged', invalidate); w.on('chainChanged', invalidate); w.on('disconnect', invalidate);
  }
  async function poll() {
    if (!busy) await run(async () => { await reportHash(); if (!view?.ready) await render(await api()); });
    if (!ended()) timer = setTimeout(poll, 3000);
  }
  void run(async () => { await reportHash(); if (!view?.ready) await render(await api()); }).then(() => { if (!ended()) timer = setTimeout(poll, 3000); });
})();
