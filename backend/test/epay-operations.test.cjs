'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const { start } = require('../server.cjs');
const { Store } = require('../store.cjs');
const { SOURCE_PREFIX } = require('../epay.cjs');
const { apiKey } = require('./helpers/auth.cjs');

const token = '0x0000000000000000000000000000000000000100';
const origin = 'https://upay.example.test';
const settings = { pid: 'synthetic', type: 'usdt', key: 'an-exclusively-synthetic-operations-key',
  token, priceCurrency: 'USDT', notifyUrl: 'https://new-api.example.test/notify', returnUrl: 'https://new-api.example.test/return' };
const prefix = SOURCE_PREFIX + settings.pid + ':';
const base = '/api/epay/operations';
function row(outTradeNo, state, fields = {}) {
  return { reference: prefix + outTradeNo, pid: settings.pid, state, outTradeNo, orderId: 'original-order', tradeNo: 'adapter-trade',
    type: 'usdt', amount: '1.00', priceCurrency: 'USDT', generation: 1, createdAt: 1000, nextAttempt: 0, ...fields };
}
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'upay-epay-operations-'));
  let app;
  t.after(async () => { try { await app?.close(); } finally { fs.rmSync(dir, { recursive: true, force: true }); } });
  const state = new Store(dir);
  try {
    state.set('config', { rpcUrl: 'https://not-used.invalid', chainId: 56, confirmations: 3, startBlock: 100,
      factory: '0x0000000000000000000000000000000000000300', payout: '0x0000000000000000000000000000000000000400',
      tokens: [{ address: token, decimals: 6, symbol: 'SYN' }] });
  } finally { state.close(); }
  app = await start({ dir, port: 0, pollMs: 0, publicOrigin: origin, epay: settings });
  function req(route, { body, authorized = true, deployment = 'legacy', cookie, browserOrigin } = {}) {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const headers = { ...(deployment ? { 'X-Upay-Deployment': deployment } : {}),
      ...(authorized ? { Authorization: 'Bearer ' + apiKey(dir) } : {}),
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      ...(cookie ? { Cookie: cookie } : {}), ...(browserOrigin ? { Origin: browserOrigin } : {}) };
    return new Promise((resolve, reject) => {
      const r = http.request(app.url + route, { method: data === undefined ? 'GET' : 'POST', headers }, res => {
        let bytes = ''; res.on('data', d => bytes += d); res.on('end', () => resolve({ status: res.statusCode,
          body: JSON.parse(bytes), cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }));
      });
      r.on('error', reject); r.end(data);
    });
  }
  return { app, req, dir };
}
test('admin pagination scopes merchant and deployment and preserves the original API', async t => {
  const { app, req } = await fixture(t);
  app.store.transaction(() => {
    for (let i = 0; i < 103; i++) app.store.saveEpay(row('original-' + String(i).padStart(3, '0'), 'FAILED'));
    app.store.saveEpay(row('other-merchant', 'FAILED', { reference: SOURCE_PREFIX + 'other:other-merchant', pid: 'other' }));
    app.store.saveEpay(row('waiting-delivery', 'PENDING'));
  });
  assert.equal((await req(base + '?state=FAILED', { authorized: false })).status, 401);
  assert.equal((await req(base + '?state=FAILED', { deployment: 'different' })).status, 404);
  assert.equal((await req(base + '?state=FAILED', { deployment: null })).status, 404);
  for (const query of ['state=FAILED&limit=101', 'state=FAILED&state=FAILED', 'state=FAILED&before=-1', 'state=DELIVERED', 'state=FAILED&pid=other']) {
    assert.equal((await req(base + '?' + query)).status, 400);
  }
  const first = await req(base + '?state=FAILED&limit=100');
  assert.equal(first.status, 200);
  assert.equal(first.body.items.length, 100);
  assert.equal(first.body.items[0].outTradeNo, 'original-102');
  assert.equal(first.body.items.at(-1).outTradeNo, 'original-003');
  app.store.saveEpay(row('newly-arrived', 'FAILED'));
  const second = await req(base + '?state=FAILED&limit=100&before=' + first.body.nextBefore);
  assert.deepEqual(second.body.items.map(o => o.outTradeNo), ['original-002', 'original-001', 'original-000']);
  assert.equal(second.body.nextBefore, null);
  const pending = await req(base + '?state=PENDING');
  assert.deepEqual(pending.body.items.map(o => o.outTradeNo), ['waiting-delivery']);
  assert.equal((await req('/api/epay/orders?out_trade_no=original-000', { deployment: null })).body.state, 'FAILED');
  assert.equal((await req('/api/epay/orders?state=FAILED', { deployment: null })).status, 400);
});

