'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { backup, generateKey } = require('../../scripts/ops-backup.cjs');
const { restore } = require('../../scripts/ops-restore.cjs');
const { start } = require('../server.cjs');
const { Store } = require('../store.cjs');
const { acquireStateOwnership } = require('../state-ownership.cjs');
const { signature, parseForm, usdtUnits, environment, SOURCE_PREFIX } = require('../epay.cjs');
const { Webhooks } = require('../webhooks.cjs');
const { apiKey } = require('./helpers/auth.cjs');

const PUBLIC = 'https://upay.example.test';
const TOKEN = '0x0000000000000000000000000000000000000100';
const OTHER = '0x0000000000000000000000000000000000000200';
const KEY = 'only-a-synthetic-key-for-epay-tests-0001';
const DEFAULT = { pid: '1001', key: KEY, token: TOKEN, priceCurrency: 'USDT',
  notifyUrl: 'https://new-api.example.test/api/user/epay/notify', returnUrl: 'https://new-api.example.test/usage-logs' };
const BASE = { pid: DEFAULT.pid, type: 'usdt', out_trade_no: 'USR1NOsynthetic', name: 'TUC10', money: '10.00',
  notify_url: DEFAULT.notifyUrl, return_url: DEFAULT.returnUrl, device: 'pc' };
// Independent fixture signer mirrors Go SDK joining raw decoded, nonempty values.
const wireSign = p => crypto.createHash('md5').update(Object.entries(p).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)
  .filter(([k,v]) => k !== 'sign' && k !== 'sign_type' && v !== '').map(([k,v]) => [k,v].join('=')).join('&') + KEY).digest('hex');
const signed = overrides => {
  const payload = { ...BASE, ...overrides };
  return new URLSearchParams({ ...payload, sign: wireSign(payload), sign_type: 'MD5' }).toString();
};

