'use strict';
const { apiKey, initializePassword, PASSWORD } = require('./helpers/auth.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { ethers } = require('ethers');
const { start } = require('../server.cjs');
const { Store } = require('../store.cjs');
const { localServer } = require('./fixtures/dev-chain.cjs');
const { deployLocal } = require('./fixtures/local-tools.cjs');
const waitFor = async (fn, ms = 3000) => { const until = Date.now() + ms; while (!await fn()) { assert.ok(Date.now() < until, 'condition timed out'); await new Promise(r => setTimeout(r, 10)); } };

test('stored plaintext RPC fails closed and startup releases the owned state lock', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upay-startup-audit-'));
  try {
    const store = new Store(dir); store.set('config', { rpcUrl: 'http://127.0.0.1:1' }); store.close();
    await assert.rejects(start({ dir, port: 0, pollMs: 0, externalWallet: true }), { code: 'RPC_HTTPS_REQUIRED' });
    assert.equal(fs.existsSync(path.join(dir, 'owner.lock')), false);
    const reopened = new Store(dir); reopened.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('audit fixes: isolated HTTPS EVM, durable recovery and HTTP boundaries', { timeout: 90000 }, async t => {
  const local = await localServer(0), provider = new ethers.JsonRpcProvider(local.url, undefined, { cacheTimeout: -1 });
  try {
    assert.equal(Number((await provider.getNetwork()).chainId), 31337);
    const d = await deployLocal(provider), signer = await provider.getSigner(2), from = await signer.getAddress();
    let serial = 0;
    const fixture = async (options = {}) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upay-audit-fix-'));
      const app = await start({ dir, port: 0, externalWallet: true, pollMs: 0, ...options });
      const key = apiKey(dir);
      const api = async (route, body, expected = 200) => {
        for (let attempt = 0; ; attempt++) {
          const response = await fetch(app.url + '/api/' + route, { method: body === undefined ? 'GET' : 'POST',
            headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
          const value = await response.json();
          if (expected !== 409 && value.error === 'BUSY_RETRY_LATER' && attempt < 5) { await new Promise(r => setTimeout(r, 20)); continue; }
          assert.equal(response.status, expected, JSON.stringify(value)); return value;
        }
      };
      await api('config', { rpcUrl: local.url, chainId: 31337, factory: d.factory.target, payout: d.payout, startBlock: 0, confirmations: 1 });
      const order = await api('orders', { reference: 'AUDIT-' + (++serial), token: d.a.target, amount: '1', expiresInSeconds: 1800 }, 201);
      await (await d.a.mint(order.address, 1000000n)).wait();
      let closed = false;
      return { app, dir, api, key, order,
        prepare: () => api('wallet/prepare', { mode: 'paid', from, orderIds: [order.id] }, 201),
        action: (job, action, body = {}, status = 200) => api('wallet/jobs/' + job.id + '/' + action, body, status),
        close: async () => { if (closed) return; closed = true; try { await app.close(); } finally { fs.rmSync(dir, { recursive: true, force: true }); } } };
    };
    const send = async transaction => { const { gas, ...tx } = transaction; const sent = await signer.sendTransaction({ ...tx, gasLimit: gas }); await sent.wait(); return sent; };

    await t.test('prepare and every nested read API are review-only; begin records UNKNOWN before dispatch', async () => {
      const f = await fixture();
      try {
        const p = await f.prepare();
        const views = [p, (await f.api('jobs'))[0], (await f.api('orders/' + f.order.id)).collectionJobs[0]];
        for (const view of views) {
          const check = value => { if (!value || typeof value !== 'object') return; for (const [key, item] of Object.entries(value)) {
            assert.notEqual(key, 'transaction'); assert.notEqual(key, 'data'); assert.notEqual(key, 'nonce'); check(item);
          } }; check(view);
        }
        assert.equal(p.summary.calldataHash, ethers.keccak256(f.app.store.job(p.job.id).data));
        const begun = await f.action(p.job, 'begin');
        assert.equal(f.app.store.job(p.job.id).state, 'UNKNOWN'); assert.equal(begun.transaction.nonce, undefined);
        await (await signer.sendTransaction({ to: from, value: 0n })).wait();
        const sent = await send(begun.transaction);
        const result = await f.action(p.job, 'attach', { transactionHash: sent.hash });
        assert.equal(result.state, 'MINED'); assert.equal(result.nonce, sent.nonce); assert.equal(result.outcome, 'SUCCESS');
      } finally { await f.close(); }
    });

    await t.test('scan contention queues prepare/begin/rejection without stranding PREPARED or UNKNOWN', async () => {
      const f = await fixture();
      try {
        const queued = async (action, before) => {
          let release; const blocker = f.app.merchant.exclusive(() => new Promise(resolve => { release = resolve; }));
          const request = action();
          await waitFor(() => f.app.merchant.waiters.length > 0);
          if (before) before();
          release(); await blocker; return request;
        };
        const p = await queued(() => f.prepare());
        const begun = await queued(() => f.action(p.job, 'begin'), () => assert.equal(f.app.store.job(p.job.id).state, 'PREPARED'));
        assert.equal(begun.job.state, 'UNKNOWN');
        const result = await queued(() => f.action(p.job, 'cancel', { rejected: true }));
        assert.equal(result.state, 'CANCELLED'); assert.equal(f.app.merchant.waiters.length, 0);
      } finally { await f.close(); }
    });

    await t.test('client rejection is audited, late real transaction is observed instead of forgotten', async () => {
      const f = await fixture();
      try {
        const p = await f.prepare(), begun = await f.action(p.job, 'begin');
        const cancelled = await f.action(p.job, 'cancel', { rejected: true });
        assert.equal(cancelled.state, 'CANCELLED'); assert.equal(cancelled.history.at(-1).proofOfNonBroadcast, false);
        const sent = await send(begun.transaction); await f.api('scan', {});
        const job = f.app.store.job(p.job.id);
        assert.equal(job.state, 'MINED'); assert.equal(job.txHash, sent.hash); assert.equal(job.outcome, 'SUCCESS');
        assert.equal(await d.a.balanceOf(f.order.address), 0n);
      } finally { await f.close(); }
    });

    await t.test('wallet cancellation replacement is proven on-chain; replacement reorg restores UNKNOWN without resending', async () => {
      const f = await fixture(); const snapshot = await provider.send('evm_snapshot', []);
      try {
        const p = await f.prepare(), begun = await f.action(p.job, 'begin');
        await provider.send('evm_setAutomine', [false]);
        const original = await signer.sendTransaction({ ...begun.transaction, value: 0n, gasLimit: 2000000n, gasPrice: 2000000000n });
        assert.equal((await f.action(p.job, 'attach', { transactionHash: original.hash })).state, 'SUBMITTED');
        const replacement = await signer.sendTransaction({ to: from, value: 0n, nonce: original.nonce, gasLimit: 21000n, gasPrice: 4000000000n });
        await provider.send('evm_mine', []); await provider.send('evm_setAutomine', [true]);
        await f.api('scan', {});
        const replaced = f.app.store.job(p.job.id);
        assert.equal(replaced.state, 'REPLACED'); assert.equal(replaced.replacementHash, replacement.hash); assert.notEqual(replaced.outcome, 'SUCCESS');
        assert.equal(await d.a.balanceOf(f.order.address), ethers.parseUnits('1', 6));
        assert.equal(await provider.send('evm_revert', [snapshot]), true);
        await f.api('scan', {});
        assert.equal(f.app.store.job(p.job.id).state, 'UNKNOWN');
        assert.equal((await f.api('wallet/prepare', { mode: 'paid', orderIds: [f.order.id], from }, 409)).error, 'TRANSACTION_RECONCILIATION_REQUIRED');
      } finally { await provider.send('evm_setAutomine', [true]); await f.close(); }
    });

    await t.test('manual acknowledgement cannot invent success, known candidate cannot be abandoned, old hash cannot be reused', async () => {
      const f = await fixture();
      try {
        const p = await f.prepare(), begun = await f.action(p.job, 'begin');
        await f.action(p.job, 'resolve', { acknowledge: true }, 400);
        const abandoned = await f.action(p.job, 'resolve', { acknowledge: true, note: '已核对钱包，保留未知风险记录' });
        assert.equal(abandoned.state, 'ABANDONED'); assert.equal(abandoned.outcome, undefined);
        assert.equal(abandoned.history.at(-1).type, 'ADMIN_ABANDONED_UNRESOLVED');
        const sent = await send(begun.transaction); await f.api('scan', {});
        assert.equal(f.app.store.job(p.job.id).state, 'MINED');
        const second = await f.api('wallet/prepare', { mode: 'manual', from, orderIds: [f.order.id] }, 201);
        await f.action(second.job, 'begin');
        await f.api('jobs/' + second.job.id + '/reconcile', { transactionHash: sent.hash }, 400);
        const absent = ethers.id('unseen-' + second.job.id);
        await f.action(second.job, 'attach', { transactionHash: absent });
        await f.action(second.job, 'resolve', { acknowledge: true, note: '不能丢弃已登记的候选交易' }, 409);
        assert.equal(f.app.store.job(second.job.id).state, 'UNKNOWN');
        assert.equal(f.app.store.job(second.job.id).candidateHash, absent);
      } finally { await f.close(); }
    });

    await t.test('unauthenticated resolution blocked; password login tolerates mistakes within rate budget; delivered notification cannot retry', async () => {
      const f = await fixture();
      try {
        const response = await fetch(f.app.url + '/api/wallet/jobs/invalid/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        assert.equal(response.status, 401);
        await initializePassword(f.app, f.dir);
        const login = password => fetch(f.app.url + '/api/login', { method: 'POST', headers: { Origin: f.app.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
        for (let i = 0; i < 8; i++) assert.equal((await login('incorrect')).status, 401);
        assert.equal((await login(PASSWORD)).status, 200);
        // Reset and login share the per-client budget; a correct password cannot bypass it.
        assert.equal((await login(PASSWORD)).status, 429);
        f.app.store.notify({ id: 'audit-delivered', orderId: f.order.id, url: 'https://example.invalid', payload: {}, state: 'DELIVERED', attempts: 1, nextAttempt: 0 });
        assert.equal((await f.api('notifications/audit-delivered/retry', {}, 409)).error, 'NOTIFICATION_NOT_RETRYABLE');
      } finally { await f.close(); }
    });

    await t.test('slow webhook cannot gate automatic chain synchronization or bounded shutdown', async () => {
      const sockets = new Set();
      const receiver = http.createServer((_req, res) => { res.writeHead(200); res.write('x'); const timer = setInterval(() => res.write('x'), 25); res.on('close', () => clearInterval(timer)); });
      receiver.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
      await new Promise(r => receiver.listen(0, '127.0.0.1', r));
      const f = await fixture({ pollMs: 60, allowLocalWebhook: true });
      try {
        await f.api('scan', {});
        const n = { id: 'audit-slow', orderId: f.order.id, url: 'http://127.0.0.1:' + receiver.address().port,
          payload: { type: 'payment.paid', paymentGeneration: f.app.store.order(f.order.id).generation, stateVersion: f.app.store.order(f.order.id).stateVersion }, state: 'PENDING', attempts: 0, nextAttempt: 0 };
        f.app.store.notify(n);
        await waitFor(() => f.app.hooks.running);
        const cursor = f.app.store.get('cursor');
        await provider.send('evm_mine', []); await provider.send('evm_mine', []);
        const head = Number(BigInt(await provider.send('eth_blockNumber', [])));
        await waitFor(() => f.app.store.get('cursor') >= head);
        assert.ok(f.app.store.get('cursor') > cursor); assert.equal(f.app.hooks.running, true);
        const before = Date.now(); await f.close(); assert.ok(Date.now() - before < 3000);
      } finally { await f.close(); for (const socket of sockets) socket.destroy(); await new Promise(r => receiver.close(r)); }
    });
  } finally { provider.destroy(); await local.server.close(); }
});