test('review records are append-only annotations, admin-scoped and stale after distinct reversal', async t => {
  const { app, req, dir } = await fixture(t);
  const original = row('full-store-order-id', 'RECONCILE', { reconcileReason: 'FINAL_CALLBACK_OUTCOME_UNKNOWN',
    attempts: 8, lastError: 'EPAY_CALLBACK_NOT_ACKNOWLEDGED', sign: 'not-for-list', publicToken: 'not-for-list', key: 'not-for-list',
    name: 'not-for-list', notifyUrl: 'https://not-for-list.example' });
  app.store.saveEpay(original);
  const native = { id: original.orderId, reference: original.reference, publicToken: 'synthetic-pay-token',
    paid: true, generation: 1, stateVersion: 1 };
  app.store.saveOrder(native);
  const work = (await req(base + '?state=RECONCILE')).body.items[0];
  assert.equal(work.outTradeNo, original.outTradeNo);
  assert.equal(work.orderId, original.orderId);
  assert.equal(work.reviewCurrent, false);
  assert.ok(!JSON.stringify(work).includes('not-for-list'));
  const body = { outTradeNo: work.outTradeNo, revision: work.revision, chain: 'CONFIRMED', newApi: 'CREDITED' };
  assert.equal((await req(base + '/reviews', { body, authorized: false })).status, 401);
  assert.equal((await req(base + '/reviews', { body, deployment: 'different' })).status, 404);
  assert.equal((await req(base + '/reviews', { body: { ...body, note: 'unstructured not accepted' } })).status, 400);

  // The existing cookie admin boundary also requires a same-origin write.
  const { recoveryKey } = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json')));
  const password = 'only-for-the-isolated-test';
  assert.equal((await req('/api/auth/reset', { body: { recoveryKey, newPassword: password }, authorized: false,
    browserOrigin: app.url })).status, 200);
  const login = await req('/api/login', { body: { password }, authorized: false, browserOrigin: app.url });
  assert.ok(login.cookie);
  assert.equal((await req(base + '/reviews', { body, authorized: false, cookie: login.cookie, browserOrigin: 'https://elsewhere.test' })).status, 403);
  const first = await req(base + '/reviews', { body, authorized: false, cookie: login.cookie, browserOrigin: app.url });
  assert.equal(first.status, 201);
  assert.equal(first.body.authorization, 'ADMIN_SESSION');
  assert.deepEqual(app.store.epayReference(original.reference), original); // no payment/delivery state change
  const checked = (await req(base + '?state=RECONCILE')).body.items[0];
  assert.equal(checked.reviewCurrent, true);
  assert.equal(checked.review.newApi, 'CREDITED');

  app.store.saveEpay({ ...original, reconcileReason: 'CHAIN_REVERSAL', reversedAt: 5000 });
  app.store.saveOrder({ ...native, paid: false, stateVersion: 2 });
  const later = (await req(base + '?state=RECONCILE')).body.items[0];
  assert.equal(later.reviewCurrent, false);
  assert.notEqual(later.revision, body.revision);
  assert.equal(later.review.reason, 'FINAL_CALLBACK_OUTCOME_UNKNOWN');
  assert.equal(later.reason, 'CHAIN_REVERSAL');
  assert.equal((await req(base + '/reviews', { body })).status, 409);
  const second = await req(base + '/reviews', { body: { ...body, revision: later.revision, chain: 'NOT_CANONICAL' } });
  assert.equal(second.status, 201);
  assert.equal(second.body.authorization, 'API_CREDENTIAL');
  const audit = await req(base + '/reviews?out_trade_no=' + original.outTradeNo + '&limit=1');
  const older = await req(base + '/reviews?out_trade_no=' + original.outTradeNo + '&limit=1&before=' + audit.body.nextBefore);
  assert.deepEqual([audit.body.items[0], older.body.items[0]], [second.body, first.body]);
  assert.equal((await req(base + '?state=RECONCILE')).body.items[0].reviewCurrent, true);
  assert.equal(app.store.epayReference(original.reference).state, 'RECONCILE');

  // An order may reconfirm while the EPay exception remains unchanged.
  app.store.saveOrder({ ...native, paid: true, generation: 2, stateVersion: 3 });
  const reconfirmed = (await req(base + '?state=RECONCILE')).body.items[0];
  assert.equal(reconfirmed.reviewCurrent, false);
  assert.equal(reconfirmed.nativePaid, true);
  assert.equal((await req(base + '/reviews', { body: { ...body, revision: later.revision } })).status, 409);
  app.store.saveEpay(row('pending-can-not-be-reviewed', 'PENDING'));
  const pending = (await req(base + '?state=PENDING')).body.items[0];
  assert.equal((await req(base + '/reviews', { body: { ...body, revision: pending.revision, outTradeNo: pending.outTradeNo } })).status, 409);
});
