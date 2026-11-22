'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server.cjs');
const { createOpsMonitor, LIMITS } = require('../ops-monitor.cjs');

const secret = 'this-order-reference-and-endpoint-must-not-leak';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upay-ops-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function putNative(store, state, queuedAt) {
  store.notify({ id: secret, orderId: secret, url: 'https://example.com/' + secret,
    payload: { reference: secret }, state, queuedAt, nextAttempt: 0 });
}
function putEpay(store, state, queuedAt) {
  store.saveEpay({ reference: secret, outTradeNo: secret, notifyUrl: 'https://example.com/' + secret,
    money: '1.23', state, queuedAt, nextAttempt: 0 });
}
function liveEngine(t) {
  const { Store } = require('../store.cjs');
  const d = fixture(t);
  // Use an in-memory SQL fixture so the sampling logic's unit test is not
  // coupled to an operating-system process lock implementation.
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE notifications (id TEXT PRIMARY KEY, state TEXT NOT NULL, body TEXT NOT NULL); CREATE TABLE epay_orders (reference TEXT PRIMARY KEY, state TEXT NOT NULL, next_attempt INTEGER NOT NULL, body TEXT NOT NULL);");
  const store = Object.assign(Object.create(Store.prototype), { db, dir: d });
  return { store, merchant: { chain: null } };
}

test('blank instance is quiet, green chain is reported, stale/degraded transitions dedupe and clear', t => {
  const engine = liveEngine(t);
  const base = 1_700_000_000_000;
  let now = base;
  const records = [];
  const ops = createOpsMonitor({ engines: () => [['legacy', engine]], clock: () => now, emit: x => records.push(x) });
  ops.tick();
  assert.deepEqual(records, []);
  assert.deepEqual(ops.status().deployments[0].scan,
    { configured: false, lastCaughtUpAgeMs: null, behindBlocks: null, hasError: false });

  engine.merchant.chain = { config: { rpcUrl: 'https://example.com/?secret=' + secret } };
  ops.tick();
  assert.deepEqual(records, []); // grace period before first synchronization
  now += LIMITS.startupGraceMs;
  engine.store.set('lastSync', now);
  engine.store.set('lastHead', 123);
  engine.store.set('cursor', 123);
  assert.equal(ops.status().ok, true);
  assert.equal(ops.status().deployments[0].scan.behindBlocks, 0);

  now += LIMITS.scanStaleMs;
  engine.store.set('lastHead', 123 + LIMITS.scanLagBlocks);
  engine.store.set('syncError', secret);
  ops.tick();
  ops.tick();
  assert.deepEqual(records.map(x => [x.event, x.code]), [
    ['upay.ops.alert', 'SCAN_ERROR'], ['upay.ops.alert', 'SCAN_STALE'], ['upay.ops.alert', 'SCAN_BEHIND'],
  ]);
  assert.equal(ops.status().ok, false);
  assert.doesNotMatch(JSON.stringify({ status: ops.status(), records }), new RegExp(secret));

  engine.store.set('cursor', 123 + LIMITS.scanLagBlocks);
  engine.store.set('lastSync', now);
  engine.store.set('syncError', null);
  ops.tick();
  ops.tick();
  assert.deepEqual(records.slice(3).map(x => [x.event, x.code]), [
    ['upay.ops.clear', 'SCAN_ERROR'], ['upay.ops.clear', 'SCAN_STALE'], ['upay.ops.clear', 'SCAN_BEHIND'],
  ]);
});

