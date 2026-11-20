import UniversalProvider from '@walletconnect/universal-provider';
import QRCode from 'qrcode';
import { h } from '../shared/dom.js';
import { openDialog } from './ui.js';
import { validateDeploymentTransaction } from '../shared/deployment-guard.js';

// Local metadata, deliberately independent of the old page and shared display names.
const NETWORKS = { 1: ['Ethereum', 'ETH'], 56: ['BNB Smart Chain', 'BNB'], 137: ['Polygon', 'POL'], 8453: ['Base', 'ETH'], 42161: ['Arbitrum One', 'ETH'] };
let provider = null, session = null, revision = 0, connecting = false, generation = 0;
const fail = message => new Error(message);
const close = async p => { if (p && p !== window.ethereum) { try { p.abortPairingAttempt?.(); await p.disconnect(); } catch {} } };
export function metadata(config) {
  const known = NETWORKS[Number(config.chainId)];
  return { name: known?.[0] || config.chainName || config.name || 'Chain ' + config.chainId, symbol: known?.[1] || config.nativeSymbol };
}
function validateConfig(c) {
  if (!Number.isSafeInteger(Number(c.chainId)) || Number(c.chainId) < 1) throw fail('网络 Chain ID 无效。');
  const u = new URL(c.rpcUrl);
  if (u.protocol !== 'https:' || u.username || u.password) throw fail('钱包网络需要不含用户名密码的 HTTPS RPC。');
  if (!metadata(c).symbol) throw fail('请先设置该链正确的 gas 原生币符号。');
  if (!c.allowDeployment && !c.verifiedDeployment) throw fail('目标部署尚未核验。');
}
export async function connectWallet(kind, config) {
  if (connecting) throw fail('钱包正在连接，请先完成或取消。');
  connecting = true; const ticket = ++generation;
  let p, qr, timer, rejectCancel, handler;
  const cancelled = new Promise((_, reject) => { rejectCancel = reject; });
  const alive = () => { if (ticket !== generation) throw fail('钱包连接已取消。'); };
  const cancel = () => { if (ticket !== generation) return; generation++; rejectCancel(fail('钱包连接已取消。')); close(p); };
  try {
    validateConfig(config);
    await close(provider); provider = null; session = null; revision++;
    const work = (async () => {
      if (kind === 'walletconnect') {
        if (!/^[a-f0-9]{32}$/i.test(config.projectId || '')) throw fail('请在设置中保存你自己的 Reown Project ID；浏览器钱包无需此 ID。');
        p = await UniversalProvider.init({ projectId: config.projectId, logger: 'error', metadata: { name: 'UPayNow', description: '商户收款管理', url: location.origin, icons: [] } });
        if (ticket !== generation) { await close(p); alive(); }
        handler = async uri => {
          if (ticket !== generation) return;
          const canvas = h('canvas');
          try { await QRCode.toCanvas(canvas, uri, { width: 280, margin: 2 }); alive(); qr.setBody(h('div', { class: 'qr-box' }, canvas)); } catch { cancel(); }
        };
        p.on('display_uri', handler);
        await p.connect({ namespaces: { eip155: { chains: ['eip155:' + Number(config.chainId)], methods: ['eth_sendTransaction'], events: ['accountsChanged', 'chainChanged'], rpcMap: { [Number(config.chainId)]: config.rpcUrl } } } });
      } else {
        p = window.ethereum;
        if (!p?.request) throw fail('未检测到浏览器钱包扩展，请安装兼容 EIP-1193 的钱包。');
        await p.request({ method: 'eth_requestAccounts' });
      }
      if (ticket !== generation) { await close(p); alive(); }
      const hex = '0x' + Number(config.chainId).toString(16);
      if (Number(await p.request({ method: 'eth_chainId' })) !== Number(config.chainId)) {
        try { await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] }); }
        catch (e) {
          if (Number(e.code) !== 4902) throw e;
          const meta = metadata(config);
          await p.request({ method: 'wallet_addEthereumChain', params: [{ chainId: hex, chainName: meta.name, nativeCurrency: { name: meta.symbol, symbol: meta.symbol, decimals: 18 }, rpcUrls: [config.rpcUrl] }] });
        }
      }
      const accounts = await p.request({ method: 'eth_accounts' });
      const chainId = Number(await p.request({ method: 'eth_chainId' }));
      if (ticket !== generation) { await close(p); alive(); }
      if (!/^0x[a-f0-9]{40}$/i.test(accounts?.[0] || '') || chainId !== Number(config.chainId)) throw fail('钱包账户或网络不正确。');
      provider = p;
      session = Object.freeze({ address: accounts[0], chainId, revision: ++revision });
      for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) p.on?.(event, () => { if (provider === p) revision++; });
      return session;
    })();
    qr = openDialog({ title: '连接钱包', body: '正在等待钱包授权…', onClose: cancel, foot: h('button', { class: 'btn', onclick: cancel }, '取消连接') });
    timer = setTimeout(cancel, 180000);
    return await Promise.race([work, cancelled]);
  } catch (e) { await close(p); throw e; }
  finally { clearTimeout(timer); if (handler) p?.removeListener?.('display_uri', handler); if (ticket === generation) generation++; qr?.close(); connecting = false; }
}
export async function assertWallet(expected) {
  const p = provider;
  if (!p || session !== expected || expected.revision !== revision) throw fail('钱包账户或网络已改变，请重新核对；不会自动重发。');
  const accounts = await p.request({ method: 'eth_accounts' });
  const id = Number(await p.request({ method: 'eth_chainId' }));
  if (p !== provider || revision !== expected.revision || id !== expected.chainId || accounts?.[0]?.toLowerCase() !== expected.address.toLowerCase()) throw fail('钱包账户或网络已改变；不会自动重发。');
  return p;
}
export function validateTransaction(tx, expected, config, deployment = false) {
  if (deployment && typeof deployment === 'object') return validateDeploymentTransaction(tx, expected, deployment.job, deployment.intent);
  const allowed = new Set(['from', 'data', 'value', 'chainId', 'gas', ...(!deployment ? ['to'] : [])]);
  if (!tx || Object.keys(tx).some(k => !allowed.has(k)) || Number(tx.chainId) !== expected.chainId || Number(config.chainId) !== expected.chainId
    || tx.from?.toLowerCase() !== expected.address.toLowerCase() || BigInt(tx.value ?? -1) !== 0n
    || !/^0x(?:[a-f0-9]{2})+$/i.test(tx.data || '') || !/^0x[0-9a-f]+$/i.test(tx.gas || '')
    || (!deployment && tx.to?.toLowerCase() !== config.factory?.toLowerCase())) throw fail('交易网络、账户、合约、金额或字段与审核范围不符，已阻止发送。');
}
export async function walletSender(tx, expected, config, deployment) {
  validateTransaction(tx, expected, config, deployment);
  const p = await assertWallet(expected);
  // The caller invokes the returned function once. Only errors from this actual
  // request are eligible for explicit 4001 rejection registration.
  return () => {
    if (provider !== p || revision !== expected.revision || session !== expected) throw fail('钱包会话已改变，禁止发送。');
    return p.request({ method: 'eth_sendTransaction', params: [tx] });
  };
}
