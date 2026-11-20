'use strict';
// Isolated Merchant/RPC doubles: no live chain, wallet, database or credentials.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Merchant } = require('../merchant.cjs');
const { AppError } = require('../chain.cjs');
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function orders(count) {
  return Array.from({ length: count }, (_, i) => ({ id: 'order-' + i, reference: 'fixture-' + i,
    address: 'address-' + i, token: 'TOKEN', symbol: 'TEST', decimals: 6,
    expectedUnits: '1000000', confirmedUnits: '1000000', expectedAmount: '1.0',
    paid: true, status: 'PAID', expiresAt: Date.now() + 60000, generation: 1, stateVersion: 0 }));
}
function fixture(list = []) {
  const values = new Map([['cursor', 100], ['lastHead', 100], ['lastSync', Date.now()]]);
  const anchors = new Map([[100, 'hash-100']]), jobs = [];
  const calls = { identity: 0, scans: 0, balances: [] };
  const store = {
    get: (key, fallback = null) => values.has(key) ? values.get(key) : fallback,
    set: (key, value) => values.set(key, value), orders: () => list, jobs: () => jobs,
    anchors: () => [...anchors].sort((a, b) => b[0] - a[0]).map(([number, hash]) => ({ number, hash })),
    anchor: (number, hash) => anchors.set(number, hash), transaction: fn => fn(), saveOrder() {},
    deposits: () => [{ token: 'TOKEN', amount: '1000000', timestamp: Math.floor(Date.now() / 1000), blockNumber: 90 }],
  };
  const merchant = new Merchant(store, { externalWallet: true });
  const chain = {
    config: { chainId: 31337, rpcUrl: 'https://rpc.invalid', payout: 'fixed-payout', confirmations: 2, startBlock: 0 }, height: 100,
    async identity() { calls.identity++; }, async head() { return chain.height; },
    async block(number) { return { number, hash: 'hash-' + number }; }, async logs() { return []; },
    async balance(token, address, tag) { calls.balances.push({ token, address, tag }); return 1000000n; },
  };
  merchant.chain = chain;
  merchant.refreshJobs = async () => { calls.scans++; };
  return { merchant, store, chain, calls, list, jobs };
}
function pauseScan(f) {
  const gate = deferred(), started = deferred(), original = f.chain.block;
  let first = true;
  f.chain.block = async number => {
    if (first) { first = false; started.resolve(); await gate.promise; }
    return original(number);
  };
  return { gate, started: started.promise };
}

test('concurrent previews join one running scan but retain their identity checks', async () => {
  const f = fixture(), pause = pauseScan(f), background = f.merchant.scan();
  await pause.started;
  const a = f.merchant.previewPaid(), b = f.merchant.previewPaid();
  await turn(); pause.gate.resolve();
  const [, one, two] = await Promise.all([background, a, b]);
  assert.deepEqual(one.entries, []); assert.deepEqual(two, one);
  assert.equal(f.calls.scans, 1); assert.equal(f.calls.identity, 3);
  assert.equal(f.merchant.scanPromise, null); assert.equal(f.merchant.busy, false);
});

test('joining an older scan adds one fresh increment before returning a preview', async () => {
  const f = fixture(), pause = pauseScan(f), background = f.merchant.scan();
  await pause.started; f.chain.height = 101;
  const preview = f.merchant.previewPaid(); await turn(); pause.gate.resolve();
  await Promise.all([background, preview]);
  assert.equal(f.calls.scans, 2); assert.equal(f.store.get('cursor'), 101);
  assert.equal(f.calls.identity, 3);
});

test('concurrent freshness waiters also share the supplemental scan', async () => {
  const f = fixture(), pause = pauseScan(f), background = f.merchant.scan();
  await pause.started; f.chain.height = 101;
  const previews = [f.merchant.previewPaid(), f.merchant.previewPaid(), f.merchant.previewPaid()];
  await turn(); pause.gate.resolve(); await Promise.all([background, ...previews]);
  assert.equal(f.calls.scans, 2); assert.equal(f.store.get('cursor'), 101);
});

test('scan failure reaches every waiter and clears the flight for an explicit retry', async () => {
  const f = fixture(), pause = pauseScan(f), background = f.merchant.scan();
  await pause.started;
  const error = new AppError('CHAIN_RPC_ERROR', 502);
  const failures = [background, f.merchant.previewPaid(), f.merchant.previewPaid()]
    .map(p => assert.rejects(p, e => e === error));
  await turn(); pause.gate.reject(error); await Promise.all(failures);
  assert.equal(f.store.get('syncError'), 'CHAIN_RPC_ERROR'); assert.equal(f.merchant.scanPromise, null);
  assert.deepEqual((await f.merchant.previewPaid()).entries, []);
  assert.equal(f.store.get('syncError'), null);
});

test('completed scans are not retained as a time-based freshness cache', async () => {
  const f = fixture(); await f.merchant.previewPaid(); await f.merchant.previewPaid();
  assert.equal(f.calls.scans, 2); assert.equal(f.calls.identity, 4);
});

test('ordinary scan callers retain independent scans and submission lock ordering', async () => {
  const f = fixture(), a = f.merchant.scan(), b = f.merchant.scan();
  assert.notEqual(a, b); await Promise.all([a, b]);
  assert.equal(f.calls.scans, 2); assert.equal(f.merchant.scanPromise, null);
});

