'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ManagedTunnel } = require('../managed-tunnel.cjs');
test('SIGKILL of worker also cleans its owned detached connector (no public tunnel)', { skip: process.platform === 'win32', timeout: 10000 }, async () => {
  const record = { id: 'orphan-test' };
  const handoff = { store: { handoff: () => record, transaction: fn => fn(), saveHandoff: () => {} },
    server: { address: () => ({ port: 12345 }) }, localOrigin: 'http://127.0.0.1:12345' };
  const manager = new ManagedTunnel(handoff, { workerPath: path.join(__dirname, 'fixtures/orphan-tunnel-worker.cjs') });
  let pid;
  try {
    const opening = manager.open(record.id);
    manager.worker.on('message', message => { if (message.type === 'connector') pid = message.pid; });
    await opening; assert.ok(Number.isSafeInteger(pid));
    process.kill(pid, 0); manager.worker.kill('SIGKILL'); await manager.ended;
    const until = Date.now() + 3000;
    for (;;) {
      try { process.kill(pid, 0); } catch (error) { assert.equal(error.code, 'ESRCH'); break; }
      assert.ok(Date.now() < until, 'orphan connector was not terminated'); await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(manager.status().state, 'CLOSED');
  } finally { await manager.shutdown(); if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } } }
});
