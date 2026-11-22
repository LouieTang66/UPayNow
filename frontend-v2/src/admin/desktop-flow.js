import { keccak256 } from 'ethers';
import { h, notice, copyable, kv } from '../shared/dom.js';
import { connectWallet, assertWallet, walletSender, metadata } from './wallet.js';
import { createAttempt, recoveryStore, readRecovery } from './transaction.js';
import { errorMessage, toast } from './ui.js';
import { deterministic, bootstrap, assertDeploymentSender } from '../shared/deployment-guard.js';
import { assertRecoveryContext, validateRecoveryJob } from '../shared/recovery-guard.js';

let inFlight = false;
const claimed = new WeakSet();
export function claimWalletChoice(dialog) {
  if (dialog.closed || claimed.has(dialog)) return false;
  claimed.add(dialog); return true;
}
export const desktopBusy = () => inFlight;
export async function desktopFlow(app, d, { kind, deploymentId, intent, deploymentJob, recovery }) {
  if (inFlight || d.closed || !claimWalletChoice(d)) return;
  inFlight = true;
  const scope = { deploymentId }, isDeploy = !!deploymentJob;
  let released = false;
  const release = () => { if (!released) { released = true; inFlight = false; } };
  d.setTitle('正在连接钱包', '请在钱包中授权账户并核对网络。');
  d.setBody(h('div', { class: 'row' }, h('span', { class: 'spinner' }), '连接中…')); d.setFoot();
  try {
    // WC configuration is always read from the explicitly captured deployment.
    // An unconfigured legacy engine has no wallet config; injected deployment
    // does not require it. WC fails visibly rather than inventing a project ID.
    let walletConfig = {};
    if (!isDeploy || kind === 'walletconnect') walletConfig = await app.client.get('wallet/config', scope);
    const config = isDeploy ? { ...deploymentJob.summary, ...{ projectId: walletConfig.projectId }, allowDeployment: true } : walletConfig;
    if (recovery && (Number(config.chainId) !== Number(recovery.target.chainId) || config.factory?.toLowerCase() !== recovery.target.factory?.toLowerCase() || config.payout?.toLowerCase() !== recovery.target.payout?.toLowerCase())) throw new Error('钱包配置与查询目标链不符。');
    const expected = await connectWallet(kind, config);
    if (recovery && expected.address.toLowerCase() !== recovery.target.payout.toLowerCase()) throw new Error('错链找回必须使用目标部署固定收款 payout 钱包签名。');
    if (isDeploy) assertDeploymentSender(deploymentJob, expected.address);
    if (recovery) assertRecoveryContext(app, recovery);
    if (d.closed) { release(); return; }
    let job = deploymentJob, summary, held = false;
    if (!isDeploy) {
      const prepared = recovery
        ? await app.client.post('crosschain-recovery/prepare', { ...recovery.request, from: expected.address })
        : await app.client.post('wallet/prepare', { ...intent, from: expected.address }, scope);
      job = prepared.job; summary = prepared.summary; held = prepared.heldCount > 0;
      if (recovery && job) validateRecoveryJob(job, recovery, prepared.deploymentId);
      if (!job) { d.setBody(notice('info', '没有可归集余额，没有发送交易。')); release(); return; }
      if (!summary || Number(summary.chainId) !== expected.chainId || summary.from?.toLowerCase() !== expected.address.toLowerCase()
        || summary.to?.toLowerCase() !== config.factory?.toLowerCase() || BigInt(summary.value ?? -1) !== 0n || !/^0x[a-f0-9]{64}$/i.test(summary.calldataHash || '')) throw new Error('审核摘要与目标部署不符，已阻止发送。');
    }
    await assertWallet(expected);
    const route = isDeploy ? `deployment-jobs/${job.id}` : `wallet/jobs/${job.id}`;
    const key = (isDeploy ? 'deployment' : deploymentId) + ':' + job.id;
    if (readRecovery()[key]) throw new Error('此记录有未完成的发送尝试，请在恢复页登记原交易，不能再次发送。');
    const store = recoveryStore(key);
    const attempt = createAttempt({ client: app.client, route, scope: isDeploy ? undefined : scope, from: expected.address,
      ...store, sender: async (tx, begun) => {
        if (recovery) assertRecoveryContext(app, recovery);
        if (!isDeploy && keccak256(tx.data) !== summary.calldataHash) throw new Error('交易数据与审核摘要不同，已阻止发送。');
        const send = await walletSender(tx, expected, config, isDeploy && deterministic(job) ? { job, intent: begun.intent || begun.job?.intent } : isDeploy);
        return () => { if (recovery) assertRecoveryContext(app, recovery); return send(); };
      } });
    d.setTitle(isDeploy ? '核对并确认部署' : '核对并确认归集', '只有点击下方按钮，才会交给钱包发送一次。');
    d.setBody(kv([['网络', `${metadata(config).name} · Chain ${expected.chainId} · gas ${metadata(config).symbol}`],
      ['发送钱包', copyable(expected.address)], ['固定收款钱包', copyable(config.payout)],
      ...(!isDeploy ? [['Factory', copyable(config.factory)], ['订单数', String(job.orderIds?.length || 1)]] : [['支持币种', (config.tokens || []).map(t => `${t.symbol || ''} ${t.address || t}`).join('、')], ...(deterministic(job) ? [['阶段', bootstrap(job) ? '准备同地址部署入口（不会注册商户部署）' : '部署商户合约'], ['预期 Factory', copyable(config.predictedFactory)], ['签名限制', '必须使用固定收款 payout 钱包；不能签名的地址不支持']] : [])]),
      ['记录 ID', copyable(job.id)]]), held ? notice('unknown', '部分订单仍在等原交易核对', '本次仅列出未锁定的订单。') : null,
    notice('warn', '关闭页面或断网不会取消已签名交易', '后台会先持久记录 UNKNOWN，再交给钱包；任何不确定结果都只能恢复原交易，不能自动重发。'));
    let clicked = false;
    d.setFoot(h('button', { class: 'btn', onclick: async () => {
      if (clicked) return; clicked = true;
      if (!isDeploy) { try { await app.client.post(route + '/cancel', {}, scope); } catch (e) { toast(errorMessage(e), 'danger'); } }
      d.close(); release(); app.refresh();
    } }, '取消'), h('button', { class: 'btn primary', onclick: async e => {
      if (clicked) return; clicked = true; e.currentTarget.disabled = true;
      d.setFoot(); d.setBody(notice('unknown', '请在钱包中核对并确认', '结果未知时请勿重新发起，原记录会保留用于恢复。'));
      try {
        await assertWallet(expected);
        if (recovery) assertRecoveryContext(app, recovery);
        const result = await attempt();
        d.setBody(notice(result.state === 'MINED' ? 'ok' : 'info', result.state === 'MINED' ? '交易已核验上链，请查看逐笔结果' : '已登记原交易哈希，等待后台链上核验。'));
      } catch (error) { d.setBody(notice('warn', errorMessage(error), '请到归集异常恢复或部署记录核对。不会自动重新发送。')); }
      finally {
        release(); recoveryActions(app, d, key);
        app.refresh(); if (isDeploy) app.refreshDeployments();
      }
    } }, '确认并交给钱包'));
    // Closing during review releases the connection gate but never starts a send.
    const watch = setInterval(() => { if (d.closed) { clearInterval(watch); if (!clicked) release(); } }, 300);
  } catch (error) {
    release();
    if (!d.closed) { d.setBody(notice('danger', errorMessage(error), '未自动发送或重发交易；如已有准备记录，请在记录页查看。')); d.setFoot(h('button', { class: 'btn', onclick: () => d.close() }, '关闭')); }
  }
}
export function recoveryActions(app, d, key) {
  const r = readRecovery()[key];
  d.setFoot(r && ['HASH_PENDING', 'REJECTION_PENDING'].includes(r.phase) ? h('button', { class: 'btn primary', onclick: async e => {
    if (e.currentTarget.disabled) return; e.currentTarget.disabled = true;
    try {
      await app.client.post(r.route + (r.hash ? '/attach' : '/cancel'), r.hash ? { transactionHash: r.hash } : { rejected: true }, r.scope);
      recoveryStore(key).remove(); d.setBody(notice('info', '原交易登记已完成，未发送新交易。')); app.refresh();
    } catch (error) { toast(errorMessage(error), 'danger'); }
    finally { recoveryActions(app, d, key); }
  } }, r.hash ? '重试登记原哈希（不重发）' : '重试登记拒签（不重发）') : null, h('button', { class: 'btn', onclick: () => d.close() }, '关闭'));
}
export function pendingRecoveryButton(app, key) {
  const r = readRecovery()[key];
  if (!r || !['HASH_PENDING', 'REJECTION_PENDING'].includes(r.phase)) return null;
  return h('button', { class: 'btn small', onclick: async e => {
    if (e.currentTarget.disabled) return; e.currentTarget.disabled = true;
    try { await app.client.post(r.route + (r.hash ? '/attach' : '/cancel'), r.hash ? { transactionHash: r.hash } : { rejected: true }, r.scope); recoveryStore(key).remove(); app.refresh(); }
    catch (error) { toast(errorMessage(error), 'danger'); e.currentTarget.disabled = false; }
  } }, r.hash ? '重试登记本机原哈希' : '重试登记本机明确拒签');
}
