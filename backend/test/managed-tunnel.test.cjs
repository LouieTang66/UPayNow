'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ManagedTunnel, DURATION_MS } = require('../managed-tunnel.cjs');

function fixture(t, options = {}) {
  const records = new Map(), jobs = new Map();
  const store = {
    handoff: id => records.get(id), job: id => jobs.get(id),
    saveHandoff: record => records.set(record.id, record),
    saveJob: job => jobs.set(job.id, job), transaction: callback => callback()
  };
  const handoff = { store, localOrigin: 'http://127.0.0.1:12345', origin: 'http://127.0.0.1:12345',
    server: { address: () => ({ port: 12345 }) } };
  const clock = { wall: Date.now(), mono: 100 };
  const tunnel = new ManagedTunnel(handoff, {
    workerPath: path.join(__dirname, 'fixtures/fake-tunnel-worker.cjs'),
    now: () => clock.wall, mono: () => clock.mono, ...options
  });
  t.after(async () => { await tunnel.shutdown(); });
  const record = (id = randomUUID(), state) => {
    const r = { id, state: 'READY', expiresAt: clock.wall + DURATION_MS };
    if (state) { r.jobId = randomUUID(); store.saveJob({ id: r.jobId, state }); }
    store.saveHandoff(r); return r;
  };
  const open = async r => {
    const result = await tunnel.open(r.id);
    r.tunnelSessionId = result.id; r.expiresAt = result.expiresAt;
    store.saveHandoff(r); return result;
  };
  return { tunnel, handoff, store, clock, record, open };
}
const error = (code, status = 410) => e => e.code === code && e.status === status;
function exited(worker) {
  assert.ok(worker.exitCode !== null || worker.signalCode !== null, 'worker has exited');
  assert.equal(worker.connected, false);
  assert.throws(() => process.kill(worker.pid, 0), { code: 'ESRCH' });
}

test('initial CLOSED refuses access and shutdown needs no worker', async t => {
  const { tunnel } = fixture(t);
  assert.equal(tunnel.status().state, 'CLOSED');
  assert.equal(tunnel.status().reason, 'NOT_STARTED');
  assert.equal(tunnel.live(), false);
  assert.throws(() => tunnel.requireActive(), error('TUNNEL_CLOSED'));
  await tunnel.shutdown();
  assert.ok(!tunnel.worker);
});

test('open is single-flight, lasts 300000ms and cannot renew a live session', async t => {
  const f = fixture(t), r = f.record();
  assert.equal(DURATION_MS, 300000);
  const opening = f.open(r);
  assert.equal(f.tunnel.status().state, 'STARTING');
  await assert.rejects(f.tunnel.open(r.id), error('TUNNEL_BUSY', 409));
  const result = await opening;
  assert.equal(result.origin, 'https://example-test.trycloudflare.com');
  assert.equal(result.expiresAt, f.clock.wall + 300000);
  assert.equal(f.tunnel.session.monoDeadline, f.clock.mono + 300000);
  assert.equal(f.tunnel.status().state, 'RUNNING');
  assert.doesNotThrow(() => f.tunnel.requireActive(r));
  const worker = f.tunnel.worker;
  f.clock.wall += 1000; f.clock.mono += 1000;
  await assert.rejects(f.tunnel.open(r.id), error('TUNNEL_BUSY', 409));
  assert.equal(f.tunnel.worker, worker);
  assert.equal(f.tunnel.session.id, result.id);
  assert.equal(f.tunnel.status().expiresAt, result.expiresAt);
});

for (const clockKind of ['wall', 'mono']) {
  test(`${clockKind} deadline closes on tick and refuses expired access`, async t => {
    const f = fixture(t), r = f.record(); await f.open(r);
    const worker = f.tunnel.worker;
    f.clock[clockKind] += DURATION_MS - 1;
    assert.equal(f.tunnel.live(), true);
    f.clock[clockKind] += 1;
    assert.equal(f.tunnel.live(), false);
    f.tunnel.tick();
    assert.throws(() => f.tunnel.requireActive(r), error('TUNNEL_CLOSED'));
    await f.tunnel.ended;
    assert.equal(f.tunnel.status().state, 'CLOSED');
    assert.equal(f.tunnel.status().reason, 'TIMEOUT');
    assert.equal(f.store.handoff(r.id).closeReason, 'TIMEOUT');
    assert.equal(f.handoff.origin, f.handoff.localOrigin);
    assert.equal(f.tunnel.worker, null); exited(worker);
  });
}

test('requireActive itself initiates expiry cleanup without waiting for tick', async t => {
  const f = fixture(t), r = f.record(); await f.open(r);
  f.clock.mono += DURATION_MS;
  assert.throws(() => f.tunnel.requireActive(r), error('TUNNEL_EXPIRED'));
  await f.tunnel.ended;
  assert.equal(f.tunnel.status().reason, 'TIMEOUT');
  assert.throws(() => f.tunnel.requireActive(r), error('TUNNEL_CLOSED'));
});