function request(app, route, { method = 'GET', body, host = new URL(PUBLIC).host, authorized = false,
  form = true } = {}) {
  const headers = { Host: host };
  if (authorized) headers.Authorization = 'Bearer ' + apiKey(app.store.dir);
  if (body !== undefined) {
    headers['Content-Type'] = form ? 'application/x-www-form-urlencoded' : 'application/json';
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  return new Promise((resolve, reject) => {
    const req = http.request(app.url + route, { method, headers }, res => {
      const chunks = [];
      res.on('data', data => chunks.push(data));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, location: res.headers.location, json: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function fixture(t, config = DEFAULT) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'upay-epay-test-'));
  const initial = new Store(dir);
  initial.set('config', { rpcUrl: 'https://not-used.example.test', chainId: 56, confirmations: 3, startBlock: 100,
    factory: '0x0000000000000000000000000000000000000300', payout: '0x0000000000000000000000000000000000000400',
    tokens: [{ address: TOKEN, decimals: 6, symbol: 'SYN' }, { address: OTHER, decimals: 6, symbol: 'OTHER' }] });
  initial.close();
  let app;
  const stop = async () => {
    if (app) await app.close();
    app = null;
  };
  const restart = async (epay = config, publicOrigin = PUBLIC, stateDir = dir) => {
    await stop();
    app = await start({ dir: stateDir, port: 0, pollMs: 0, publicOrigin, epay });
    const chain = app.merchant.chain;
    chain.identity = async () => {};
    chain.head = async () => 100;
    chain.factory = { predictAddress: async hash => '0x' + hash.slice(-40) };
    return app;
  };
  t.after(async () => { await stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { app: await restart(), restart, stop };
}

const reference = id => SOURCE_PREFIX + '1001:' + id;
function blockchain(app, order, { head = 103, units, reverse = false, token = TOKEN } = {}) {
  app.store.transaction(() => {
    if (reverse) app.store.rollbackAfter(100);
    if (units !== undefined) app.store.deposit({ eventId: order.id + ':' + token + ':' + units,
      orderId: order.id, blockNumber: 101, token, timestamp: Math.floor(order.createdAt / 1000), amount: String(units) });
    app.merchant.recalculate(head);
    app.store.set('lastHead', head);
    app.store.set('cursor', head);
    app.store.set('lastSync', Date.now());
    app.store.set('syncError', null);
  });
}

function operator(app, out_trade_no = BASE.out_trade_no) {
  return request(app, '/api/epay/orders?out_trade_no=' + out_trade_no, { authorized: true });
}

function setDue(app, id = BASE.out_trade_no) {
  const q = app.store.epayReference(reference(id));
  q.nextAttempt = 0;
  app.store.saveEpay(q);
}

test('pinned MD5 form semantics and exact USDT amounts', () => {
  const fields = { foo: 'x=y ü', pid: '123', empty: '', sign: 'not signed', sign_type: 'MD5' };
  assert.equal(signature(fields, KEY), wireSign(fields));
  assert.equal(usdtUnits('10.00', 6), 10000000n);
  assert.equal(usdtUnits('0.01', 6), 10000n);
  assert.deepEqual({ ...parseForm('name=%E4%BB%98%E6%AC%BE+TUC10&device=pc') }, { name: '付款 TUC10', device: 'pc' });
  for (const value of ['pid=1&pid=2', 'unknown=x', 'name=a%26b', 'name=a%00b', 'name=%FF', 'pid']) {
    assert.throws(() => parseForm(value), { code: 'INVALID_EPAY_FORM' });
  }
  assert.equal(environment({ UPAY_EPAY_ENABLED: '0' }), null);
  assert.throws(() => environment({ UPAY_EPAY_ENABLED: '1', UPAY_EPAY_TOKEN_PER_FIAT: '0.14' }), { code: 'EPAY_EXCHANGE_RATE_UNSUPPORTED' });
  assert.equal(environment({ UPAY_EPAY_ENABLED: '1', UPAY_EPAY_PRICE_CURRENCY: 'USDT' }).priceCurrency, 'USDT');
  assert.throws(() => usdtUnits('0.01', 1), { code: 'INVALID_EPAY_TOKEN_DECIMALS' });
  assert.throws(() => environment({ UPAY_EPAY_ENABLED: 'maybe' }), { code: 'INVALID_EPAY_ENABLED' });
});

test('checkout ingress is opted-in, signed/scope-locked; USDT price and payment address persist', async t => {
  const f = await fixture(t, null);
  assert.equal((await request(f.app, '/epay/submit.php?' + signed())).status, 404);
  await assert.rejects(f.restart(DEFAULT, ''), { code: 'EPAY_PUBLIC_HTTPS_REQUIRED' });
  await assert.rejects(f.restart({ ...DEFAULT, priceCurrency: undefined }), { code: 'EPAY_USDT_PRICE_REQUIRED' });
  await assert.rejects(f.restart({ ...DEFAULT, priceCurrency: 'CNY' }), { code: 'EPAY_USDT_PRICE_REQUIRED' });
  await assert.rejects(f.restart({ ...DEFAULT, rate: '0.2' }), { code: 'EPAY_EXCHANGE_RATE_UNSUPPORTED' });
  let app = await f.restart(DEFAULT);
  const route = '/epay/submit.php';
  assert.equal((await request(app, route + '?' + signed(), { host: new URL(app.url).host })).status, 403);
  assert.equal((await request(app, route + '?' + signed().replace('10.00','90.00'))).status, 401);
  assert.equal((await request(app, route + '?' + signed({ pid: '999' }))).status, 401);
  assert.equal((await request(app, route + '?' + signed({ notify_url: 'https://redirect.example.test/notify' }))).status, 403);
  assert.equal((await request(app, route + '?' + signed({ return_url: 'https://redirect.example.test/return' }))).status, 403);
  assert.equal((await request(app, route + '?' + signed({ money: '10.0' }))).status, 400);
  assert.equal((await request(app, route + '?' + signed({ type: 'alipay' }))).status, 400);
  assert.equal((await request(app, route + '?' + signed({ currency: 'CNY' }))).status, 400);
  assert.equal((await request(app, route + '?' + signed() + '&pid=1001')).status, 400);
  assert.equal((await request(app, route, { method: 'POST', body: '{}', form: false })).status, 415);
  assert.equal((await request(app, route + '?pid=1001', { method: 'POST', body: signed() })).status, 400);
  assert.equal((await request(app, '/api/epay/orders?out_trade_no=' + BASE.out_trade_no)).status, 401);
  assert.equal(app.store.orders().length, 0);
  const [created, repeated] = await Promise.all([
    request(app, route, { method: 'POST', body: signed() }),
    request(app, route + '?' + signed()),
  ]);
  assert.equal(created.status, 303);
  assert.match(created.location, /^https:\/\/upay\.example\.test\/pay\/[\w-]{32}$/);
  assert.equal(repeated.location, created.location);
  const q = (await operator(app)).json;
  const order = app.store.order(q.orderId);
  assert.equal(q.amount, '10.00');
  assert.equal(q.priceCurrency, 'USDT');
  assert.equal(order.expectedUnits, '10000000');
  assert.equal(app.store.orders().length, 1);
  assert.equal((await request(app, route + '?' + signed({ money: '11.00' }))).status, 409);
  assert.equal((await request(app, route + '?' + signed({ name: 'changed' }))).status, 409);
  const samePrice = await request(app, route + '?' + signed({ out_trade_no: 'newID' }));
  assert.notEqual(samePrice.location, created.location);
  assert.notEqual(app.store.reference(reference('newID')).address, order.address);
  assert.equal((await request(app, '/api/orders', { method: 'POST', authorized: true, form: false,
    body: JSON.stringify({ reference: reference('newID'), token: TOKEN, amount: '1' }) })).status, 409);
  assert.equal((await request(app, '/api/orders', { method: 'POST', authorized: true, form: false,
    body: JSON.stringify({ reference: reference('native'), token: TOKEN, amount: '1' }) })).status, 201);
  assert.equal((await request(app, route + '?' + signed({ out_trade_no: 'native' }))).status, 409);
  assert.equal((await operator(app, 'native')).status, 404);
  await assert.rejects(f.restart({ ...DEFAULT, notifyUrl: 'https://new.example.test/api/notify' }), { code: 'EPAY_BINDING_MISMATCH' });
  app = await f.restart(DEFAULT);
  assert.equal((await request(app, route + '?' + signed())).location, created.location);
  assert.equal((await operator(app)).json.amount, '10.00');
  await request(app, route + '?' + signed({ out_trade_no: 'futureID', money: '12.34' }));
  assert.equal((await operator(app, 'futureID')).json.amount, '12.34');
});

test('confirmed native payment notifies New API, retries lost ACK with one synthetic ledger credit, and flags reversal', async t => {
  const f = await fixture(t);
  let app = f.app;
  const created = await request(app, '/epay/submit.php?' + signed());
  const order = app.store.reference(reference(BASE.out_trade_no));
  const checkout = '/api' + new URL(created.location).pathname;
  const messages = [], credits = new Map();
  const mockNewAPI = async (target, profile) => {
    assert.equal(target.url, DEFAULT.notifyUrl);
    assert.equal(profile.method, 'POST');
    assert.ok(profile.beforeSend());
    const fields = Object.fromEntries(new URLSearchParams(profile.payload));
    assert.equal(fields.sign, wireSign(fields));
    assert.equal(fields.sign_type, 'MD5');
    assert.equal(fields.trade_status, 'TRADE_SUCCESS');
    assert.equal(fields.pid, DEFAULT.pid);
    assert.equal(fields.money, BASE.money);
    assert.equal(fields.type, BASE.type);
    messages.push(fields);
    if (!credits.has(fields.out_trade_no)) credits.set(fields.out_trade_no, 10);
    if (messages.length === 1) throw new Error('synthetic lost ACK after ledger credit');
    assert.equal(profile.accept(200, 'success'), true);
    assert.equal(profile.accept(200, 'fail'), false);
    assert.equal(profile.accept(302, 'success'), false);
    assert.equal(profile.accept(200, 'success\n'), false);
    return true;
  };
  app.epay.transport.send = mockNewAPI;
  await app.epay.tick(); // WAITING
  blockchain(app, order, { units: 10000000, token: OTHER });
  await app.epay.tick(); // wrong token
  blockchain(app, order, { head: 102, units: 10000000 });
  await app.epay.tick(); // only two confirmations
  assert.equal(messages.length, 0);
  assert.equal((await operator(app)).json.state, 'WAITING');
  blockchain(app, order); // third confirmation
  await app.epay.tick();
  assert.equal(messages.length, 1);
  assert.equal((await operator(app)).json.state, 'PENDING');
  assert.equal((await request(app, checkout)).json.epayReturnUrl, undefined);
  app = await f.restart();
  app.epay.transport.send = mockNewAPI;
  setDue(app);
  await Promise.all([app.epay.tick(), app.epay.tick()]);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], messages[1]);
  assert.deepEqual([...credits], [[BASE.out_trade_no, 10]]);
  const acknowledged = (await operator(app)).json;
  assert.equal(acknowledged.state, 'DELIVERED');
  assert.equal(acknowledged.callbackOutcomeUnknown, undefined);
  assert.equal((await request(app, checkout)).json.epayReturnUrl, DEFAULT.returnUrl);
  blockchain(app, order, { reverse: true });
  assert.equal((await operator(app)).json.state, 'RECONCILE');
  assert.equal((await request(app, checkout)).json.epayReturnUrl, undefined);
  blockchain(app, order, { units: 10000000 });
  await app.epay.tick();
  assert.equal((await operator(app)).json.state, 'RECONCILE');
  const reconciliations = await request(app, '/api/epay/orders?state=RECONCILE', { authorized: true });
  assert.deepEqual(reconciliations.json.map(q => q.outTradeNo), [BASE.out_trade_no]);
  assert.equal(messages.length, 2);
});

test('a restored pending EPay callback keeps its identity and an idempotent synthetic receiver credits only once',
  { skip: process.platform !== 'linux' }, async t => {
    const isolated = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'upay-epay-backup-test-'));
    let f;
    t.after(async () => { await f?.stop(); fs.rmSync(isolated, { recursive: true, force: true }); });
    const mkdir = (name) => { const result = path.join(isolated, name); fs.mkdirSync(result, { mode: 0o700 }); return result; };
    try {
      acquireStateOwnership(mkdir('capability-probe'), { requireGuard: true, recoverStale: false })();
    } catch (error) {
      if (error.code !== 'STATE_GUARD_UNAVAILABLE') throw error;
      t.skip('The temporary filesystem does not support the required state-ownership guard.');
      return;
    }
    f = await fixture(t);
    const archive = path.join(mkdir('archive'), 'pending.upaybak');
    const key = path.join(mkdir('keys'), 'backup.key');
    const destinationParent = mkdir('restores');
    // This independent database stands in for a store ledger. It is not part of
    // the UPayNow backup and represents an explicitly idempotent receiver.
    const ledger = path.join(mkdir('mock-store'), 'credits.sqlite');
    function withLedger(fn) {
      const db = new DatabaseSync(ledger);
      try { return fn(db); } finally { db.close(); }
    }
    withLedger(db => db.exec(`CREATE TABLE credits (
      out_trade_no TEXT PRIMARY KEY, trade_no TEXT NOT NULL, amount TEXT NOT NULL
    )`));
    generateKey(key);
    let app = f.app;
    const originalState = app.store.dir;
    const created = await request(app, '/epay/submit.php?' + signed());
    assert.equal(created.status, 303);
    const orderReference = reference(BASE.out_trade_no);
    const nativeIdentity = order => ({
      id: order.id, reference: order.reference, address: order.address, publicToken: order.publicToken,
    });
    const originalOrder = app.store.reference(orderReference);
    const originalBinding = app.epay.binding;
    assert.equal(originalBinding.deploymentId, 'legacy');
    blockchain(app, originalOrder, { units: 10000000 });
    const queued = (await operator(app)).json;
    assert.equal(queued.state, 'PENDING');
    assert.equal(queued.attempts, 0);
    await f.stop();
    backup({ state: originalState, archive, key, offline: true });

    const deliveries = [];
    const mockNewAPI = async (target, profile) => {
      assert.equal(target.url, DEFAULT.notifyUrl);
      assert.equal(profile.method, 'POST');
      assert.ok(profile.beforeSend());
      const params = Object.fromEntries(new URLSearchParams(profile.payload));
      assert.equal(params.sign, wireSign(params));
      assert.equal(params.sign_type, 'MD5');
      assert.equal(params.trade_status, 'TRADE_SUCCESS');
      assert.equal(params.out_trade_no, BASE.out_trade_no);
      assert.equal(params.trade_no, queued.tradeNo);
      assert.equal(params.money, BASE.money);
      // Commit before acknowledging; every invocation opens the persisted DB.
      const { changes } = withLedger(db => db.prepare(
        'INSERT INTO credits VALUES (?, ?, ?) ON CONFLICT(out_trade_no) DO NOTHING'
      ).run(params.out_trade_no, params.trade_no, params.money));
      deliveries.push({ payload: profile.payload, changes });
      return profile.accept(200, 'success');
    };
    app = await f.restart();
    app.epay.transport.send = mockNewAPI;
    // Refresh only synthetic chain state after restart; no external RPC.
    blockchain(app, originalOrder);
    await app.epay.tick();
    assert.equal((await operator(app)).json.state, 'DELIVERED');
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].changes, 1);
    await f.stop();

    const recovered = restore({ archive, key, destinationParent });
    assert.equal(recovered.databases, 1);
    assert.notEqual(recovered.directory, originalState);
    app = await f.restart(DEFAULT, PUBLIC, recovered.directory);
    const recoveredOrder = app.store.reference(orderReference);
    assert.deepEqual(nativeIdentity(recoveredOrder), nativeIdentity(originalOrder));
    assert.deepEqual(app.epay.binding, originalBinding);
    const restoredQueue = (await operator(app)).json;
    assert.equal(restoredQueue.orderId, queued.orderId);
    assert.equal(restoredQueue.tradeNo, queued.tradeNo);
    assert.equal(restoredQueue.state, 'PENDING');
    assert.equal(restoredQueue.attempts, 0);
    app.epay.transport.send = mockNewAPI;
    blockchain(app, recoveredOrder);
    await app.epay.tick();
    await app.epay.tick();
    const delivered = (await operator(app)).json;
    assert.equal(delivered.state, 'DELIVERED');
    assert.equal(delivered.attempts, 1);
    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[1].payload, deliveries[0].payload);
    assert.equal(deliveries[1].changes, 0);
    const allCredits = withLedger(db => db.prepare('SELECT * FROM credits').all().map(row => ({ ...row })));
    assert.deepEqual(allCredits, [{
      out_trade_no: BASE.out_trade_no, trade_no: queued.tradeNo, amount: BASE.money,
    }]);
  });

