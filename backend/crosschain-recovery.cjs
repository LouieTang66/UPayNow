'use strict';
const { ethers, address, requireValue: check } = require('./chain.cjs');
const { inspectDeployment } = require('./deployment-service.cjs');
const same = (a,b) => String(a).toLowerCase() === String(b).toLowerCase();
class CrosschainRecovery {
  constructor(deployments) { this.deployments = deployments; }
  async preview(body) {
    check(body && typeof body === 'object', 'INVALID_RECOVERY');
    check(typeof body.sourceDeploymentId === 'string' && typeof body.targetDeploymentId === 'string', 'RECOVERY_SCOPE_REQUIRED');
    const source = this.deployments.get(body.sourceDeploymentId), target = this.deployments.get(body.targetDeploymentId);
    check(source.merchant && target.merchant, 'DEPLOYMENT_UNAVAILABLE', 503);
    const sc = source.merchant.requireChain().config, tc = target.merchant.requireChain().config;
    check(sc.scheme === 'deterministic-v2' && tc.scheme === 'deterministic-v2', 'DETERMINISTIC_DEPLOYMENTS_REQUIRED', 409);
    check(sc.chainId !== tc.chainId, 'RECOVERY_REQUIRES_DIFFERENT_CHAIN', 409);
    check(same(sc.payout, tc.payout) && same(sc.factory, tc.factory) && same(sc.deployer, tc.deployer), 'RECOVERY_DEPLOYMENT_MISMATCH', 409);
    const order = source.store.order(body.orderId); check(order, 'ORDER_NOT_FOUND', 404);
    check(/^0x[0-9a-f]{64}$/i.test(order.orderHash), 'INVALID_ORDER_HASH', 409);
    // Revalidate provenance and every immutable on BOTH chains, not caller-supplied labels.
    await Promise.all([inspectDeployment(sc), inspectDeployment(tc)]);
    const s = source.merchant.chain, t = target.merchant.chain;
    const [si, ti, sa, ta] = await Promise.all([s.factory.implementation(), t.factory.implementation(), s.factory.predictAddress(order.orderHash), t.factory.predictAddress(order.orderHash)]);
    check(same(si, ti) && same(sa, ta) && same(sa, order.address), 'RECOVERY_ADDRESS_MISMATCH', 409);
    check(Number(order.chainId) === sc.chainId && same(order.factory || sc.factory, sc.factory), 'RECOVERY_ORDER_SCOPE_MISMATCH', 409);
    const token = address(body.token);
    let balance, decimals, symbol, metadataAvailable = true;
    if (token === ethers.ZeroAddress) {
      balance = await t.provider.getBalance(ta); decimals = 18; symbol = tc.nativeSymbol || 'ETH';
    } else {
      check(await t.provider.getCode(token) !== '0x', 'TOKEN_NOT_CONTRACT');
      const c = new ethers.Contract(token, ['function decimals() view returns(uint8)', 'function symbol() view returns(string)', 'function balanceOf(address) view returns(uint256)'], t.provider);
      balance = await c.balanceOf(ta);
      // ERC-20 metadata is optional. Recovery never needs a human-unit amount:
      // preserve the exact raw balance instead of blocking a transferable asset.
      try { decimals = Number(await c.decimals()); } catch { decimals = null; }
      metadataAvailable = Number.isInteger(decimals) && decimals >= 0 && decimals <= 36;
      if (!metadataAvailable) { decimals = 0; symbol = '原始单位（精度未知）'; }
      else { try { symbol = String(await c.symbol()).slice(0,32); } catch { symbol = 'TOKEN'; } }
    }
    return { sourceDeploymentId: source.id, targetDeploymentId: target.id, orderId: order.id, orderHash: order.orderHash,
      address: ta, token, balanceUnits: balance.toString(), decimals, symbol, metadataAvailable, payout: tc.payout, chainId: tc.chainId,
      factory: tc.factory, implementation: ti, deployer: tc.deployer, scheme: tc.scheme, recoveryOnly: true,
      supportedToken: tc.tokens.some(x => same(x.address, token)) };
  }
  async prepare(body) {
    const p = await this.preview(body);
    check(BigInt(p.balanceUnits) > 0n, 'RECOVERY_BALANCE_EMPTY', 409);
    const target = this.deployments.get(p.targetDeploymentId);
    return { ...await target.wallet.prepareRecovery(p, body.from), preview: p, deploymentId: p.targetDeploymentId };
  }
}
module.exports = { CrosschainRecovery };
