'use strict';
const $ = id => document.getElementById(id);
const config = () => ({ chainId: Number($('chain').value), rpcUrl: $('rpc').value.trim() });
let approved = null, busy = false, phone = null, phoneTimer = null;
const key = c => JSON.stringify(c);
const pendingKey = c => 'upay-ops-pending:' + key(c);
const show = v => { $('output').textContent = typeof v === 'string' ? v : JSON.stringify(v, null, 2); };
async function api(action, input) {
  const r = await fetch('/api/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), cache: 'no-store' });
  const result = await r.json(); if (!r.ok) throw Error(result.error || '请求失败'); return result;
}
function controls() {
  const pending = !!localStorage.getItem(pendingKey(config()));
  $('deploy').disabled = busy || !approved || approved.ready || pending;
  $('phone-create').disabled = busy || pending || !!phone;
  $('phone-close').disabled = busy || !phone;
}
function invalidate() { approved = null; controls(); }
$('chain').oninput = $('rpc').oninput = invalidate;
async function run(fn) {
  if (busy) return; busy = true; controls();
  try { await fn(); } catch (e) { show(e.message + '\n没有自动重发交易；请核对钱包记录，再只读核验。'); }
  finally { busy = false; controls(); }
}
function stopPhone() { clearTimeout(phoneTimer); phoneTimer = null; }
function phoneView(v, explicitlyClosed = false) {
  if (!phone) return;
  phone.view = v;
  const expired = Date.now() >= new Date(v.expiresAt).getTime();
  $('phone-status').textContent = `状态：${v.state}；有效期至 ${new Date(v.expiresAt).toLocaleString()}（5 分钟）` + (v.ready ? '；已就绪' : v.closedAt ? '；已关闭，请核验' : expired ? '；已过期，请在桌面只读核验' : '') + (v.hash ? `；交易：${v.hash}` : '');
  if (v.ready || (explicitlyClosed && v.state === 'READY' && !v.hash)) localStorage.removeItem(pendingKey(phone.config));
  if (v.ready || v.closedAt || expired) {
    stopPhone(); $('phone-qr').hidden = true; $('phone-link').removeAttribute('href'); $('phone-copy').disabled = true;
    if (v.ready || explicitlyClosed) phone = null;
  }
  controls();
}
async function pollPhone() {
  const current = phone;
  if (!current) return;
  try { const v = await api('phone/status', { id: current.id }); if (phone !== current) return; phoneView(v); }
  catch (_) { $('phone-status').textContent = '状态暂不可用；不会重新创建或发送。请只读核验。'; }
  if (phone === current && !current.view?.ready && !current.view?.closedAt && !(Date.now() >= new Date(current.view?.expiresAt || current.expiresAt).getTime())) phoneTimer = setTimeout(pollPhone, 3000);
}
$('phone-create').onclick = () => run(async () => {
  const c = config();
  if (phone || localStorage.getItem(pendingKey(c))) throw Error('已有待确认记录，禁止创建手机会话；请先只读核验。');
  const p = await api('phone', c);
  // Persist the cross-device lock before rendering any usable link. Never store its bearer URL.
  phone = { id: p.id, config: c, expiresAt: p.expiresAt };
  localStorage.setItem(pendingKey(c), JSON.stringify({ phoneId: p.id, pending: true }));
  $('phone-panel').hidden = false; $('phone-qr').hidden = false; $('phone-copy').disabled = false;
  const url = new URL(p.url, location.href);
  if (url.protocol !== 'https:' || url.username || url.password || !/^\/o\/[0-9a-f-]{36}$/i.test(url.pathname) || !url.hash || url.search) throw Error('手机链接格式不符');
  $('phone-link').href = url.href; $('phone-link').textContent = '打开手机链接';
  if (typeof p.qrSvg !== 'string' || !p.qrSvg.trim().startsWith('<svg')) throw Error('二维码格式不符');
  $('phone-qr').src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(p.qrSvg);
  phoneView(p.view); stopPhone(); if (phone) void pollPhone();
});
$('phone-copy').onclick = () => run(async () => {
  const href = $('phone-link').getAttribute('href'); if (!href) throw Error('链接已不可用');
  await navigator.clipboard.writeText(href); $('phone-status').textContent += '；链接已复制，请勿转发';
});
$('phone-close').onclick = () => run(async () => {
  if (!phone) return;
  const v = await api('phone/close', {}); phoneView(v, true); stopPhone();
});
$('preview').onclick = () => run(async () => { const c = config(); const p = await api('preview', c); if (key(config()) !== key(c)) return; approved = p; show(p); });
$('verify').onclick = () => run(async () => {
  const c = config(), p = await api('verify', c); approved = key(c) === key(config()) ? p : null;
  if (p.ready) { localStorage.removeItem(pendingKey(c)); if (phone && key(phone.config) === key(c)) { stopPhone(); phone = null; $('phone-panel').hidden = true; } }
  else if (!phone) {
    const saved = JSON.parse(localStorage.getItem(pendingKey(c)) || 'null');
    if (saved?.phoneId) { phone = { id: saved.phoneId, config: c }; $('phone-panel').hidden = false; $('phone-qr').hidden = true; $('phone-copy').disabled = true; void pollPhone(); }
  }
  show(p);
});
$('deploy').onclick = () => run(async () => {
  const c = config(), storageKey = pendingKey(c);
  if (!approved || approved.ready || approved.chainId !== c.chainId || approved.rpcUrl !== new URL(c.rpcUrl).href || localStorage.getItem(storageKey)) throw Error('请先预览；已有待确认发送记录时禁止重复发送。');
  const wallet = window.ethereum; if (!wallet?.request) throw Error('请安装浏览器钱包');
  const [from] = await wallet.request({ method: 'eth_requestAccounts' });
  const chainId = '0x' + BigInt(c.chainId).toString(16);
  if (BigInt(await wallet.request({ method: 'eth_chainId' })) !== BigInt(chainId)) await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  const p = await api('prepare', { ...c, from }); show(p);
  if (p.ready || !p.transaction) { approved = p; return; }
  if (key(c) !== key(config())) throw Error('配置发生变化，请重新预览');
  if (p.deployer.toLowerCase() !== '0x17f45eff0a2cb4805180b62034f49c18d66e35ee' || p.transaction.to.toLowerCase() !== '0xce0042b868300000d44a59004da54a005ffdcf9f' || BigInt(p.transaction.value) !== 0n || BigInt(p.transaction.chainId) !== BigInt(c.chainId)) throw Error('固定发布参数不符');
  const accounts = await wallet.request({ method: 'eth_accounts' });
  if (accounts[0]?.toLowerCase() !== from.toLowerCase() || BigInt(await wallet.request({ method: 'eth_chainId' })) !== BigInt(c.chainId)) throw Error('钱包账户或网络发生变化');
  if (!confirm('核对预览参数：将部署固定公共入口，由钱包支付 gas。继续？')) return;
  localStorage.setItem(storageKey, JSON.stringify({ from, pending: true }));
  let hash;
  try { hash = await wallet.request({ method: 'eth_sendTransaction', params: [p.transaction] }); }
  catch (e) { if (Number(e.code) === 4001) localStorage.removeItem(storageKey); throw e; }
  localStorage.setItem(storageKey, JSON.stringify({ from, hash }));
  if (BigInt(await wallet.request({ method: 'eth_chainId' })) !== BigInt(c.chainId)) throw Error('钱包网络已变化，原交易哈希：' + hash);
  const verified = await api('verify', c); approved = verified; show({ hash, ...verified });
  if (verified.ready) localStorage.removeItem(storageKey);
});
controls();