test('reorg during preflight suppresses stale success; lost ACK without response still flags reconciliation', async t => {
  const { app } = await fixture(t);
  await request(app, '/epay/submit.php?' + signed());
  const order = app.store.reference(reference(BASE.out_trade_no));
  blockchain(app, order, { units: 10000000 });
  app.epay.transport.send = async (_target, profile) => {
    blockchain(app, order, { reverse: true });
    assert.equal(profile.beforeSend(), false);
    return false;
  };
  await app.epay.tick();
  let q = (await operator(app)).json;
  assert.equal(q.state, 'SUPPRESSED');
  assert.equal(q.attempts, 0);
  blockchain(app, order, { units: 10000000 });
  app.epay.transport.send = async (_target, profile) => {
    assert.ok(profile.beforeSend());
    blockchain(app, order, { reverse: true });
    return false;
  };
  await app.epay.tick();
  q = (await operator(app)).json;
  assert.equal(q.state, 'RECONCILE');
  assert.equal(q.attempts, 1);
});

test('HTTPS egress checks forbid mixed public/private DNS and keep it separate from native webhook allowLocal', async t => {
  const { app } = await fixture(t);
  const transport = app.epay.transport;
  transport.lookup = async () => [{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }];
  await assert.rejects(transport.target(DEFAULT.notifyUrl), { code: 'WEBHOOK_PRIVATE_ADDRESS_DENIED' });
  await assert.rejects(transport.target('https://arbitrary.example.test/notify'), { code: 'WEBHOOK_HOST_NOT_ALLOWED' });
  await assert.rejects(transport.target('http://127.0.0.1/notify'), { code: 'WEBHOOK_HOST_NOT_ALLOWED' });
  let dispatches = 0;
  const send = transport.send.bind(transport);
  transport.send = (target, profile) => send(target, { ...profile, beforeSend: () => { dispatches++; return false; } });
  await request(app, '/epay/submit.php?' + signed());
  const order = app.store.reference(reference(BASE.out_trade_no));
  blockchain(app, order, { units: 10000000 });
  for (let i = 0; i < 8; i++) { setDue(app); await app.epay.tick(); }
  const q = (await operator(app)).json;
  assert.equal(dispatches, 0);
  assert.equal(q.state, 'FAILED');
  assert.equal(q.attempts, 0);
  assert.equal(q.preflightFailures, 8);
  assert.equal(q.lastError, 'EPAY_CALLBACK_PREFLIGHT_FAILED');
});

