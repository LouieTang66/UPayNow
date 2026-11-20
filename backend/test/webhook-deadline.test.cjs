'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { Store } = require('../store.cjs');
const { Webhooks } = require('../webhooks.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, handler, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upaynow-webhook-deadline-'));
  const store = new Store(dir);
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/notify`;
  const hooks = new Webhooks(store, { allowLocal: true, timeoutMs: 120, ...options });
  t.after(async () => {
    await hooks.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    store.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
  function order(id = 'a', extra = {}) {
    const o = { id, reference: id, publicToken: id, paid: true, generation: 1, stateVersion: 2, ...extra };
    store.saveOrder(o); return o;
  }
  function notification(id = 'n1', orderId = 'a', extra = {}) {
    const n = { id, orderId, url, payload: { type: 'payment.paid', paymentGeneration: 1, stateVersion: 2 },
      state: 'PENDING', attempts: 0, nextAttempt: 0, ...extra };
    store.notify(n); return n;
  }
  return { store, server, hooks, url, order, notification };
}

test('total deadline stops slow-drip response and destroys its socket', { timeout: 3000 }, async t => {
  let socketClosed;
  const closed = new Promise(resolve => { socketClosed = resolve; });
  const f = await fixture(t, (req, res) => {
    req.socket.once('close', socketClosed);
    res.writeHead(200); res.write('.');
    const timer = setInterval(() => res.write('.'), 15);
    res.once('close', () => clearInterval(timer));
  });
  f.order(); const n = f.notification();
  const start = performance.now(); await f.hooks.tick();
  assert.ok(performance.now() - start < 1000);
  await closed;
  assert.equal(f.store.notifications()[0].state, 'PENDING');
  assert.equal(f.store.notifications()[0].attempts, 1);
  assert.equal(n.id, 'n1'); assert.equal(f.hooks.active.size, 0);
});

test('total deadline stops a peer that never responds', { timeout: 3000 }, async t => {
  const f = await fixture(t, () => {});
  f.order(); f.notification();
  await f.hooks.tick();
  assert.equal(f.store.notifications()[0].state, 'PENDING');
  assert.equal(f.hooks.running, false);
});

test('unresolved DNS is bounded; late DNS success cannot open a request', { timeout: 3000 }, async t => {
  let complete, requests = 0;
  const f = await fixture(t, (_req, res) => { requests++; res.end('ok'); }, {
    lookup: () => new Promise(resolve => { complete = resolve; })
  });
  f.order(); f.notification();
  await f.hooks.tick();
  assert.equal(f.hooks.active.size, 0);
  complete([{ address: '127.0.0.1', family: 4 }]); await delay(40);
  assert.equal(requests, 0);
});

test('late DNS rejection is consumed after deadline', { timeout: 3000 }, async t => {
  let fail;
  const f = await fixture(t, () => {}, { lookup: () => new Promise((_resolve, reject) => { fail = reject; }) });
  f.order(); f.notification(); await f.hooks.tick();
  fail(new Error('late DNS failure')); await delay(30);
  assert.equal(f.store.notifications()[0].state, 'PENDING');
});

test('close aborts running DNS, joins concurrent tick and prevents new delivery', { timeout: 3000 }, async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let lookups = 0;
  const f = await fixture(t, () => {}, { timeoutMs: 10000, lookup: () => {
    lookups++; started(); return new Promise(() => {});
  } });
  f.order(); f.order('b'); f.notification(); f.notification('n2', 'b');
  const tick = f.hooks.tick(); assert.equal(f.hooks.tick(), tick); await ready;
  const start = performance.now(); await f.hooks.close(); await tick;
  assert.ok(performance.now() - start < 500);
  await f.hooks.tick(); await assert.rejects(f.hooks.send(f.store.notifications()[0]), /WEBHOOK_CLOSED/);
  assert.equal(lookups, 1); assert.equal(f.hooks.running, false);
  assert.equal(f.store.notifications()[1].attempts, 0);
});

test('abortAll destroys an active response without waiting for the configured deadline', { timeout: 3000 }, async t => {
  let arrived;
  const ready = new Promise(resolve => { arrived = resolve; });
  let closed;
  const socketClosed = new Promise(resolve => { closed = resolve; });
  const f = await fixture(t, (req, res) => {
    req.socket.once('close', closed); res.writeHead(200); res.write('.'); arrived();
  }, { timeoutMs: 10000 });
  f.order(); f.notification(); const tick = f.hooks.tick(); await ready;
  await f.hooks.abortAll(); await tick; await socketClosed;
  assert.equal(f.store.notifications()[0].state, 'PENDING');
  assert.equal(f.hooks.active.size, 0);
});

test('normal delivery preserves signature, stable event/body retries and per-order order', { timeout: 3000 }, async t => {
  const received = [];
  const f = await fixture(t, (req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => { received.push({ body, headers: req.headers }); res.statusCode = received.length === 1 ? 503 : 204; res.end(); });
  });
  f.order(); f.notification(); f.notification('n2');
  await f.hooks.tick(); await f.hooks.tick();
  assert.equal(received.length, 1); // backoff on head blocks the second event
  const first = f.store.notifications()[0]; first.nextAttempt = 0; f.store.notify(first);
  await f.hooks.tick(); await f.hooks.tick();
  assert.deepEqual(received.map(r => r.headers['x-upaynow-event']), ['n1', 'n1', 'n2']);
  assert.equal(received[0].body, received[1].body);
  for (const r of received) {
    const signature = crypto.createHmac('sha256', f.hooks.secret)
      .update(r.headers['x-upaynow-timestamp'] + '.' + r.body).digest('hex');
    assert.equal(r.headers['x-upaynow-signature'], signature);
  }
  assert.ok(f.store.notifications().every(n => n.state === 'DELIVERED'));
});

test('cancel old-generation reversal; retain current reversal despite later stateVersion', { timeout: 3000 }, async t => {
  const received = [];
  const f = await fixture(t, (req, res) => { received.push(req.headers['x-upaynow-event']); res.end('ok'); });
  f.order('a', { paid: false, generation: 2, stateVersion: 8 });
  f.notification('old', 'a', { payload: { type: 'payment.reversed', paymentGeneration: 1, stateVersion: 3 } });
  f.notification('current', 'a', { payload: { type: 'payment.reversed', paymentGeneration: 2, stateVersion: 7 } });
  await f.hooks.tick();
  assert.deepEqual(received, ['current']);
  assert.deepEqual(f.store.notifications().map(n => n.state), ['CANCELLED', 'DELIVERED']);
});

test('repaid order cancels reversal even if generation payload matches', { timeout: 3000 }, async t => {
  let requests = 0;
  const f = await fixture(t, (_req, res) => { requests++; res.end(); });
  f.order(); f.notification('reverse', 'a', { payload: { type: 'payment.reversed', paymentGeneration: 1, stateVersion: 1 } });
  await f.hooks.tick(); assert.equal(requests, 0);
  assert.equal(f.store.notifications()[0].state, 'CANCELLED');
});

test('default deadline and local option remain webhook-only host restrictions', async t => {
  const f = await fixture(t, () => {});
  const defaults = new Webhooks(f.store);
  assert.equal(defaults.timeoutMs, 10000);
  await assert.rejects(defaults.target(f.url), /WEBHOOK_HOST_NOT_ALLOWED/);
  await assert.rejects(f.hooks.target('http://example.com'), /WEBHOOK_HOST_NOT_ALLOWED/);
  await defaults.close();
});
