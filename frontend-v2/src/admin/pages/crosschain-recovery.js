import { h, field, notice, kv, copyable } from '../../shared/dom.js';
import { fromUnits, chainName } from '../../shared/format.js';
import { openDialog, busy, errorMessage } from '../ui.js';
import { desktopFlow } from '../desktop-flow.js';
import { assertRecoveryContext, validateRecoveryPreview } from '../../shared/recovery-guard.js';

// Dedicated cross-chain endpoint: never send an A order to B's ordinary prepare.
export function openCrosschainRecovery(app, order) {
  const sourceDeploymentId = app.state.selectedId;
  const source = app.state.deployments.find(d => d.id === sourceDeploymentId);
  const sameAddress = (a, b) => typeof a === 'string' && /^0x(?!0{40}$)[0-9a-f]{40}$/i.test(a) && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
  const targets = source?.scheme === 'deterministic-v2' && !source.error && Number(source.chainId) === Number(order.chainId)
    ? app.state.deployments.filter(d => d.scheme === 'deterministic-v2' && d.id !== sourceDeploymentId && Number(d.chainId) !== Number(order.chainId) && !d.error
      && sameAddress(d.payout, source.payout) && sameAddress(d.factory, source.factory)) : [];
  const d = openDialog({ title: '错链找回', wide: true });
  if (!targets.length) { d.setBody(notice('info', '没有匹配的目标链部署', '请先到“链与合约”，在另一条链部署并核验同一收款钱包对应的 deterministic-v2 商户合约。公共入口已就绪不代表商户合约已部署；其他钱包或旧版合约不能用于此订单的错链找回。')); return; }
  const targetInput = h('select', {}, targets.map(t => h('option', { value: t.id }, `${chainName(t.chainId, t.name)} · Chain ${t.chainId}`)));
  const tokenInput = h('input', { class: 'input mono', placeholder: '该链资产 CA；原生币填 0x0000000000000000000000000000000000000000', autocomplete: 'off' });
  const err = h('div', { class: 'error-text', role: 'alert' });
  d.setBody(notice('warn', '不改变原订单付款状态', '只查询另一条链上同一订单地址的余额，找回资金仅进入目标部署的固定收款钱包；不会创建新订单。手机恢复暂不支持，请使用本机钱包。'),
    field('目标链（已注册的同地址部署）', targetInput), field('目标链资产 CA（原生币填零地址）', tokenInput), err);
  d.setFoot(h('button', { class: 'btn', onclick: () => d.close() }, '关闭'), h('button', { class: 'btn primary', onclick: e => busy(e.currentTarget, async () => {
    const token = tokenInput.value.trim();
    if (!/^0x[0-9a-f]{40}$/i.test(token)) throw new Error('请输入正确的目标链资产 CA。');
    const target = { ...targets.find(t => t.id === targetInput.value) };
    const request = Object.freeze({ sourceDeploymentId, orderId: order.id, targetDeploymentId: target.id, token });
    const context = Object.freeze({ request, target: Object.freeze(target) });
    assertRecoveryContext(app, context);
    const preview = validateRecoveryPreview(await app.client.post('crosschain-recovery/preview', request), request, order, target);
    assertRecoveryContext(app, context);
    if (d.closed) return;
    const balance = fromUnits(BigInt(preview.balanceUnits), preview.decimals);
    d.setTitle('核对错链找回', '以下只读查询尚未准备或发送交易。连接钱包后还需要显式确认。');
    d.setBody(kv([['原订单', order.reference || order.id], ['目标链', `Chain ${preview.chainId}`], ['同一订单地址', copyable(preview.address, { full: true })],
      ['资产 CA', copyable(preview.token, { full: true })], ['余额', `${balance} ${preview.symbol || ''}`], ['固定收款钱包', copyable(preview.payout, { full: true })]]),
      notice('warn', '请核对目标链和资产', '选择当前部署、钱包账户或钱包网络发生变化会阻止发送。未知结果请切换到目标部署的“归集 → 异常恢复”登记原交易，不要重复发起。'));
    d.setFoot(h('button', { class: 'btn', onclick: () => d.close() }, '关闭'),
      BigInt(preview.balanceUnits) > 0n ? h('button', { class: 'btn primary', onclick: () => desktopFlow(app, d, { kind: 'injected', deploymentId: target.id, recovery: context }) }, '连接本机钱包并核对找回') : null,
      BigInt(preview.balanceUnits) > 0n ? h('button', { class: 'btn', onclick: () => desktopFlow(app, d, { kind: 'walletconnect', deploymentId: target.id, recovery: context }) }, 'WalletConnect') : null);
  }, { onError: error => { err.textContent = errorMessage(error); } }) }, '只读查询并核对'));
}
