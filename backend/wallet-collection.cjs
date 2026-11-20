'use strict';
const crypto = require('node:crypto');
const { requireValue, address, ethers } = require('./chain.cjs');
const { publicJob, review } = require('./job-view.cjs');
class WalletCollection {
  constructor(merchant, defaults = merchant.store) { this.merchant = merchant; this.store = merchant.store; this.defaults = defaults; }
  chain() {
    requireValue(this.merchant.options.externalWallet, 'CONNECTED_WALLET_MODE_DISABLED', 409);
    const chain = this.merchant.requireChain();
    return chain;
  }
  config() {
    requireValue(this.merchant.options.externalWallet, 'CONNECTED_WALLET_MODE_DISABLED', 409);
    const c = this.merchant.chain?.config;
    const projectId = this.store.get('walletConnectProjectId', this.defaults.get('walletConnectProjectId', process.env.UPAY_WALLETCONNECT_PROJECT_ID || ''));
    return { enabled: !!c, projectId: /^[a-fA-F0-9]{32}$/.test(projectId) ? projectId : '', chainId: c?.chainId ?? null,
      rpcUrl: c?.rpcUrl ?? null, factory: c?.factory ?? null, payout: c?.payout ?? null, verifiedDeployment: !!c && this.merchant.options.multiChain === true,
      chainName: c ? c.name || 'Chain ' + c.chainId : null,
      nativeSymbol: c ? c.nativeSymbol || (Number(c.chainId) === 56 ? 'BNB' : 'ETH') : null };
  }
  saveConfig(body) {
    requireValue(this.merchant.options.externalWallet, 'CONNECTED_WALLET_MODE_DISABLED', 409);
    requireValue(typeof body.projectId === 'string' && (body.projectId === '' || /^[a-fA-F0-9]{32}$/.test(body.projectId)), 'INVALID_WALLETCONNECT_PROJECT_ID');
    this.store.set('walletConnectProjectId', body.projectId); return this.config();
  }
  expire() {
    for (const job of this.store.jobs()) if (job.externalWallet && job.state === 'PREPARED' && Date.now() >= job.expiresAt) {
      job.state = 'EXPIRED'; this.store.saveJob(job);
    }
  }
  assertAvailable(ids, hashes = [], exceptId) {
    const locked = this.merchant.collectionLocks(exceptId);
    const keys = [...ids, ...hashes.map(h => h.toLowerCase()), ...ids.map(id => this.store.order(id)?.orderHash?.toLowerCase())];
    requireValue(!keys.some(k => locked.has(k)), 'TRANSACTION_RECONCILIATION_REQUIRED', 409);
  }
  async prepare(body, onPrepared) {
    const chain = this.chain();
    requireValue(['paid', 'manual'].includes(body.mode), 'INVALID_COLLECTION_MODE');
    requireValue(Array.isArray(body.orderIds) && body.orderIds.length > 0 && body.orderIds.every(id => typeof id === 'string'), 'ORDER_IDS_REQUIRED');
    requireValue(new Set(body.orderIds).size === body.orderIds.length, 'DUPLICATE_ORDER_IDS');
    requireValue(body.mode !== 'paid' || body.token === undefined && body.wrongToken === undefined, 'PAID_COLLECTION_TOKEN_OVERRIDE_FORBIDDEN');
    requireValue(body.wrongToken === undefined || body.confirmWrongToken === true, 'WRONG_TOKEN_CONFIRMATION_REQUIRED');
    const from = address(body.from);
    await this.merchant.scan();
    return this.merchant.exclusive(async () => {
      this.expire();
      await chain.identity();
      const plan = body.mode === 'paid' ? await this.merchant.paidPlan(body.orderIds) : null;
      const ids = plan ? plan.entries.map(o => o.id) : body.orderIds;
      const result = plan ? { ...plan, skipped: body.orderIds.length - ids.length } : {};
      if (!ids.length) return { ...result, job: null, summary: null };
      this.assertAvailable(ids);
      requireValue(await chain.provider.getBalance(from) > 0n, 'CONNECTED_WALLET_NEEDS_GAS', 409);
      const { request, pairs } = await chain.encodeCollection(ids, this.store.orders(), body.wrongToken, body.token);
      const gas = await chain.provider.estimateGas({ ...request, from, value: 0n });
      // The wallet chooses the actual nonce. No predicted nonce is sent or used as an identity gate.
      const transaction = { from, to: chain.config.factory, data: request.data, value: '0x0',
        chainId: ethers.toQuantity(chain.config.chainId), gas: ethers.toQuantity(gas * 120n / 100n) };
      const job = { id: crypto.randomUUID(), externalWallet: true, intentVersion: 2, state: 'PREPARED',
        createdAt: Date.now(), expiresAt: Date.now() + 300000, chainId: chain.config.chainId, factory: chain.config.factory,
        orderIds: ids, wrongToken: body.wrongToken ?? null, pairs, from, data: request.data, transaction,
        txHash: null, events: [], history: [] };
      this.store.transaction(() => { if (onPrepared) onPrepared(job); this.store.saveJob(job); });
      return { ...result, job: publicJob(job), summary: review(job) };
    });
  }
  async prepareRecovery(preview, sender) {
    const chain = this.chain(), from = address(sender);
    requireValue(from === chain.config.payout, 'PAYOUT_WALLET_REQUIRED', 409);
    return this.merchant.exclusive(async () => {
      this.expire();
      this.assertAvailable([], [preview.orderHash]);
      await chain.identity();
      requireValue(preview.chainId === chain.config.chainId && preview.factory === chain.config.factory, 'RECOVERY_SCOPE_MISMATCH', 409);
      requireValue(await chain.provider.getBalance(from) > 0n, 'CONNECTED_WALLET_NEEDS_GAS', 409);
      const virtual = { id: crypto.randomUUID(), orderHash: preview.orderHash, address: preview.address, token: preview.token, recoveryOnly: true };
      const wrongToken = preview.supportedToken ? undefined : preview.token;
      const { request, pairs } = await chain.encodeCollection([virtual.id], [virtual], wrongToken, preview.supportedToken ? preview.token : undefined);
      const gas = await chain.provider.estimateGas({ ...request, from, value: 0n });
      const transaction = { from, to: chain.config.factory, data: request.data, value: '0x0', chainId: ethers.toQuantity(chain.config.chainId), gas: ethers.toQuantity(gas * 120n / 100n) };
      const job = { id: crypto.randomUUID(), externalWallet: true, intentVersion: 2, state: 'PREPARED', recoveryOnly: true,
        recovery: preview, createdAt: Date.now(), expiresAt: Date.now() + 300000, chainId: chain.config.chainId,
        factory: chain.config.factory, orderIds: [virtual.id], wrongToken: wrongToken ?? null, pairs, from,
        data: request.data, transaction, txHash: null, events: [], history: [] };
      this.store.transaction(() => {
        // Recovery pseudo-orders NEVER enter the orders/deposits tables or scanners/webhooks.
        this.store.set('crosschain-recovery.order:' + job.id, virtual);
        this.store.saveJob(job);
      });
      return { job: publicJob(job), summary: review(job) };
    });
  }
  job(id) {
    const job = this.store.job(id);
    requireValue(job?.externalWallet, 'WALLET_JOB_NOT_FOUND', 404); return job;
  }
  async begin(id, beforeBegin) {
    return this.merchant.exclusive(async () => {
      const chain = this.chain(); this.expire(); const job = this.job(id);
      requireValue(job.state === 'PREPARED', 'WALLET_JOB_NOT_PREPARED', 409);
      if (job.recoveryOnly) await require('./deployment-service.cjs').inspectDeployment(chain.config);
      await chain.identity();
      const block = await chain.block(await chain.head());
      requireValue(block, 'MISSING_CHECKPOINT', 409);
      if (typeof beforeBegin === 'function') beforeBegin(job);
      // A canonical start boundary prevents crediting old identical transactions to this attempt.
      job.dispatchBlock = block.number; job.dispatchBlockHash = block.hash; job.observationCursor = block.number;
      job.state = 'UNKNOWN'; job.error = 'WALLET_CONFIRMATION_PENDING'; job.begunAt = Date.now();
      job.history ||= []; job.history.push({ type: 'DISPATCHED', at: Date.now() });
      this.store.saveJob(job);
      return { job: publicJob(job), transaction: job.transaction };
    });
  }
  // Explicit mobile action only: resume the same approved batch, never create a second job.
  async retry(id, beforeRetry) {
    return this.merchant.exclusive(async () => {
      const chain = this.chain();
      await chain.identity();
      await this.merchant.refreshJobs();
      const job = this.job(id);
      if (typeof beforeRetry === 'function') beforeRetry(job);
      if (job.txHash || job.candidateHash || ['SUBMITTED', 'MINED'].includes(job.state))
        return { job: publicJob(job), transaction: null };
      requireValue(job.handoffId && (job.state === 'UNKNOWN' && job.error === 'WALLET_CONFIRMATION_PENDING'
        || job.state === 'CANCELLED' && job.error === 'USER_REJECTED'), 'WALLET_RETRY_UNAVAILABLE', 409);
      this.assertAvailable(job.orderIds, (job.pairs || []).map(p => p.orderIdHash), job.id);
      requireValue(job.chainId === chain.config.chainId && job.factory === chain.config.factory, 'HANDOFF_SCOPE_CHANGED', 409);
      const gas = await chain.provider.estimateGas({ from: job.from, to: job.factory, data: job.data, value: 0n });
      if (typeof beforeRetry === 'function') beforeRetry(job);
      job.transaction.gas = ethers.toQuantity(gas * 120n / 100n);
      job.walletRequestRevision = (job.walletRequestRevision || 0) + 1;
      job.state = 'UNKNOWN'; job.error = 'WALLET_CONFIRMATION_PENDING';
      // Keep the original dispatch checkpoint and identity, including observation of late original sends.
      delete job.watchUntilBlock; delete job.observationEnded;
      job.history ||= []; job.history.push({ type: 'CLIENT_REQUESTED_WALLET_RETRY', at: Date.now(), revision: job.walletRequestRevision });
      this.store.saveJob(job);
      return { job: publicJob(job), transaction: job.transaction };
    });
  }
  async attach(id, body) {
    return this.merchant.exclusive(async () => {
      this.chain(); const job = this.job(id);
      requireValue(['UNKNOWN', 'SUBMITTED', 'MINED'].includes(job.state), 'WALLET_JOB_NOT_STARTED', 409);
      requireValue(typeof body.transactionHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(body.transactionHash), 'INVALID_TRANSACTION_HASH');
      if (body.requestRevision !== undefined) {
        requireValue(job.handoffId && Number.isSafeInteger(body.requestRevision) && body.requestRevision >= 0
          && body.requestRevision <= (job.walletRequestRevision || 0), 'INVALID_WALLET_REQUEST_REVISION');
        job.history ||= [];
        if (!job.history.some(h => h.type === 'CLIENT_REPORTED_WALLET_HASH' && h.hash === body.transactionHash)) {
          job.history.push({ type: 'CLIENT_REPORTED_WALLET_HASH', at: Date.now(), revision: body.requestRevision,
            hash: body.transactionHash, verified: false });
          this.store.saveJob(job);
        }
        // A late second response is retained for audit; it must not replace the transaction being verified.
        const known = job.txHash || job.candidateHash;
        if (known && known.toLowerCase() !== body.transactionHash.toLowerCase()) return publicJob(job);
      }
      requireValue(!job.txHash || job.txHash.toLowerCase() === body.transactionHash.toLowerCase(), 'TRANSACTION_DOES_NOT_MATCH_JOB', 409);
      job.candidateHash = body.transactionHash; this.store.saveJob(job);
      await this.merchant.refreshJobs(); return publicJob(this.store.job(id));
    });
  }
  async refresh(id) {
    return this.merchant.exclusive(async () => {
      await this.chain().identity(); this.job(id);
      await this.merchant.refreshJobs(); return publicJob(this.store.job(id));
    });
  }
  async cancel(id, body, beforeCancel) {
    return this.merchant.exclusive(async () => {
      const chain = this.chain(), job = this.job(id);
      const rejected = job.state === 'UNKNOWN' && job.error === 'WALLET_CONFIRMATION_PENDING' && body.rejected === true;
      requireValue(job.state === 'PREPARED' || rejected, 'UNCERTAIN_TRANSACTION_CANNOT_CANCEL', 409);
      requireValue(!job.txHash && !job.candidateHash, 'UNCERTAIN_TRANSACTION_CANNOT_CANCEL', 409);
      if (rejected) {
        // This records a client's explicit rejection assertion, NOT proof of non-broadcast.
        job.watchUntilBlock = await chain.head() + 64;
        job.rejectionReportedAt = Date.now();
        job.history ||= []; job.history.push({ type: 'CLIENT_REPORTED_REJECTION', at: Date.now(), proofOfNonBroadcast: false });
      }
      if (typeof beforeCancel === 'function') beforeCancel(job);
      job.state = 'CANCELLED'; job.error = rejected ? 'USER_REJECTED' : null;
      this.store.saveJob(job); return publicJob(job);
    });
  }
  async resolve(id, body) {
    return this.merchant.exclusive(async () => {
      this.chain();
      requireValue(body.acknowledge === true && typeof body.note === 'string' && body.note.trim().length >= 4 && body.note.length <= 500,
        'EXPLICIT_RISK_ACKNOWLEDGEMENT_REQUIRED', 400);
      const result = body.result || 'UNRESOLVED';
      requireValue(['SUCCESS', 'FAILED', 'UNRESOLVED'].includes(result), 'INVALID_MANUAL_RESOLUTION', 400);
      const job = this.job(id);
      if (job.state === 'MINED') return publicJob(job);
      requireValue(body.expectedState === undefined || body.expectedState === job.state, 'WALLET_JOB_STATE_CHANGED', 409);
      requireValue(['UNKNOWN', 'SUBMITTED'].includes(job.state) || job.state === 'ABANDONED' && job.manualResolution, 'WALLET_JOB_NOT_UNCERTAIN', 409);
      const resolution = { result, note: body.note.trim(), at: Date.now(), previousState: job.state, hash: job.txHash || job.candidateHash || null, verifiedOnChain: false };
      job.manualResolution = resolution;
      job.state = 'ABANDONED'; job.error = 'ADMIN_MANUALLY_RESOLVED'; job.resolvedAt = resolution.at;
      job.observationEnded = true; delete job.watchUntilBlock;
      job.history ||= []; job.history.push({ type: 'ADMIN_MANUAL_RESOLUTION', ...resolution });
      this.store.saveJob(job); return publicJob(job);
    });
  }
}
module.exports = { WalletCollection };