test('shared actual HTTP sender retains bounded signed form body, strict ack and no redirect', async t => {
  const { app } = await fixture(t);
  const server = http.createServer((req,res) => {
    const chunks = [];
    req.on('data', x => chunks.push(x)).on('end', () => {
      if (req.url === '/redirect') { res.writeHead(302, { Location: '/success' }); res.end('no'); return; }
      assert.equal(req.method, 'POST');
      assert.equal(req.headers['content-type'], 'application/x-www-form-urlencoded');
      assert.equal(Buffer.concat(chunks).toString(), 'fixture=signed-form');
      res.end(req.url === '/success' ? 'success' : 'fail');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const transport = new Webhooks(app.store, { allowLocal: true }); // synthetic transport test only
  t.after(() => transport.close());
  const profile = { method: 'POST', payload: 'fixture=signed-form', accept: (status, text) => status === 200 && text === 'success' };
  const target = route => ({ url: 'http://127.0.0.1:' + server.address().port + route });
  assert.equal(await transport.send(target('/success'), profile), true);
  assert.equal(await transport.send(target('/fail'), profile), false);
  assert.equal(await transport.send(target('/redirect'), profile), false);
});

test('EPay checkout reaches delivery after an actual transfer on the isolated local EVM', { timeout: 30000 }, async t => {
  const { ethers } = require('ethers');
  const { localServer } = require('./fixtures/dev-chain.cjs');
  const { deployLocal } = require('./fixtures/local-tools.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upay-epay-local-evm-'));
  const local = await localServer(0);
  const provider = new ethers.JsonRpcProvider(local.url, undefined, { cacheTimeout: -1 });
  let app;
  t.after(async () => {
    await app?.close();
    provider.destroy();
    await local.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const deployed = await deployLocal(provider);
  app = await start({ dir, port: 0, pollMs: 0, publicOrigin: PUBLIC, epay: null });
  await app.merchant.configure({ rpcUrl: local.url, chainId: 31337, factory: deployed.factory.target,
    payout: deployed.payout, startBlock: 0, confirmations: 3 });
  await app.close();
  app = await start({ dir, port: 0, pollMs: 0, publicOrigin: PUBLIC, epay: { ...DEFAULT, token: deployed.a.target } });
  const notices = [];
  app.epay.transport.send = async (_target, profile) => {
    assert.equal(profile.beforeSend(), true);
    const fields = Object.fromEntries(new URLSearchParams(profile.payload));
    assert.equal(fields.sign, wireSign(fields));
    notices.push(fields);
    return profile.accept(200, 'success');
  };
  const route = '/epay/submit.php';
  const created = await request(app, route, { method: 'POST', body: signed() });
  assert.equal(created.status, 303);
  const order = app.store.reference(reference(BASE.out_trade_no));
  assert.equal(await provider.getCode(order.address), '0x');
  const customer = await provider.getSigner(2);
  await (await deployed.a.mint(await customer.getAddress(), 10000000n)).wait();
  const paid = await (await deployed.a.connect(customer).transfer(order.address, 10000000n)).wait();
  assert.equal(paid.status, 1);
  await app.merchant.scan();
  await app.epay.tick();
  assert.equal(notices.length, 0);
  await provider.send('evm_mine', []);
  await provider.send('evm_mine', []);
  await app.merchant.scan();
  await app.epay.tick();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].out_trade_no, BASE.out_trade_no);
  assert.equal((await operator(app)).json.state, 'DELIVERED');
});

test('restart reconciles an exhausted in-flight callback without opening the transport', async t => {
  const f = await fixture(t);
  let app = f.app;
  assert.equal((await request(app, '/epay/submit.php?' + signed())).status, 303);
  const ref = reference(BASE.out_trade_no);
  const order = app.store.reference(ref);
  blockchain(app, order, { units: 10000000 });
  const queued = app.store.epayReference(ref);
  queued.attempts = 8;
  queued.callbackAttemptInFlight = true;
  queued.nextAttempt = Date.now() + 240_000;
  queued.lastError = 'EPAY_CALLBACK_NOT_ACKNOWLEDGED';
  app.store.saveEpay(queued);

  app = await f.restart();
  let dispatches = 0;
  app.epay.transport.send = async () => { dispatches++; return false; };
  await app.epay.tick();
  await app.epay.tick();
  assert.equal(dispatches, 0);
  const q = (await operator(app)).json;
  assert.equal(q.state, 'RECONCILE');
  assert.equal(q.reconcileReason, 'FINAL_CALLBACK_OUTCOME_UNKNOWN');
  assert.equal(q.callbackOutcomeUnknown, true);
  assert.equal(q.attempts, 8);
  assert.equal(q.tradeNo, queued.tradeNo);
  assert.equal(q.generation, queued.generation);
  assert.equal(q.lastError, queued.lastError);

  blockchain(app, order, { reverse: true });
  const reversed = (await operator(app)).json;
  assert.equal(reversed.state, 'RECONCILE');
  assert.equal(reversed.reconcileReason, 'CHAIN_REVERSAL');
  assert.equal(reversed.callbackOutcomeUnknown, true);
  assert.ok(reversed.reversedAt);
});

test('EPay final callback keeps definitive outcomes and parks uncertain ones for review', async t => {
  const f = await fixture(t);
  const cases = [
    { name: 'ack', verdict: profile => profile.accept(200, 'success'), state: 'DELIVERED' },
    { name: 'reject', verdict: profile => profile.accept(200, 'fail'), state: 'FAILED' },
    { name: 'timeout', verdict() { throw Error('fixture transport interrupted'); }, state: 'RECONCILE' },
    { name: 'inexact', verdict: profile => profile.accept(503, 'fail'), state: 'RECONCILE' },
    { name: 'olderUnknown', verdict: profile => profile.accept(200, 'fail'), inFlight: true, state: 'RECONCILE' },
    { name: 'olderUnknownAck', verdict: profile => profile.accept(200, 'success'), inFlight: true, state: 'DELIVERED' },
  ];
  const app = f.app;
  for (const c of cases) {
    const id = c.name;
    assert.equal((await request(app, '/epay/submit.php?' + signed({ out_trade_no: id }))).status, 303);
    const ref = reference(id);
    const order = app.store.reference(ref);
    blockchain(app, order, { units: 10000000 });
    const queued = app.store.epayReference(ref);
    queued.attempts = 7;
    queued.callbackAttemptInFlight = c.inFlight ?? false;
    app.store.saveEpay(queued);

    let dispatches = 0;
    app.epay.transport.send = async (_target, profile) => {
      dispatches++;
      assert.equal(profile.beforeSend(), true);
      const reserved = app.store.epayReference(ref);
      assert.equal(reserved.attempts, 8);
      assert.equal(reserved.callbackAttemptInFlight, true);
      return c.verdict(profile);
    };
    await app.epay.tick();
    await app.epay.tick();
    assert.equal(dispatches, 1, id);
    const result = (await operator(app, id)).json;
    assert.equal(result.state, c.state, id);
    assert.equal(result.attempts, 8, id);
    if (c.state === 'RECONCILE') assert.equal(result.reconcileReason, 'FINAL_CALLBACK_OUTCOME_UNKNOWN', id);
    else {
      assert.equal(result.reconcileReason, undefined, id);
      assert.equal(result.callbackOutcomeUnknown, undefined, id);
      assert.equal(app.store.epayReference(ref).callbackOutcomeUnknown, undefined, id);
    }
  }
});
