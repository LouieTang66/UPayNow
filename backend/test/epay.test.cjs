'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { start } = require('../server.cjs');
const { Store } = require('../store.cjs');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upay-epay-test-'));
  const initial = new Store(dir);
  initial.set('config', { rpcUrl: 'https://not-used.example.test', chainId: 56, confirmations: 3, startBlock: 100,
    factory: '0x0000000000000000000000000000000000000300', payout: '0x0000000000000000000000000000000000000400',
    tokens: [{ address: TOKEN, decimals: 6, symbol: 'SYN' }, { address: OTHER, decimals: 6, symbol: 'OTHER' }] });
  initial.close();
  let app;
  const restart = async (epay = config, publicOrigin = PUBLIC) => {
    if (app) await app.close();
    app = null;
    app = await start({ dir, port: 0, pollMs: 0, publicOrigin, epay });
    const chain = app.merchant.chain;
    chain.identity = async () => {};
    chain.head = async () => 100;
    chain.factory = { predictAddress: async hash => '0x' + hash.slice(-40) };
    return app;
  };
  t.after(async () => { await app?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { app: await restart(), restart };
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
  assert.equal((await operator(app)).json.state, 'DELIVERED');
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
