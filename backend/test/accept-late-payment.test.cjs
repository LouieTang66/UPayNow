'use strict';
const { apiKey } = require('./helpers/auth.cjs');
// Real HTTP + temporary SQLite; ledger/RPC doubles are confined to this fixture.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { start } = require('../server.cjs');
const { AppError } = require('../chain.cjs');

test('merchant-only late-payment acceptance, persistence and fail-closed accounting', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upaynow-accept-late-'));
  const token = '0x0000000000000000000000000000000000000001';
  const other = '0x0000000000000000000000000000000000000002';
  let app, secret, height = 100, accepted;
  const chain = {
    config: { chainId: 31337, factory: '0x0000000000000000000000000000000000000003',
      payout: '0x0000000000000000000000000000000000000004', rpcUrl: 'https://rpc.invalid', confirmations: 2, startBlock: 0 },
    async identity() {}, async head() { return height; },
    async block(number) { return { number, hash: 'hash-' + number }; }, async logs() { return []; }, close() {},
  };
  const open = async () => {
    app = await start({ dir, port: 0, pollMs: 0, externalWallet: true });
    app.merchant.chain = chain;
    secret = apiKey(dir);
    app.store.set('cursor', height); app.store.set('lastHead', height); app.store.set('lastSync', Date.now());
    app.store.anchor(height, 'hash-' + height);
  };
  const api = async (route, input, status = 200, extra = {}) => {
    const response = await fetch(app.url + '/api/' + route, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + secret, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data;
  };
  const seed = ({ onTime = '0', late = '1000000', wrong = '0', block = 90, expired = true, hook = false } = {}) => {
    const id = crypto.randomUUID(), expiresAt = Date.now() + (expired ? -60000 : 60000);
    const order = { id, reference: id, publicToken: crypto.randomBytes(24).toString('base64url'),
      address: '0x' + crypto.randomBytes(20).toString('hex'), token, symbol: 'TEST', decimals: 6,
      chainId: 31337, factory: chain.config.factory, expectedAmount: '1.0', expectedUnits: '1000000',
      createdAt: expiresAt - 60000, createdBlock: 1, expiresAt, ttl: 60, webhookUrl: hook ? 'https://merchant.invalid/paid' : '',
      status: 'WAITING', paid: false, generation: 0, stateVersion: 0,
      receivedUnits: '0', confirmedUnits: '0', lateUnits: '0', otherTokens: [] };
    app.store.saveOrder(order);
    for (const [amount, ca, timestamp] of [[onTime, token, Math.floor(expiresAt / 1000) - 1],
      [late, token, Math.floor(expiresAt / 1000) + 1], [wrong, other, Math.floor(expiresAt / 1000) + 1]]) {
      if (amount === '0') continue;
      app.store.deposit({ eventId: crypto.randomUUID(), orderId: id, token: ca, amount, blockNumber: block,
        timestamp, blockHash: 'hash-' + block, transactionHash: '0x' + crypto.randomBytes(32).toString('hex') });
    }
    return order;
  };
  const accept = (o, status = 200, input = {}) => api('orders/' + o.id + '/accept-late-payment', input, status);
  const notices = id => app.store.notifications().filter(n => n.orderId === id);
  try {
    await open();
    await t.test('requires merchant authentication, deployment scope and an empty body', async () => {
      const order = seed();
      const response = await fetch(app.url + '/api/orders/' + order.id + '/accept-late-payment', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 401);
      assert.equal((await accept(order, 400, { paid: true })).error, 'ACCEPT_LATE_PAYMENT_BODY_MUST_BE_EMPTY');
      assert.equal((await api('orders/' + order.id + '/accept-late-payment', {}, 404,
        { 'X-Upay-Deployment': crypto.randomUUID() })).error, 'DEPLOYMENT_NOT_FOUND');
      assert.equal((await accept({ id: crypto.randomUUID() }, 404)).error, 'ORDER_NOT_FOUND');
      assert.equal(app.store.order(order.id).latePaymentAcceptance, undefined);
    });
    await t.test('accepts on-time partial plus confirmed late remainder; concurrent retries queue one event', async () => {
      const order = seed({ onTime: '400000', late: '600000', hook: true });
      const responses = await Promise.all([accept(order), accept(order)]);
      accepted = responses[0];
      assert.equal(accepted.status, 'PAID'); assert.equal(accepted.paid, true); assert.equal(accepted.syncHealthy, true);
      assert.equal(accepted.confirmedAmount, '1.0'); assert.equal(accepted.lateAmount, '0.0');
      assert.equal(accepted.lateReceivedAmount, '0.6'); assert.equal(accepted.latePaymentAccepted, true);
      assert.equal(accepted.expiresAt, order.expiresAt); assert.equal(accepted.generation, 1);
      assert.deepEqual(responses[1].latePaymentAcceptance, accepted.latePaymentAcceptance);
      assert.equal(notices(order.id).length, 1); assert.equal(notices(order.id)[0].payload.type, 'payment.paid');
      assert.equal(notices(order.id)[0].payload.latePaymentAccepted, true);
    });
    await t.test('wrong-token funds cannot fill a shortfall and insufficient payments remain unaccepted', async () => {
      const short = seed({ late: '400000', wrong: '600000' });
      assert.equal((await accept(short, 409)).error, 'PAYMENT_NOT_FULLY_CONFIRMED');
      const wrongOnly = seed({ late: '0', wrong: '1000000' });
      assert.equal((await accept(wrongOnly, 409)).error, 'NO_CONFIRMED_LATE_PAYMENT');
      assert.equal(app.store.order(short.id).paid, false); assert.equal(app.store.order(short.id).latePaymentAcceptance, undefined);
    });
    await t.test('unconfirmed late transfers stay blocked until the configured confirmation depth', async () => {
      const order = seed({ block: height });
      assert.equal((await accept(order, 409)).error, 'NO_CONFIRMED_LATE_PAYMENT');
      height++; const result = await accept(order);
      assert.equal(result.paid, true); assert.equal(result.latePaymentAcceptance.depositIds.length, 1);
    });
    await t.test('unexpired invoices cannot be approved and already-paid orders are not notified twice', async () => {
      assert.equal((await accept(seed({ late: '0', expired: false }), 409)).error, 'ORDER_NOT_EXPIRED');
      const order = seed({ onTime: '1000000', late: '0', hook: true });
      const result = await accept(order);
      assert.equal(result.paid, true); assert.equal(result.latePaymentAccepted, false); assert.equal(notices(order.id).length, 1);
    });
    await t.test('approval survives SQLite reopen and retry preserves its original identity and notification', async () => {
      const previousSecret = secret;
      await app.close(); app = null; await open();
      assert.equal(secret, previousSecret);
      const result = await accept(accepted);
      assert.equal(result.paid, true); assert.deepEqual(result.latePaymentAcceptance, accepted.latePaymentAcceptance);
      assert.equal(result.generation, 1); assert.equal(notices(accepted.id).length, 1);
      const publicView = await fetch(app.url + '/api/pay/' + result.publicToken).then(r => r.json());
      assert.equal(publicView.paid, true); assert.equal(publicView.latePaymentAccepted, true);
    });
    await t.test('approval cannot mask a reorg or automatically authorize different future transfers', async () => {
      app.store.db.prepare('DELETE FROM deposits WHERE order_id=?').run(accepted.id);
      app.store.deposit({ eventId: crypto.randomUUID(), orderId: accepted.id, token, amount: '1000000',
        blockNumber: 90, timestamp: Math.floor(accepted.expiresAt / 1000) + 2 });
      assert.equal((await accept(accepted, 409)).error, 'PAYMENT_NO_LONGER_CONFIRMED');
      const order = app.store.order(accepted.id);
      assert.equal(order.paid, false); assert.equal(order.status, 'LATE_PAYMENT');
      assert.equal(notices(order.id).filter(n => n.payload.type === 'payment.reversed').length, 1);
    });
    await t.test('order approval and payment notification roll back together on storage failure', async () => {
      const order = seed({ hook: true }), notify = app.store.notify;
      app.store.notify = () => { throw new Error('isolated injected outbox failure'); };
      try { assert.equal((await accept(order, 502)).error, 'UPSTREAM_OR_STORAGE_ERROR'); }
      finally { app.store.notify = notify; }
      assert.equal(app.store.order(order.id).latePaymentAcceptance, undefined);
      assert.equal(app.store.order(order.id).paid, false); assert.equal(notices(order.id).length, 0);
      assert.equal((await accept(order)).paid, true); assert.equal(notices(order.id).length, 1);
    });
    await t.test('RPC failure cannot commit an acceptance decision', async () => {
      const order = seed(), identity = chain.identity;
      chain.identity = async () => { throw new AppError('RPC_UNAVAILABLE', 503); };
      try { assert.equal((await accept(order, 503)).error, 'RPC_UNAVAILABLE'); }
      finally { chain.identity = identity; }
      assert.equal(app.store.order(order.id).latePaymentAcceptance, undefined);
    });
  } finally {
    await app?.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
