'use strict';
const crypto = require('node:crypto');
const { Chain, AppError, requireValue, address, ethers, transfer } = require('./chain.cjs');
const { publicJob } = require('./job-view.cjs');
const { recordNativePayment, SOURCE_PREFIX } = require('./epay.cjs');
class Merchant {
  constructor(store, options = {}) {
    this.store = store;
    this.options = { validateWebhook: options.validateWebhook, multiChain: !!options.multiChain, externalWallet: true };
    const config = store.get('config');
    this.chain = config ? new Chain(config, this.options) : null;
    this.busy = false; this.waiters = []; this.scanPromise = null;
    for (const job of store.jobs()) if (job.state === 'SUBMITTING') {
      job.state = 'UNKNOWN'; store.saveJob(job);
    }
  }
  async exclusive(fn) {
    if (this.busy) await new Promise((resolve, reject) => {
      requireValue(this.waiters.length < 8, 'BUSY_RETRY_LATER', 409);
      const waiter = { resolve: () => { clearTimeout(timer); resolve(); } };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter); if (index >= 0) this.waiters.splice(index, 1);
        reject(new AppError('BUSY_RETRY_LATER', 409));
      }, 15000);
      this.waiters.push(waiter);
    });
    else this.busy = true;
    try { return await fn(); } finally {
      const next = this.waiters.shift(); if (next) next.resolve(); else this.busy = false;
    }
  }
  async configure(body) {
    return this.exclusive(async () => {
      requireValue(!this.store.orders().length, 'CONFIG_LOCKED_BY_EXISTING_ORDERS', 409);
      let url;
      try { url = new URL(body.rpcUrl); } catch (error) { throw new AppError('INVALID_RPC_URL'); }
      requireValue(url.protocol === 'https:', 'RPC_HTTPS_REQUIRED');
      requireValue(!url.username && !url.password && !url.hash, 'RPC_CREDENTIALS_NOT_ALLOWED');
      const c = { rpcUrl: url.href, chainId: Number(body.chainId), factory: address(body.factory),
        payout: address(body.payout), startBlock: Number(body.startBlock ?? 0), confirmations: Number(body.confirmations ?? 2),
        ...(typeof body.name === 'string' ? { name: body.name.trim().slice(0, 100) } : {}),
        ...(typeof body.nativeSymbol === 'string' ? { nativeSymbol: body.nativeSymbol.trim().slice(0, 32) } : {}) };
      requireValue(Number.isSafeInteger(c.chainId) && c.chainId > 0, 'INVALID_CHAIN_ID');
      requireValue(Number.isSafeInteger(c.startBlock) && c.startBlock >= 0, 'INVALID_START_BLOCK');
      requireValue(Number.isSafeInteger(c.confirmations) && c.confirmations >= 1 && c.confirmations <= 256, 'INVALID_CONFIRMATIONS');
      c.scheme = body.scheme ?? 'legacy-v1';
      requireValue(['legacy-v1', 'deterministic-v2'].includes(c.scheme), 'INVALID_DEPLOYMENT_SCHEME');
      if (c.scheme === 'deterministic-v2') {
        c.name ||= 'Merchant';
        const verified = await require('./deployment-service.cjs').inspectDeployment({ ...body, ...c });
        c.deployer = verified.deployer;
      }
      const chain = new Chain(c, this.options);
      try {
        c.tokens = await chain.metadata();
        requireValue(c.startBlock <= await chain.head(), 'START_BLOCK_AHEAD_OF_CHAIN');
        chain.config = c;
      } catch (error) { chain.close(); throw error; }
      this.store.transaction(() => { this.store.set('config', c); this.store.rollbackAfter(c.startBlock - 1); });
      this.chain?.close(); this.chain = chain;
      return this.status();
    });
  }
  status() {
    const c = this.chain?.config;
    return { configured: !!c, busy: this.busy, config: c ? { ...c, rpcUrl: undefined, rpcOrigin: new URL(c.rpcUrl).origin } : null,
      cursor: this.store.get('cursor'), head: this.store.get('lastHead'), lastSync: this.store.get('lastSync'), syncError: this.store.get('syncError'),
      externalTransactionsEnabled: false,
      sendMode: 'CONNECTED_WALLET', gasWallet: null };
  }
  requireChain() { requireValue(this.chain, 'CHAIN_NOT_CONFIGURED', 409); return this.chain; }
  async create(body, { epay = false } = {}) {
    return this.exclusive(async () => {
      const chain = this.requireChain();
      requireValue(typeof body.reference === 'string' && body.reference.length > 0 && body.reference.length <= 128, 'INVALID_REFERENCE');
      const quote = body.reference.startsWith(SOURCE_PREFIX) ? this.store.epayReference(body.reference) : null;
      requireValue(epay || !quote, 'REFERENCE_RESERVED_BY_EPAY', 409);
      requireValue(!epay || quote && quote.token === body.token && quote.amount === body.amount && !body.webhookUrl
        && body.expiresInSeconds === undefined, 'EPAY_QUOTE_MISMATCH', 409);
      const token = chain.config.tokens.find(t => t.address === address(body.token));
      requireValue(token, 'UNSUPPORTED_TOKEN');
      requireValue(typeof body.amount === 'string' && /^(0|[1-9]\d*)(\.\d+)?$/.test(body.amount), 'AMOUNT_MUST_BE_DECIMAL_STRING');
      let units;
      try { units = ethers.parseUnits(body.amount, token.decimals); } catch { requireValue(false, 'INVALID_AMOUNT_PRECISION'); }
      requireValue(units > 0n && units <= ethers.MaxUint256, 'INVALID_AMOUNT');
      const ttl = body.expiresInSeconds ?? 1800;
      requireValue(Number.isInteger(ttl) && ttl >= 1 && ttl <= 604800, 'INVALID_EXPIRY');
      const previous = this.store.reference(body.reference);
      if (previous) {
        requireValue(!epay || quote.orderId === previous.id, 'EPAY_REFERENCE_CONFLICT', 409);
        requireValue(previous.token === token.address && previous.expectedUnits === units.toString()
          && previous.ttl === ttl && previous.webhookUrl === (body.webhookUrl || ''), 'REFERENCE_CONFLICT', 409);
        return previous;
      }
      if (body.webhookUrl) await this.options.validateWebhook(body.webhookUrl);
      await chain.identity();
      const id = crypto.randomUUID(), orderHash = ethers.id('upaynow:' + id);
      const o = { id, reference: body.reference, orderHash, publicToken: crypto.randomBytes(24).toString('base64url'),
        address: await chain.factory.predictAddress(orderHash), token: token.address, symbol: token.symbol, decimals: token.decimals,
        expectedAmount: ethers.formatUnits(units, token.decimals), expectedUnits: units.toString(),
        createdAt: Date.now(), createdBlock: await chain.head(), ttl, expiresAt: Date.now() + ttl * 1000,
        chainId: chain.config.chainId, factory: chain.config.factory, webhookUrl: body.webhookUrl || '',
        status: 'WAITING', paid: false, generation: 0, stateVersion: 0,
        receivedUnits: '0', confirmedUnits: '0', lateUnits: '0', otherTokens: [] };
      if (quote) {
        this.store.transaction(() => {
          requireValue(!quote.orderId, 'EPAY_REFERENCE_CONFLICT', 409);
          quote.orderId = id;
          this.store.saveOrder(o);
          this.store.saveEpay(quote);
        });
      } else {
        // A signed request can reserve its reference while native creation is awaiting the RPC.
        requireValue(!o.reference.startsWith(SOURCE_PREFIX) || !this.store.epayReference(o.reference),
          'REFERENCE_RESERVED_BY_EPAY', 409);
        this.store.saveOrder(o);
      }
      return o;
    });
  }
  recalculate(head, orders = this.store.orders()) {
    for (const o of orders) {
      const all = this.store.deposits(o.id);
      const selected = all.filter(d => d.token === o.token);
      const approved = new Set(o.latePaymentAcceptance?.depositIds || []);
      const eligible = selected.filter(d => d.timestamp * 1000 <= o.expiresAt || approved.has(d.eventId));
      const confirmed = eligible.filter(d => head - d.blockNumber + 1 >= this.chain.config.confirmations);
      const sum = entries => entries.reduce((n, d) => n + BigInt(d.amount), 0n);
      const total = sum(eligible), accepted = sum(confirmed), late = sum(selected) - total;
      o.lateReceivedUnits = sum(selected.filter(d => d.timestamp * 1000 > o.expiresAt)).toString();
      const expected = BigInt(o.expectedUnits), wasPaid = o.paid, oldStatus = o.status;
      o.receivedUnits = total.toString(); o.confirmedUnits = accepted.toString(); o.lateUnits = late.toString();
      o.otherTokens = [...new Set(all.filter(d => d.token !== o.token).map(d => d.token))];
      o.paid = accepted >= expected;
      o.status = o.paid ? (accepted > expected ? 'OVERPAID' : 'PAID')
        : total >= expected ? 'CONFIRMING'
          : late > 0n ? 'LATE_PAYMENT' : Date.now() > o.expiresAt ? 'EXPIRED'
            : total > 0n ? 'PARTIAL' : 'WAITING';
      if (o.status !== oldStatus || wasPaid !== o.paid) o.stateVersion++;
      if (!wasPaid && o.paid) o.generation++;
      this.store.saveOrder(o);
      if (wasPaid !== o.paid) recordNativePayment(this.store, o);
      if (wasPaid !== o.paid && o.webhookUrl) {
        const type = o.paid ? 'payment.paid' : 'payment.reversed';
        const id = `${o.id}:${o.generation}:${type}`;
        const payload = { id, type, orderId: o.id, reference: o.reference, paymentGeneration: o.generation, stateVersion: o.stateVersion,
          chainId: o.chainId, factory: o.factory, orderAddress: o.address, token: o.token,
          expectedUnits: o.expectedUnits, confirmedUnits: o.confirmedUnits, status: o.status,
          latePaymentAccepted: !!o.latePaymentAcceptance };
        this.store.notify({ id, orderId: o.id, url: o.webhookUrl, payload, state: 'PENDING', attempts: 0, nextAttempt: 0, queuedAt: Date.now() });
      }
    }
  }
  async acceptLatePayment(id) {
    requireValue(this.store.order(id), 'ORDER_NOT_FOUND', 404);
    await this.scan();
    return this.exclusive(async () => {
      const chain = this.requireChain(), head = this.store.get('lastHead', Infinity);
      requireValue(this.store.get('cursor') >= head && !this.store.get('syncError')
        && Date.now() - this.store.get('lastSync', 0) < 60000, 'SCAN_NOT_READY', 409);
      await chain.identity();
      const anchor = this.store.anchors()[0];
      requireValue(anchor && (await chain.block(anchor.number))?.hash === anchor.hash, 'SCAN_REORG_RETRY', 409);
      const order = this.store.order(id);
      requireValue(order, 'ORDER_NOT_FOUND', 404);
      if (order.latePaymentAcceptance) {
        requireValue(order.paid, 'PAYMENT_NO_LONGER_CONFIRMED', 409);
        return order;
      }
      if (order.paid) return order;
      requireValue(Date.now() > order.expiresAt, 'ORDER_NOT_EXPIRED', 409);
      const confirmed = this.store.deposits(id).filter(d => d.token === order.token
        && head - d.blockNumber + 1 >= chain.config.confirmations);
      const late = confirmed.filter(d => d.timestamp * 1000 > order.expiresAt);
      requireValue(late.length > 0, 'NO_CONFIRMED_LATE_PAYMENT', 409);
      const units = confirmed.reduce((n, d) => n + BigInt(d.amount), 0n);
      requireValue(units >= BigInt(order.expectedUnits), 'PAYMENT_NOT_FULLY_CONFIRMED', 409);
      this.store.transaction(() => {
        // Approve this confirmed ledger snapshot, never all future deposits.
        order.latePaymentAcceptance = { acceptedAt: Date.now(), blockNumber: head, blockHash: anchor.hash,
          depositIds: late.map(d => d.eventId), confirmedUnits: units.toString() };
        this.recalculate(head, [order]);
      });
      return order;
    });
  }
  scan() {
    const task = this.exclusive(async () => {
      const chain = this.requireChain();
      try {
        await chain.identity();
        const head = await chain.head(), anchors = this.store.anchors();
        if (anchors.length) {
          const newest = anchors[0];
          const block = newest.number <= head ? await chain.block(newest.number) : null;
          if (!block || block.hash !== newest.hash) {
            let common = null;
            for (const anchor of anchors) {
              if (anchor.number > head) continue;
              if ((await chain.block(anchor.number))?.hash === anchor.hash) { common = anchor.number; break; }
            }
            // Beyond the retained checkpoint window: fail closed, never guess away a paid order.
            requireValue(common !== null, 'DEEP_REORG_MANUAL_RESCAN_REQUIRED', 409);
            this.store.transaction(() => this.store.rollbackAfter(common));
          }
        }
        const previousAnchor = this.store.anchors()[0];
        const orders = this.store.orders();
        const byAddress = new Map(orders.map(o => [o.address.toLowerCase(), o]));
        const from = this.store.get('cursor', chain.config.startBlock - 1) + 1;
        const to = Math.min(head, from + 199);
        if (from <= to) {
          const logs = await chain.logs(from, to, orders), blocks = new Map(), deposits = [];
          for (const log of logs) {
            if (log.removed) continue;
            const event = transfer.parseLog(log), o = byAddress.get(event.args.to.toLowerCase());
            if (!o || event.args.value === 0n) continue;
            let block = blocks.get(log.blockNumber);
            if (!block) { block = await chain.block(log.blockNumber); blocks.set(log.blockNumber, block); }
            requireValue(block?.hash === log.blockHash, 'SCAN_REORG_RETRY', 409);
            deposits.push({ eventId: `${chain.config.chainId}:${log.transactionHash}:${log.index}`,
              orderId: o.id, token: address(log.address), from: event.args.from, amount: event.args.value.toString(),
              blockNumber: log.blockNumber, blockHash: log.blockHash, transactionHash: log.transactionHash,
              logIndex: log.index, timestamp: block.timestamp });
          }
          const checkpoint = await chain.block(to);
          requireValue(checkpoint, 'MISSING_CHECKPOINT');
          // Re-read the beginning of this window before committing a potentially reorged range.
          if (blocks.size) for (const block of blocks.values())
            requireValue((await chain.block(block.number))?.hash === block.hash, 'SCAN_REORG_RETRY', 409);
          if (previousAnchor) requireValue((await chain.block(previousAnchor.number))?.hash === previousAnchor.hash, 'SCAN_REORG_RETRY', 409);
          this.store.transaction(() => {
            for (const d of deposits) this.store.deposit(d);
            this.store.anchor(to, checkpoint.hash); this.store.set('cursor', to);
            if (to === head) this.recalculate(head);
          });
        } else this.store.transaction(() => this.recalculate(head));
        await this.refreshJobs();
        this.store.set('lastHead', head);
        if (this.store.get('cursor') >= head) this.store.set('lastSync', Date.now());
        this.store.set('syncError', null);
        return this.status();
      } catch (error) {
        this.store.set('syncError', error.code && typeof error.code === 'string' ? error.code.slice(0, 80) : 'CHAIN_RPC_ERROR');
        throw error;
      }
    });
    // Read-only previews can join scheduled work. Other callers still request
    // their own scan, preserving prepare/send freshness and lock ordering.
    const pending = task.finally(() => { if (this.scanPromise === pending) this.scanPromise = null; });
    this.scanPromise = pending;
    return pending;
  }
  async previewPaid() {
    const chain = this.requireChain(), pending = this.scanPromise;
    let minimumHead;
    if (pending) {
      // A scan may have sampled its head before this click. Join it, but never
      // treat that older snapshot as evidence that this request has caught up.
      const [state, head] = await Promise.all([pending, chain.head()]);
      minimumHead = head;
      if (state.cursor < head) await (this.scanPromise || this.scan());
    } else await this.scan();
    return this.exclusive(() => {
      requireValue(this.chain === chain && (minimumHead === undefined || this.store.get('cursor') >= minimumHead), 'SCAN_NOT_READY', 409);
      return this.paidPlan(undefined, true);
    });
  }
  collectionLocks(exceptId) {
    const locked = new Set();
    for (const j of this.store.jobs()) if (j.id !== exceptId && ['PREPARED', 'SUBMITTING', 'SUBMITTED', 'UNKNOWN'].includes(j.state)) {
      for (const id of j.orderIds || []) locked.add(id);
      for (const p of j.pairs || []) if (p.orderIdHash) locked.add(p.orderIdHash.toLowerCase());
    }
    return locked;
  }
  async paidPlan(orderIds, parallel = false) {
    const chain = this.requireChain();
    requireValue(this.store.get('cursor') >= this.store.get('lastHead', Infinity)
      && !this.store.get('syncError') && Date.now() - this.store.get('lastSync', 0) < 60000, 'SCAN_NOT_READY', 409);
    const locked = this.collectionLocks();
    await chain.identity();
    const anchor = this.store.anchors()[0];
    requireValue(anchor && (await chain.block(anchor.number))?.hash === anchor.hash, 'SCAN_REORG_RETRY', 409);
    const requested = orderIds && new Set(orderIds);
    const scoped = this.store.orders().filter(o => !requested || requested.has(o.id));
    const isHeld = o => locked.has(o.id) || locked.has(o.orderHash?.toLowerCase());
    const heldCount = scoped.filter(o => isHeld(o) && (requested || o.paid)).length;
    const orders = scoped.filter(o => !isHeld(o) && o.paid && BigInt(o.confirmedUnits) >= BigInt(o.expectedUnits));
    const entries = [], width = parallel ? 4 : 1;
    for (let i = 0; i < orders.length; i += width) {
      const results = await Promise.allSettled(orders.slice(i, i + width).map(async o => {
        const balance = await chain.balance(o.token, o.address, 'latest');
        return balance === 0n ? null : { id: o.id, reference: o.reference, token: o.token, symbol: o.symbol,
          balance: ethers.formatUnits(balance, o.decimals), expectedAmount: o.expectedAmount };
      }));
      // Drain the whole bounded batch before releasing the submission lock.
      // A failed read is an error, never a zero balance or partial success.
      const failed = results.find(r => r.status === 'rejected');
      if (failed) throw failed.reason;
      entries.push(...results.map(r => r.value).filter(Boolean));
    }
    return { policy: 'CONFIRMED_PAID', chainId: chain.config.chainId, payout: chain.config.payout, entries, heldCount };
  }
  // Retained method names reject old clients; only wallet prepare/begin/attach can submit intent.
  async collectPaid() { throw new AppError('CONNECTED_WALLET_REQUIRED', 409); }
  async collect() { throw new AppError('CONNECTED_WALLET_REQUIRED', 409); }
  async submitCollection() { throw new AppError('CONNECTED_WALLET_REQUIRED', 409); }
  matchesTransaction(job, tx) {
    const same = !!tx && tx.to === (job.factory || this.chain.config.factory) && tx.from === job.from && tx.data === job.data
      && tx.value === 0n && Number(tx.chainId) === (job.chainId || this.chain.config.chainId);
    if (!same) return false;
    if (job.txHash && job.txHash.toLowerCase() !== tx.hash?.toLowerCase()) return false;
    if (!job.externalWallet || job.intentVersion !== 2) return tx.nonce === job.nonce;
    if (!Number.isSafeInteger(job.dispatchBlock)) return false;
    if (tx.blockNumber !== null && tx.blockNumber !== undefined && tx.blockNumber <= job.dispatchBlock) return false;
    return !this.store.jobs().some(other => other.id !== job.id && other.txHash?.toLowerCase() === tx.hash?.toLowerCase());
  }
  async observeExternalTransactions() {
    const jobs = this.store.jobs().filter(j => !j.manualResolution && j.externalWallet && j.intentVersion === 2 && Number.isSafeInteger(j.dispatchBlock)
      && !j.observationEnded && ['UNKNOWN', 'SUBMITTED', 'CANCELLED', 'ABANDONED'].includes(j.state));
    if (!jobs.length) return;
    const head = await this.chain.head(), blocks = new Map();
    for (const original of jobs) {
      let job = this.store.job(original.id);
      const until = Math.min(head, job.watchUntilBlock ?? head);
      const from = Math.max(job.dispatchBlock + 1, (job.observationCursor ?? job.dispatchBlock) - 5);
      const to = Math.min(until, from + 31);
      if (from > to) continue;
      for (let height = from; height <= to; height++) {
        if (!blocks.has(height)) blocks.set(height, await this.chain.provider.getBlock(height, true));
        if (this.store.job(job.id)?.manualResolution) break;
        const block = blocks.get(height); requireValue(block, 'MISSING_CHECKPOINT', 409);
        let resolved = false;
        for (const tx of block.prefetchedTransactions) {
          if (this.matchesTransaction(job, tx)) {
            // Identical late transactions may fit several attempts; require explicit hash registration instead of guessing.
            const candidates = this.store.jobs().filter(j => !j.manualResolution && j.externalWallet && j.intentVersion === 2 && this.matchesTransaction(j, tx));
            if (candidates.length !== 1) continue;
            job.txHash = tx.hash; job.nonce = tx.nonce; job.state = 'SUBMITTED'; job.error = null;
            job.history ||= []; job.history.push({ type: 'CHAIN_OBSERVED', at: Date.now(), hash: tx.hash, nonce: tx.nonce });
            this.store.saveJob(job); resolved = true; break;
          }
          if (job.txHash && Number.isSafeInteger(job.nonce) && tx.from === job.from && tx.nonce === job.nonce
            && tx.hash.toLowerCase() !== job.txHash.toLowerCase() && head - height + 1 >= this.chain.config.confirmations) {
            const receipt = await this.chain.provider.getTransactionReceipt(tx.hash);
            if (this.store.job(job.id)?.manualResolution) break;
            if (receipt?.blockHash === block.hash) {
              job.state = 'REPLACED'; job.error = 'TRANSACTION_REPLACED'; job.replacementHash = tx.hash;
              job.history ||= []; job.history.push({ type: 'CANONICAL_REPLACEMENT', at: Date.now(), hash: tx.hash });
              this.store.saveJob(job); resolved = true; break;
            }
          }
        }
        job.observationCursor = height; this.store.saveJob(job);
        if (job.watchUntilBlock && height >= job.watchUntilBlock) { job.observationEnded = true; this.store.saveJob(job); }
        if (resolved) break;
      }
    }
  }
  async refreshJobs() {
    let recoveryBindingsVerified = false;
    let observedHead;
    await this.observeExternalTransactions();
    for (const job of this.store.jobs()) {
      if (job.manualResolution) continue;
      if (job.externalWallet && job.state === 'PREPARED' && Date.now() >= job.expiresAt) {
        job.state = 'EXPIRED'; this.store.saveJob(job); continue;
      }
      if (job.externalWallet && job.candidateHash && !job.txHash) {
        const tx = await this.chain.provider.getTransaction(job.candidateHash);
        if (!tx) continue;
        if (!this.matchesTransaction(job, tx)) {
          job.error = 'TRANSACTION_DOES_NOT_MATCH_JOB'; job.candidateHash = null; this.store.saveJob(job); continue;
        }
        job.txHash = tx.hash; job.nonce = tx.nonce; job.state = 'SUBMITTED'; job.error = null; this.store.saveJob(job);
      }
      if (job.state === 'REPLACED' && job.replacementHash) {
        const replacement = await this.chain.provider.getTransactionReceipt(job.replacementHash);
        if (replacement) observedHead ??= await this.chain.head();
        if (!replacement || (await this.chain.block(replacement.blockNumber))?.hash !== replacement.blockHash
          || observedHead - replacement.blockNumber + 1 < this.chain.config.confirmations) {
          job.state = 'UNKNOWN'; job.error = 'REPLACEMENT_REORGED'; delete job.replacementHash; this.store.saveJob(job);
        } else continue;
      }
      if (!job.txHash || !['SUBMITTED', 'UNKNOWN', 'MINED'].includes(job.state)) continue;
      const receipt = await this.chain.provider.getTransactionReceipt(job.txHash);
      if (this.store.job(job.id)?.manualResolution) continue;
      if (!receipt) {
        if (job.state === 'MINED') { job.state = 'UNKNOWN'; job.outcome = null; job.error = 'RECEIPT_REORGED'; this.store.saveJob(job); }
        continue;
      }
      const canonical = await this.chain.block(receipt.blockNumber);
      if (canonical?.hash !== receipt.blockHash) {
        job.state = 'UNKNOWN'; job.outcome = null; job.error = 'RECEIPT_REORGED'; this.store.saveJob(job);
        continue;
      }
      observedHead ??= await this.chain.head();
      if (observedHead - receipt.blockNumber + 1 < this.chain.config.confirmations) {
        const nextError = job.state === 'MINED' || job.error === 'CONFIRMATIONS_REORGED' ? 'CONFIRMATIONS_REORGED' : 'AWAITING_COLLECTION_CONFIRMATIONS';
        if (job.state !== 'SUBMITTED' || job.error !== nextError) {
          job.state = 'SUBMITTED'; job.outcome = null; job.error = nextError; this.store.saveJob(job);
        }
        continue;
      }
      // A receipt is not evidence for this job merely because it exists. Match the
      // canonical hash, sender, Factory, calldata, value and chain before settling.
      if (receipt.hash?.toLowerCase() !== job.txHash.toLowerCase() || receipt.from !== job.from
        || receipt.to !== (job.factory || this.chain.config.factory) || receipt.status !== 0 && receipt.status !== 1) continue;
      const verified = job.receiptVerification;
      if (job.state === 'MINED' && verified?.txHash === receipt.hash && verified.blockHash === receipt.blockHash
        && verified.status === receipt.status) continue;
      const tx = await this.chain.provider.getTransaction(job.txHash);
      if (!this.matchesTransaction(job, tx) || tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber) continue;
      const events = this.chain.parse(receipt);
      const successEvent = job.wrongToken !== null && job.wrongToken !== undefined ? 'WrongTokenCollected' : 'Collected';
      const outcomes = (job.pairs || []).map(pair => events.filter(e => e.orderHash?.toLowerCase() === pair.orderIdHash.toLowerCase()
        && e.token?.toLowerCase() === pair.token.toLowerCase()
        && (e.name === 'CollectFailed' || e.name === successEvent && BigInt(e.amount ?? 0) > 0n)));
      // The immutable Factory deliberately emits no result for a zero-amount
      // sweep. For a verified canonical call, this is a no-op, not a transfer.
      const handled = outcomes.flat();
      if (receipt.status === 1 && outcomes.some(matches => matches.length > 1)) continue;
      // Handle orphaned receipts before inspecting code: a deep reorg may have
      // removed the Factory too. Unchanged final receipts need no full ABI and
      // metadata inspection on every poll; these contracts cannot change code.
      if (job.recoveryOnly && (job.state !== 'MINED' || job.blockHash !== receipt.blockHash) && !recoveryBindingsVerified) {
        await require('./deployment-service.cjs').inspectDeployment(this.chain.config);
        recoveryBindingsVerified = true;
      }
      job.state = 'MINED'; job.blockNumber = receipt.blockNumber; job.blockHash = receipt.blockHash;
      job.receiptVerification = { txHash: receipt.hash, blockHash: receipt.blockHash, status: receipt.status };
      job.events = events; job.error = null;
      // Older completed jobs may lack pair metadata. Preserve their previous
      // interpretation; a new job always records pairs before dispatch.
      const recorded = outcomes.length ? handled : events;
      job.outcome = receipt.status === 0 ? 'REVERTED' : recorded.some(e => e.name === 'CollectFailed') ? 'PARTIAL_FAILURE'
        : !recorded.some(e => e.name === successEvent) ? 'NO_BALANCE'
          : outcomes.some(matches => matches.length === 0) ? 'PARTIAL_SUCCESS' : 'SUCCESS';
      this.store.saveJob(job);
    }
  }
  async reconcile(id, hash) {
    return this.exclusive(async () => {
      const job = this.store.job(id); requireValue(job, 'JOB_NOT_FOUND', 404);
      requireValue(/^0x[0-9a-fA-F]{64}$/.test(hash), 'INVALID_TRANSACTION_HASH');
      const tx = await this.requireChain().provider.getTransaction(hash);
      requireValue(!job.txHash || job.txHash.toLowerCase() === hash.toLowerCase(), 'TRANSACTION_ALREADY_ATTACHED', 409);
      requireValue(this.matchesTransaction(job, tx), 'TRANSACTION_DOES_NOT_MATCH_JOB');
      job.nonce = tx.nonce;
      job.txHash = hash; job.state = 'SUBMITTED'; this.store.saveJob(job);
      await this.refreshJobs(); return this.store.job(id);
    });
  }
  detail(o, publicView = false) {
    const deposits = this.store.deposits(o.id);
    const common = { status: o.status, paid: o.paid, address: o.address, token: o.token, symbol: o.symbol,
      chainId: o.chainId, factory: o.factory, payout: this.chain.config.payout, expectedAmount: o.expectedAmount, decimals: o.decimals, expiresAt: o.expiresAt,
      receivedAmount: ethers.formatUnits(o.receivedUnits, o.decimals),
      confirmedAmount: ethers.formatUnits(o.confirmedUnits, o.decimals),
      lateAmount: ethers.formatUnits(o.lateUnits, o.decimals),
      lateReceivedAmount: ethers.formatUnits(o.lateReceivedUnits ?? o.lateUnits, o.decimals),
      latePaymentAccepted: !!o.latePaymentAcceptance, otherTokens: o.otherTokens,
      syncHealthy: !!this.store.get('lastSync') && !this.store.get('syncError')
        && this.store.get('cursor') >= this.store.get('lastHead', Infinity)
        && Date.now() - this.store.get('lastSync') < 60000 };
    if (publicView) return common;
    return { ...o, ...common, deposits, collectionJobs: this.store.jobs().filter(j => j.orderIds.includes(o.id)).map(publicJob),
      checkoutPath: '/pay/' + o.publicToken };
  }
  close() { this.chain?.close(); }
}
module.exports = { Merchant };
