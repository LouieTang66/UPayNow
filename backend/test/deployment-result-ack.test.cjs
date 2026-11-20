'use strict';
// Local HTTP + owned fake tunnel worker; no public tunnel, RPC or wallet transaction.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DeploymentHandoff } = require('../deployment-handoff.cjs');
const { DURATION_MS } = require('../managed-tunnel.cjs');
async function fixture(t) {
  const metadata = new Map(), id = randomUUID();
  const job = { id, state: 'READY', summary: { chainId: 97 }, factory: '0x' + '1'.repeat(40), deploymentId: 'fixture' };
  const database = { get: (k, fallback) => structuredClone(metadata.has(k) ? metadata.get(k) : fallback),
    set: (k, value) => metadata.set(k, structuredClone(value)), transaction: fn => fn() };
  const service = { record: () => structuredClone(job), save: r => Object.assign(job, r), get: async () => structuredClone(job) };
  const clock = { wall: Date.now(), mono: 100 };
  const handoff = new DeploymentHandoff(service, database, { quick: {
    workerPath: path.join(__dirname, 'fixtures/fake-tunnel-worker.cjs'), now: () => clock.wall, mono: () => clock.mono } });
  clearInterval(handoff.tunnel.monitor); // Deterministic monitor ticks; production watchdog still tested separately.
  await handoff.listen(0);
  t.after(() => handoff.close());
  const link = await handoff.create(id), token = new URL(link.url).hash.slice(1);
  async function request(action = '', { data, authorization = token, origin = handoff.origin } = {}) {
    const response = await fetch(`${handoff.localOrigin}/api/deploy/${id}${action}`, {
      method: data === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + authorization,
        Origin: origin, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: response.status, value: await response.json() };
  }
  return { handoff, request, job, clock };
}
test('terminal result remains readable until scoped phone acknowledges; premature or unauthorized ACK cannot close it', async t => {
  const f = await fixture(t);
  f.job.state = 'UNKNOWN';
  assert.equal((await f.request('/ack', { data: {} })).status, 409);
  assert.equal(f.handoff.store.handoff(f.job.id).resultAcknowledgedAt, undefined);
  f.job.state = 'MINED'; f.job.outcome = 'SUCCESS';
  f.handoff.tunnel.tick();
  assert.equal(f.handoff.tunnel.status().state, 'RUNNING');
  const result = await f.request();
  assert.equal(result.status, 200); assert.equal(result.value.state, 'MINED'); assert.equal(result.value.outcome, 'SUCCESS');
  assert.equal((await f.request('/ack', { data: {}, authorization: 'wrong' })).status, 401);
  assert.equal((await f.request('/ack', { data: {}, origin: 'https://wrong.example' })).status, 403);
  assert.equal((await f.request('/ack', { data: { chainId: 1 } })).status, 403);
  assert.equal(f.handoff.store.handoff(f.job.id).resultAcknowledgedAt, undefined);
  assert.deepEqual(await f.request('/ack', { data: {} }), { status: 200, value: { ok: true } });
  assert.ok(f.handoff.store.handoff(f.job.id).resultAcknowledgedAt);
  f.handoff.tunnel.tick(); await f.handoff.tunnel.ended;
  assert.equal(f.handoff.tunnel.status().reason, 'COMPLETED');
  assert.equal((await f.request()).status, 410);
});
for (const state of ['MINED', 'UNKNOWN']) test(`hard deadline still closes ${state} without ACK, never releases or resends transaction`, async t => {
  const f = await fixture(t); f.job.state = state; f.job.outcome = state === 'MINED' ? 'SUCCESS' : undefined;
  f.handoff.tunnel.tick(); assert.equal(f.handoff.tunnel.status().state, 'RUNNING');
  f.clock.mono += DURATION_MS;
  f.handoff.tunnel.tick(); await f.handoff.tunnel.ended;
  assert.equal(f.handoff.tunnel.status().reason, 'TIMEOUT');
  assert.equal(f.job.state, state); assert.equal((await f.request()).status, 410);
});
test('rejected result also remains readable until phone ACK', async t => {
  const f = await fixture(t); f.job.state = 'CANCELLED'; f.job.outcome = 'REJECTED';
  f.handoff.tunnel.tick(); assert.equal(f.handoff.tunnel.status().state, 'RUNNING');
  assert.equal((await f.request()).value.state, 'CANCELLED');
  assert.equal((await f.request('/ack', { data: {} })).status, 200);
  f.handoff.tunnel.tick(); await f.handoff.tunnel.ended;
  assert.equal(f.handoff.tunnel.status().reason, 'REJECTED');
});
