const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
export function assertRecoveryContext(app, context) {
  const target = app.state.deployments.find(d => d.id === context.request.targetDeploymentId);
  if (app.state.selectedId !== context.request.sourceDeploymentId || !target || target.scheme !== 'deterministic-v2'
      || Number(target.chainId) !== Number(context.target.chainId) || !same(target.factory, context.target.factory) || !same(target.payout, context.target.payout))
    throw new Error('当前部署或目标链配置已改变，请关闭后重新查询；禁止发送。');
}
export function validateRecoveryPreview(preview, request, sourceOrder, target) {
  if (!preview || preview.sourceDeploymentId !== request.sourceDeploymentId || preview.targetDeploymentId !== request.targetDeploymentId
      || preview.orderId !== request.orderId || !same(preview.orderHash, sourceOrder.orderHash) || !same(preview.address, sourceOrder.address)
      || !same(preview.token, request.token) || !same(preview.payout, target.payout) || Number(preview.chainId) !== Number(target.chainId)
      || !/^\d+$/.test(String(preview.balanceUnits)) || !Number.isInteger(preview.decimals) || preview.decimals < 0 || preview.decimals > 36)
    throw new Error('错链找回查询结果与原订单、目标链或收款钱包不符，已阻止继续。');
  return preview;
}
export function validateRecoveryJob(job, context, deploymentId) {
  if (!job || (job.deploymentId || deploymentId) !== context.request.targetDeploymentId || !job.recoveryOnly
      || job.recovery?.sourceDeploymentId !== context.request.sourceDeploymentId || job.recovery?.targetDeploymentId !== context.request.targetDeploymentId
      || job.recovery?.orderId !== context.request.orderId || !same(job.recovery?.token, context.request.token)
      || Number(job.chainId) !== Number(context.target.chainId) || !same(job.factory, context.target.factory)) throw new Error('找回任务不属于已核对的目标链和资产，已阻止发送。');
}