for (const [outcome, reason] of [['SUCCESS', 'COMPLETED'], ['PARTIAL_FAILURE', 'PARTIAL_FAILURE'], ['REVERTED', 'REVERTED']]) {
  test(`MINED ${outcome} closes with ${reason}`, async t => {
    const f = fixture(t), r = f.record(undefined, 'UNKNOWN'); await f.open(r);
    const j = f.store.job(r.jobId); j.state = 'MINED'; j.outcome = outcome; f.store.saveJob(j);
    f.tunnel.tick(); await f.tunnel.ended;
    assert.equal(f.tunnel.status().state, 'CLOSED');
    assert.equal(f.tunnel.status().reason, reason);
    assert.equal(f.store.handoff(r.id).closeReason, reason);
    assert.equal(f.store.job(j.id).state, 'MINED');
    assert.equal(f.store.job(j.id).outcome, outcome);
  });
}

for (const state of ['PREPARED', 'UNKNOWN']) {
  test(`manual close ${state === 'PREPARED' ? 'cancels PREPARED' : 'preserves UNKNOWN'}`, async t => {
    const f = fixture(t), r = f.record(undefined, state); await f.open(r);
    await f.tunnel.close('MANUAL');
    const j = f.store.job(r.jobId);
    assert.equal(j.state, state === 'PREPARED' ? 'CANCELLED' : 'UNKNOWN');
    assert.equal(j.error, state === 'PREPARED' ? 'TUNNEL_CLOSED_BEFORE_SEND' : undefined);
    assert.equal(f.store.handoff(r.id).closedAt, f.clock.wall);
    assert.equal(f.store.handoff(r.id).closeReason, 'MANUAL');
  });
}

test('new link cannot revive old handoff or mismatched tunnel session', async t => {
  const f = fixture(t), old = f.record(); const first = await f.open(old);
  await f.tunnel.close('MANUAL');
  const fresh = f.record(); const second = await f.open(fresh);
  assert.notEqual(second.id, first.id);
  assert.doesNotThrow(() => f.tunnel.requireActive(fresh));
  assert.throws(() => f.tunnel.requireActive(old), error('TUNNEL_CLOSED'));
  assert.equal(f.tunnel.status(old).state, 'CLOSED');
  assert.equal(f.tunnel.status(old).reason, 'MANUAL');
  assert.throws(() => f.tunnel.requireActive({ ...fresh, tunnelSessionId: first.id }), error('TUNNEL_CLOSED'));
});

test('mobile collection rejection remains retryable without extending hard tunnel deadline', async t => {
  const f=fixture(t,{keepRejectedOpen:true}),r=f.record(undefined,'CANCELLED');
  const job=f.store.job(r.jobId);job.error='USER_REJECTED';f.store.saveJob(job);
  await f.open(r);const deadline=f.tunnel.session.monoDeadline;f.tunnel.tick();
  assert.equal(f.tunnel.status().state,'RUNNING');assert.equal(f.tunnel.session.monoDeadline,deadline);
  f.clock.wall+=DURATION_MS+1;f.clock.mono+=DURATION_MS+1;f.tunnel.tick();await f.tunnel.ended;
  assert.equal(f.tunnel.status().reason,'TIMEOUT');assert.equal(f.store.job(job.id).state,'CANCELLED');
});

test('shutdown exits worker, clears monitor and restores local origin', async t => {
  const f = fixture(t), r = f.record(); await f.open(r);
  const worker = f.tunnel.worker;
  await f.tunnel.shutdown();
  assert.equal(f.tunnel.status().state, 'CLOSED');
  assert.equal(f.tunnel.status().reason, 'BACKEND_SHUTDOWN');
  assert.equal(f.tunnel.monitor._destroyed, true);
  assert.equal(f.tunnel.worker, null);
  assert.equal(f.handoff.origin, f.handoff.localOrigin);
  exited(worker);
});

test('real worker reports CLOUDFLARED_NOT_FOUND and leaves no worker behind', async t => {
  const f = fixture(t, { workerPath: path.join(__dirname, '../tunnel-worker.cjs'),
    binary: path.join(__dirname, 'fixtures', `missing-cloudflared-${randomUUID()}`) });
  const r = f.record();
  const opening = f.tunnel.open(r.id), worker = f.tunnel.worker;
  await assert.rejects(opening, error('CLOUDFLARED_NOT_FOUND', 502));
  await f.tunnel.ended;
  assert.equal(f.tunnel.status().state, 'FAILED');
  assert.equal(f.tunnel.status().reason, 'START_FAILED');
  assert.equal(f.tunnel.status().error, 'CLOUDFLARED_NOT_FOUND');
  assert.equal(f.tunnel.worker, null);
  assert.equal(f.handoff.origin, f.handoff.localOrigin);
  assert.throws(() => f.tunnel.requireActive(r), error('TUNNEL_CLOSED'));
  exited(worker);
});
