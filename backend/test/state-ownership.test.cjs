'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');
const { acquireStateOwnership } = require('../state-ownership.cjs');
const { Store } = require('../store.cjs');

const storePath = require.resolve('../store.cjs');
const required = { requireGuard: true };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upay-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function supportsGuard(t, dir) {
  try { acquireStateOwnership(dir, required)(); return true; }
  catch (e) {
    if (e.code !== 'STATE_GUARD_UNAVAILABLE') throw e;
    t.skip('local Linux guard not available here');
    return false;
  }
}
function child(dir, { write = false } = {}) {
  const proc = spawn(process.execPath, ['-e', `
    const { Store } = require(process.argv[1]);
    try {
      const store = new Store(process.argv[2]);
      if (process.argv[3] === 'write') store.set('saved', 17);
      process.send({ outcome: 'open', prior: store.get('saved') });
      process.on('message', () => { store.close(); process.exit(0); });
    } catch (error) { process.send({ outcome: error.code || error.message }, () => process.exit(2)); }
  `, storePath, dir, write ? 'write' : 'read'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  return { proc, result: once(proc, 'message').then(([msg]) => msg), done: once(proc, 'exit') };
}

test('real SIGKILL releases the guard, persists SQLite state, and allows only one restart', { timeout: 12000 }, async t => {
  const dir = fixture(t);
  if (!supportsGuard(t, dir)) return;
  const first = child(dir, { write: true });
  t.after(() => { if (first.proc.exitCode === null && first.proc.signalCode === null) first.proc.kill('SIGKILL'); });
  assert.deepEqual(await first.result, { outcome: 'open', prior: 17 });
  assert.throws(() => fs.openSync(path.join(dir, 'owner.lock'), 'wx'), { code: 'EEXIST' }); // 0.2.0 acquisition
  first.proc.kill('SIGKILL');
  assert.deepEqual(await first.done, [null, 'SIGKILL']);
  assert.equal(fs.existsSync(path.join(dir, 'owner.lock')), true);
  assert.throws(() => acquireStateOwnership(dir, { requireGuard: true, recoverStale: false }), { code: 'STATE_DIRECTORY_LOCKED' });
  const restarts = [child(dir), child(dir)];
  for (const c of restarts) t.after(() => { if (c.proc.exitCode === null && c.proc.signalCode === null) c.proc.kill('SIGKILL'); });
  const out = await Promise.all(restarts.map(c => c.result));
  assert.equal(out.filter(x => x.outcome === 'open').length, 1);
  assert.equal(out.filter(x => x.outcome === 'STATE_DIRECTORY_LOCKED').length, 1);
  const winner = out.findIndex(x => x.outcome === 'open');
  assert.equal(out[winner].prior, 17);
  restarts[winner].proc.send('close');
  assert.deepEqual(await Promise.all(restarts.map(c => c.done)), winner === 0 ? [[0, null], [2, null]] : [[2, null], [0, null]]);
  assert.equal(fs.existsSync(path.join(dir, 'owner.lock')), false);
  assert.equal(fs.existsSync(path.join(dir, 'owner.guard')), true);
});

test('legacy, malformed, different boot/namespace, and current-owner sentinels are never reaped', t => {
  const dir = fixture(t);
  if (!supportsGuard(t, dir)) return;
  const lock = path.join(dir, 'owner.lock');
  const release = acquireStateOwnership(dir, required);
  const identity = JSON.parse(fs.readFileSync(lock, 'utf8'));
  release();
  for (const text of [
    JSON.stringify({ pid: 2147483647, nonce: identity.nonce }),
    '{"version":2,',
    JSON.stringify({ ...identity, bootId: '00000000-0000-0000-0000-000000000000' }),
    JSON.stringify({ ...identity, pidNamespace: 'pid:[1]' }),
    JSON.stringify(identity),
  ]) {
    fs.writeFileSync(lock, text, { mode: 0o600 });
    assert.throws(() => acquireStateOwnership(dir, required), { code: 'STATE_DIRECTORY_LOCKED' });
    assert.equal(fs.readFileSync(lock, 'utf8'), text);
    fs.unlinkSync(lock);
  }
  const other = path.join(dir, 'unrelated');
  fs.writeFileSync(other, 'unchanged');
  fs.symlinkSync(other, lock);
  assert.throws(() => acquireStateOwnership(dir, required), { code: 'STATE_DIRECTORY_LOCKED' });
  assert.equal(fs.readFileSync(other, 'utf8'), 'unchanged');
});

test('recognized PID reuse and a kill during metadata publication are recoverable', t => {
  const dir = fixture(t);
  if (!supportsGuard(t, dir)) return;
  const lock = path.join(dir, 'owner.lock');
  const release = acquireStateOwnership(dir, required);
  const identity = JSON.parse(fs.readFileSync(lock, 'utf8'));
  release();
  const temporary = path.join(dir, '.owner-' + identity.nonce);
  fs.writeFileSync(temporary, JSON.stringify({ ...identity, startTicks: '0' }), { mode: 0o600 });
  fs.linkSync(temporary, lock);
  const recovered = acquireStateOwnership(dir, required);
  assert.equal(fs.existsSync(temporary), false);
  assert.notEqual(JSON.parse(fs.readFileSync(lock, 'utf8')).nonce, identity.nonce);
  recovered();
});

test('database setup failure does not strand ownership in the still-running process', t => {
  const dir = fixture(t);
  const db = path.join(dir, 'merchant.sqlite');
  fs.mkdirSync(db);
  assert.throws(() => new Store(dir), /database file/);
  assert.equal(fs.existsSync(path.join(dir, 'owner.lock')), false);
  fs.rmdirSync(db);
  const store = new Store(dir);
  store.close();
});

test('unsupported filesystem uses the old exclusion and never attempts stale recovery', t => {
  const dir = fixture(t);
  t.mock.method(fs, 'statfsSync', () => ({ type: 0x6969 })); // NFS magic
  assert.throws(() => acquireStateOwnership(dir, required), { code: 'STATE_GUARD_UNAVAILABLE' });
  const release = acquireStateOwnership(dir);
  assert.equal(fs.existsSync(path.join(dir, 'owner.guard')), false);
  assert.throws(() => acquireStateOwnership(dir), { code: 'STATE_DIRECTORY_LOCKED' });
  release();
  const legacy = JSON.stringify({ pid: 2147483647, nonce: 'e'.repeat(32) });
  const lock = path.join(dir, 'owner.lock');
  fs.writeFileSync(lock, legacy);
  assert.throws(() => acquireStateOwnership(dir), { code: 'STATE_DIRECTORY_LOCKED' });
  assert.equal(fs.readFileSync(lock, 'utf8'), legacy);
});

test('the HTTP service restarts after SIGKILL without changing the isolated state', { timeout: 12000 }, async t => {
  const dir = fixture(t);
  if (!supportsGuard(t, dir)) return;
  const serverPath = require.resolve('../server.cjs');
  function launch() {
    const proc = spawn(process.execPath, ['-e', `
      const { start } = require(process.argv[1]);
      start({ dir: process.argv[2], port: 0, multiChain: true, pollMs: 0 }).then(app => {
        process.send({ url: app.url });
        process.on('message', async () => { await app.close(); process.exit(0); });
      }, error => process.send({ error: error.code ?? error.message }, () => process.exit(2)));
    `, serverPath, dir], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    t.after(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); });
    return { proc, ready: once(proc, 'message').then(([msg]) => msg), done: once(proc, 'exit') };
  }
  const first = launch();
  const { url } = await first.ready;
  const health = await (await fetch(url + '/health')).json();
  assert.equal(health.ok, true);
  const authFile = path.join(dir, 'auth.json');
  const auth = fs.readFileSync(authFile);
  first.proc.kill('SIGKILL');
  await first.done;
  const second = launch();
  const { url: restarted } = await second.ready;
  assert.deepEqual(await (await fetch(restarted + '/health')).json(), health);
  assert.deepEqual(fs.readFileSync(authFile), auth);
  second.proc.send('close');
  assert.deepEqual(await second.done, [0, null]);
});