test('overdue, failed and EPay reconciliation states produce aggregate counts only', t => {
  const engine = liveEngine(t);
  const now = 1_700_000_000_000, records = [];
  const ops = createOpsMonitor({ engines: () => [['legacy', engine]], clock: () => now,
    epay: () => ({ engine }), emit: x => records.push(x) });
  putNative(engine.store, 'PENDING', now - LIMITS.callbackLateMs);
  putEpay(engine.store, 'WAITING', now - LIMITS.callbackLateMs);
  ops.tick();
  const report = ops.status().deployments[0];
  assert.deepEqual(report.callbacks.native, { pending: 1, failed: 0, overdue: 1 });
  assert.deepEqual(Object.assign({}, report.callbacks.epay), { enabled: true, pending: 0, failed: 0, reconcile: 0, overdue: 0 });
  assert.deepEqual(report.issues, ['NATIVE_CALLBACK_BACKLOG']);
  putNative(engine.store, 'FAILED', now);
  putEpay(engine.store, 'FAILED', now);
  ops.tick();
  assert.deepEqual(ops.status().deployments[0].issues, ['NATIVE_CALLBACK_FAILED', 'EPAY_CALLBACK_FAILED']);
  putEpay(engine.store, 'RECONCILE', now);
  ops.tick();
  assert.deepEqual(ops.status().deployments[0].issues, ['NATIVE_CALLBACK_FAILED', 'EPAY_RECONCILE']);
  assert.doesNotMatch(JSON.stringify({ status: ops.status(), records }), new RegExp(secret));
});

test('ops endpoint requires real operator session and public liveness stays unchanged', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upay-ops-test-'));
  const app = await start({ dir, port: 0, pollMs: 0, epay: null });
  // Combined teardown ensures DB and locks close before removal of the fixture.
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const status = (headers = {}, method = 'GET') => fetch(app.url + '/api/ops/status', { headers, method });
  const post = (route, body) => fetch(app.url + route, { method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const { apiKey, recoveryKey } = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
  assert.equal((await status()).status, 401);
  assert.equal((await status({ Authorization: 'Bearer ' + apiKey })).status, 401);
  assert.deepEqual(await (await fetch(app.url + '/health')).json(), { ok: true, version: 'merchant-v1', configured: false });
  const password = 'Unique initial test password';
  assert.equal((await post('/api/auth/reset', { recoveryKey, newPassword: password })).status, 200);
  const login = await post('/api/login', { password });
  assert.equal(login.status, 200);
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] };
  assert.equal((await status(headers, 'POST')).status, 404);
  assert.equal((await status(headers)).status, 200);
  putNative(app.store, 'FAILED', Date.now());
  const bad = await status(headers);
  assert.equal(bad.status, 503);
  const body = await bad.text();
  assert.match(body, /NATIVE_CALLBACK_FAILED/);
  assert.doesNotMatch(body, new RegExp(secret));
  assert.equal((await status()).status, 401);
  assert.deepEqual(await (await fetch(app.url + '/health')).json(), { ok: true, version: 'merchant-v1', configured: false });
});

test('old queue rows gain overdue detection after startup; failing log sink never breaks status or payment', t => {
  const engine = liveEngine(t);
  let now = 1_700_000_000_000, sinkFails = true;
  const records = [];
  putNative(engine.store, 'PENDING', undefined);
  putEpay(engine.store, 'PENDING', undefined);
  const ops = createOpsMonitor({ engines: () => [['legacy', engine]], clock: () => now,
    emit: x => { if (sinkFails) throw Error(secret); records.push(x); } });
  assert.equal(ops.status().ok, true);
  now += LIMITS.callbackLateMs;
  assert.equal(ops.status().ok, false);
  assert.doesNotThrow(() => ops.tick());
  assert.deepEqual(records, []);
  sinkFails = false;
  ops.tick();
  ops.tick();
  assert.deepEqual(records.map(x => x.code), ['NATIVE_CALLBACK_BACKLOG', 'EPAY_CALLBACK_BACKLOG']);
});

test('broken deployment reports fixed error without injecting registry values or failures', t => {
  const engine = liveEngine(t);
  const id = 'c1234567-1111-4444-8111-789123456789';
  const ops = createOpsMonitor({ engines: () => [
    ['legacy', engine], [id, { error: secret, store: null }], [secret, null],
  ] });
  assert.deepEqual(ops.status().deployments.slice(1), [
    { id, available: false, issues: ['DEPLOYMENT_UNAVAILABLE'] },
    { id: 'invalid-registry-entry', available: false, issues: ['DEPLOYMENT_UNAVAILABLE'] },
  ]);
  assert.doesNotMatch(JSON.stringify(ops.status()), new RegExp(secret));
  assert.equal(ops.status().ok, false);
});