test('separate deployments never share scan work', async () => {
  const a = fixture(), b = fixture(); await Promise.all([a.merchant.previewPaid(), b.merchant.previewPaid()]);
  assert.equal(a.calls.scans, 1); assert.equal(b.calls.scans, 1);
});

test('a bounded catch-up that remains behind fails rather than exposing stale eligible orders', async () => {
  const f = fixture(), pause = pauseScan(f), background = f.merchant.scan();
  await pause.started; f.chain.height = 500;
  const rejected = assert.rejects(f.merchant.previewPaid(), { code: 'SCAN_NOT_READY' });
  await turn(); pause.gate.resolve(); await Promise.all([background, rejected]);
  assert.equal(f.calls.scans, 2); assert.equal(f.store.get('cursor'), 300);
  assert.equal(f.calls.balances.length, 0);
});

test('changing configuration while awaiting a shared scan cannot reuse the old chain validation', async () => {
  const f = fixture(), pause = pauseScan(f), background = f.merchant.scan();
  await pause.started;
  const changed = f.merchant.exclusive(async () => { f.merchant.chain = { ...f.chain }; });
  const rejected = assert.rejects(f.merchant.previewPaid(), { code: 'SCAN_NOT_READY' });
  await turn(); pause.gate.resolve(); await Promise.all([background, changed, rejected]);
});

test('preview balances are limited to four reads and preserve order and exact decimal strings', async () => {
  const f = fixture(orders(10)), gates = [];
  let active = 0, peak = 0;
  f.chain.balance = async (token, address, tag) => {
    assert.equal(tag, 'latest'); active++; peak = Math.max(peak, active);
    const gate = deferred(); gates.push(gate); await gate.promise; active--;
    return BigInt(address.split('-')[1]) === 3n ? 0n : 1000001n;
  };
  const pending = f.merchant.previewPaid(); await turn(); assert.equal(gates.length, 4);
  gates.slice(0, 4).reverse().forEach(g => g.resolve()); await turn(); assert.equal(gates.length, 8);
  gates.slice(4, 8).reverse().forEach(g => g.resolve()); await turn(); assert.equal(gates.length, 10);
  gates.slice(8).forEach(g => g.resolve()); const result = await pending;
  assert.equal(peak, 4); assert.equal(active, 0);
  assert.deepEqual(result.entries.map(o => o.id), f.list.filter((_, i) => i !== 3).map(o => o.id));
  assert.ok(result.entries.every(o => o.balance === '1.000001'));
});

test('one failed balance fails the whole preview after draining its bounded batch', async () => {
  const f = fixture(orders(8)), gates = [], error = new AppError('RPC_RATE_LIMIT', 502);
  let reads = 0, settled = false;
  f.chain.balance = async () => {
    if (++reads === 1) throw error;
    const gate = deferred(); gates.push(gate); await gate.promise; return 1000000n;
  };
  const failed = assert.rejects(f.merchant.previewPaid(), e => e === error).then(() => { settled = true; });
  await turn(); assert.equal(reads, 4); assert.equal(settled, false); assert.equal(f.merchant.busy, true);
  gates.forEach(g => g.resolve()); await failed;
  assert.equal(reads, 4); assert.equal(f.merchant.busy, false);
});

test('execution-side paidPlan defaults remain serial and explicit order scope stays intact', async () => {
  const f = fixture(orders(8)); let active = 0, peak = 0;
  f.chain.balance = async () => { active++; peak = Math.max(peak, active); await turn(); active--; return 1000000n; };
  const plan = await f.merchant.paidPlan(['order-1', 'order-5']);
  assert.equal(peak, 1); assert.deepEqual(plan.entries.map(o => o.id), ['order-1', 'order-5']);
});

test('controlled 10-order balance-read benchmark keeps the same result with bounded concurrency', async t => {
  const measure = async parallel => {
    const f = fixture(orders(10)); let active = 0, peak = 0;
    f.chain.balance = async () => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 20)); active--;
      return 1000000n;
    };
    const start = performance.now(), plan = await f.merchant.paidPlan(undefined, parallel);
    return { plan, peak, ms: Math.round(performance.now() - start) };
  };
  const serial = await measure(false), parallel = await measure(true);
  assert.deepEqual(parallel.plan, serial.plan); assert.equal(serial.peak, 1); assert.equal(parallel.peak, 4);
  t.diagnostic(JSON.stringify({ scope: 'simulated 20ms balance reads, not live RPC', orders: 10,
    serialMs: serial.ms, parallelMs: parallel.ms, peakConcurrentReads: parallel.peak }));
});

test('preview still rejects unresolved transactions, identity mismatch and a noncanonical anchor', async () => {
  const f = fixture(orders(1)); f.jobs.push({ state: 'UNKNOWN' });
  await assert.rejects(f.merchant.previewPaid(), { code: 'TRANSACTION_RECONCILIATION_REQUIRED' });
  f.jobs.length = 0;
  const identity = f.chain.identity;
  f.chain.identity = async () => { await identity(); if (f.calls.identity === 3) throw new AppError('FACTORY_IDENTITY_MISMATCH', 409); };
  await assert.rejects(f.merchant.previewPaid(), { code: 'FACTORY_IDENTITY_MISMATCH' });
  f.chain.identity = identity; f.chain.block = async number => ({ number, hash: 'not-the-anchor' });
  await assert.rejects(f.merchant.paidPlan(undefined, true), { code: 'SCAN_REORG_RETRY' });
  assert.equal(f.calls.balances.length, 0);
});