test('a deployment read failure preserves prior incidents until successful observations', t => {
  const engine = liveEngine(t);
  const now = 1_700_000_000_000, records = [];
  const get = engine.store.get.bind(engine.store);
  let unreadable = false;
  engine.store.get = (...args) => {
    if (unreadable) throw Error(secret);
    return get(...args);
  };
  const ops = createOpsMonitor({ engines: () => [['legacy', engine]], clock: () => now,
    emit: record => records.push(record) });
  const events = () => records.splice(0).map(({ event, code }) => [event, code]);

  putEpay(engine.store, 'FAILED', now);
  ops.tick();
  assert.deepEqual(events(), [['upay.ops.alert', 'EPAY_CALLBACK_FAILED']]);

  unreadable = true;
  ops.tick();
  ops.tick();
  assert.doesNotMatch(JSON.stringify(records), new RegExp(secret));
  assert.deepEqual(events(), [['upay.ops.alert', 'OBSERVATION_UNAVAILABLE']]);

  unreadable = false;
  ops.tick();
  assert.deepEqual(events(), [['upay.ops.clear', 'OBSERVATION_UNAVAILABLE']]);

  putEpay(engine.store, 'DELIVERED', now);
  ops.tick();
  ops.tick();
  assert.deepEqual(events(), [['upay.ops.clear', 'EPAY_CALLBACK_FAILED']]);
});

test('a failed registry read cannot clear deployment incidents; a healthy inventory can retire an absent deployment', t => {
  const engine = liveEngine(t);
  const id = 'c1234567-1111-4444-8111-789123456789';
  const now = 1_700_000_000_000, records = [];
  let entries = [[id, engine]];
  let registryUnreadable = false;
  const ops = createOpsMonitor({
    engines: () => {
      if (registryUnreadable) throw Error(secret);
      return entries;
    },
    clock: () => now, emit: record => records.push(record),
  });
  const events = () => records.splice(0).map(({ event, deploymentId, code }) => [event, deploymentId, code]);

  putNative(engine.store, 'FAILED', now);
  ops.tick();
  assert.deepEqual(events(), [['upay.ops.alert', id, 'NATIVE_CALLBACK_FAILED']]);

  registryUnreadable = true;
  ops.tick();
  ops.tick();
  assert.doesNotMatch(JSON.stringify(records), new RegExp(secret));
  assert.deepEqual(events(), [['upay.ops.alert', 'instance', 'OBSERVATION_UNAVAILABLE']]);

  registryUnreadable = false;
  entries = [];
  ops.tick();
  ops.tick();
  assert.deepEqual(events(), [
    ['upay.ops.clear', id, 'NATIVE_CALLBACK_FAILED'],
    ['upay.ops.clear', 'instance', 'OBSERVATION_UNAVAILABLE'],
  ]);
});

test('an unobservable deployment does not prevent genuine clears for other deployments', t => {
  const one = liveEngine(t);
  const two = liveEngine(t);
  const id = 'c1234567-1111-4444-8111-789123456789';
  const now = 1_700_000_000_000, records = [];
  let entries = [['legacy', one], [id, two]];
  const ops = createOpsMonitor({ engines: () => entries, clock: () => now, emit: record => records.push(record) });
  const events = () => records.splice(0).map(({ event, deploymentId, code }) => [event, deploymentId, code]);

  putEpay(one.store, 'FAILED', now);
  putNative(two.store, 'FAILED', now);
  ops.tick();
  assert.deepEqual(events(), [
    ['upay.ops.alert', 'legacy', 'EPAY_CALLBACK_FAILED'],
    ['upay.ops.alert', id, 'NATIVE_CALLBACK_FAILED'],
  ]);

  entries = [['legacy', { store: null }], [id, two]];
  putNative(two.store, 'DELIVERED', now);
  ops.tick();
  assert.deepEqual(events(), [
    ['upay.ops.alert', 'legacy', 'DEPLOYMENT_UNAVAILABLE'],
    ['upay.ops.clear', id, 'NATIVE_CALLBACK_FAILED'],
  ]);

  entries = [['legacy', one], [id, two]];
  putEpay(one.store, 'DELIVERED', now);
  ops.tick();
  assert.deepEqual(events(), [
    ['upay.ops.clear', 'legacy', 'EPAY_CALLBACK_FAILED'],
    ['upay.ops.clear', 'legacy', 'DEPLOYMENT_UNAVAILABLE'],
  ]);
});
