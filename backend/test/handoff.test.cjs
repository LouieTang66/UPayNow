'use strict';
const { apiKey } = require('./helpers/auth.cjs');
// HTTP + real EVM integration only. No real phone/WalletConnect acceptance is claimed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { ethers } = require('ethers');
const { start } = require('../server.cjs');
const { Handoff } = require('../handoff.cjs');
const { localServer } = require('./fixtures/dev-chain.cjs');
const { deployLocal } = require('./fixtures/local-tools.cjs');

test('handoff: isolated real local EVM, two HTTP listeners and durable SQLite', { timeout: 180000 }, async t => {
  const local = await localServer(0);
  const provider = new ethers.JsonRpcProvider(local.url, undefined, { cacheTimeout: -1 });
  const fixtures = new Set();
  try {
    assert.equal(Number((await provider.getNetwork()).chainId), 31337);
    assert.notEqual(new URL(local.url).port, '18545');
    const deployed = await deployLocal(provider);
    const signer = await provider.getSigner(3), customer = await provider.getSigner(2);
    const from = await signer.getAddress();
    let serial = 0;
    async function request(base, route, data, headers = {}) {
      const response = await fetch(base + route, {
        method: data === undefined ? 'GET' : 'POST',
        headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
        body: data === undefined ? undefined : JSON.stringify(data)
      });
      const text = await response.text();
      let body; try { body = JSON.parse(text); } catch { body = text; }
      return { status: response.status, body, headers: response.headers };
    }
    function expect(reply, status = 200, code) {
      assert.equal(reply.status, status, JSON.stringify(reply.body));
      if (code) assert.equal(reply.body.error, code);
      return reply.body;
    }
    async function fixture() {
      const f = { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'upaynow-handoff-')), app: null };
      fixtures.add(f);
      f.open = async () => {
        f.app = await start({ dir: f.dir, port: 0, handoffPort: 0, pollMs: 0, externalWallet: true,
          privateKey: 'DO_NOT_PARSE_OR_USE_A_BACKEND_KEY' });
        assert.notEqual(new URL(f.app.url).port, '8797');
        assert.notEqual(f.app.url, f.app.handoff.origin);
        f.app.merchant.chain && (f.app.merchant.chain.signer = () => { throw Error('BACKEND_SIGNER_FORBIDDEN'); });
      };
      await f.open();
      f.secret = apiKey(f.dir);
      f.admin = async (route, body, status = 200) => expect(await request(f.app.url, '/api/' + route, body,
        { Authorization: 'Bearer ' + f.secret }), status);
      await f.admin('config', { rpcUrl: local.url, chainId: 31337, factory: deployed.factory.target,
        payout: deployed.payout, startBlock: 0, confirmations: 1 });
      f.app.merchant.chain.signer = () => { throw Error('BACKEND_SIGNER_FORBIDDEN'); };
      f.order = (token = deployed.a, amount = '1') => f.admin('orders', {
        reference: 'HANDOFF-' + (++serial), token: token.target, amount, expiresInSeconds: 86400
      }, 201);
      f.ticket = async (orders, mode = 'paid') => {
        const ticket = await f.admin('handoffs', { mode, orderIds: orders.map(o => o.id) }, 201);
        return { ...ticket, token: new URL(ticket.url).hash.slice(1) };
      };
      f.phone = (ticket, action, body, headers = {}) => request(f.app.handoff.origin,
        '/api/handoffs/' + ticket.id + (action ? '/' + action : ''), body,
        { Authorization: 'Bearer ' + ticket.token, ...(body === undefined ? {} : { Origin: f.app.handoff.origin }), ...headers });
      f.prepare = async ticket => expect(await f.phone(ticket, 'prepare', { from }));
      f.begin = async ticket => expect(await f.phone(ticket, 'begin', {}));
      f.expire = ticket => {
        const record = f.app.store.handoff(ticket.id); record.expiresAt = Date.now() - 1; f.app.store.saveHandoff(record);
      };
      f.restart = async () => { await f.app.close(); f.app = null; await f.open(); };
      f.close = async () => {
        if (f.app) await f.app.close(); f.app = null;
        fs.rmSync(f.dir, { recursive: true, force: true }); fixtures.delete(f);
      };
      return f;
    }
    async function pay(order, amount = '1', token = deployed.a) {
      const units = ethers.parseUnits(amount, Number(await token.decimals()));
      await (await token.mint(await customer.getAddress(), units)).wait();
      await (await token.connect(customer).transfer(order.address, units)).wait();
    }
    async function funded(f) { const order = await f.order(); await pay(order); return order; }
    async function broadcast(transaction) {
      const { gas, ...request } = transaction;
      const sent = await signer.sendTransaction({ ...request, gasLimit: gas });
      const receipt = await sent.wait(); assert.equal(receipt.status, 1);
      return { sent, receipt };
    }
    async function complete(f, ticket, transaction) {
      const { sent, receipt } = await broadcast(transaction);
      const job = expect(await f.phone(ticket, 'attach', { transactionHash: sent.hash }));
      assert.equal(job.state, 'MINED'); assert.equal(job.outcome, 'SUCCESS'); assert.equal(job.txHash, receipt.hash);
      return { job, receipt };
    }

    await t.test('admin-only creation stores snapshot and token hash, no job/nonce; phone exposes approved entries only', async () => {
      const f = await fixture();
      try {
        const approved = await funded(f), hidden = await funded(f);
        const nonce = await signer.getNonce('pending');
        expect(await request(f.app.url, '/api/handoffs', { mode: 'paid', orderIds: [approved.id] }), 401, 'UNAUTHORIZED');
        const ticket = await f.ticket([approved]);
        assert.equal(f.app.store.jobs().length, 0); assert.equal(await signer.getNonce('pending'), nonce);
        assert.match(ticket.qrSvg, /<svg/); assert.equal(ticket.phoneReachable, false);
        const row = f.app.store.db.prepare('SELECT body FROM handoffs WHERE id=?').get(ticket.id).body;
        assert.equal(row.includes(ticket.token), false);
        const stored = JSON.parse(row);
        assert.equal(stored.tokenHash, crypto.createHash('sha256').update(ticket.token).digest('hex'));
        assert.equal(stored.jobId, null); assert.deepEqual(stored.intent.orderIds, [approved.id]);
        const view = expect(await f.phone(ticket));
        assert.deepEqual(view.entries.map(e => e.reference), [approved.reference]);
        for (const privateValue of [ticket.token, stored.tokenHash, hidden.reference, hidden.address, approved.publicToken]) {
          assert.equal(JSON.stringify(view).includes(privateValue), false);
        }
        for (const key of ['intent', 'tokenHash', 'url', 'transaction']) assert.equal(view[key], undefined);
        expect(await f.phone(ticket, undefined, undefined, { Authorization: '' }), 401, 'INVALID_HANDOFF_TOKEN');
        expect(await f.phone(ticket, undefined, undefined, { Authorization: 'Bearer wrong' }), 401, 'INVALID_HANDOFF_TOKEN');
        expect(await f.phone(ticket, 'prepare', { from }, { Authorization: 'Bearer ' + f.secret }), 401, 'INVALID_HANDOFF_TOKEN');
        expect(await request(f.app.url, '/api/handoffs/' + ticket.id + '/revoke', {}), 401, 'UNAUTHORIZED');
      } finally { await f.close(); }
    });

    await t.test('public listener denies administrative APIs, directories, traversal and hostile Host', async () => {
      const f = await fixture();
      try {
        const ticket = await f.ticket([await funded(f)]);
        for (const route of ['/', '/admin.html', '/app.js', '/wallet.js', '/api/orders', '/api/wallet/config',
          '/api/jobs', '/api/status', '/api/config', '/api/login', '/api/handoffs', '/backend/', '/%2e%2e/server.cjs',
          '/legacy', '/legacy/', '/mobile.js', '/style.css', '/checkout.js', '/deploy-mobile.js',
          '/mobile.html', '/public/mobile.js', '/backend/public/mobile.html', '/v2/',
          '/v2/assets/admin.js', '/v2/assets/deploy.js']) {
          expect(await request(f.app.handoff.origin, route, undefined, { Authorization: 'Bearer ' + f.secret }), 404, 'NOT_FOUND');
        }
        const hostile = await new Promise((resolve, reject) => {
          http.get(f.app.handoff.origin + '/c/' + ticket.id, { headers: { Host: 'evil.invalid' } }, response => {
            let text = ''; response.on('data', chunk => { text += chunk; });
            response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
          }).on('error', reject);
        });
        expect(hostile, 403, 'INVALID_HOST');
        for (const route of ['/c/' + ticket.id, '/v2/c/' + ticket.id, '/v2/assets/collect.js',
          '/v2/assets/base.css', '/v2/assets/public.css']) {
          const response = await request(f.app.handoff.origin, route);
          expect(response); assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
          assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
        }
      } finally { await f.close(); }
    });

    await t.test('POST requires exact Origin, JSON object and bounded body; no CORS grants', async () => {
      const f = await fixture();
      try {
        const ticket = await f.ticket([await funded(f)]);
        for (const Origin of ['', 'https://evil.invalid', f.app.url]) {
          const r = await f.phone(ticket, 'prepare', { from }, { Origin });
          expect(r, 403, 'ORIGIN_REQUIRED'); assert.equal(r.headers.get('access-control-allow-origin'), null);
        }
        // Explicitly omit Origin, not just an empty header.
        expect(await request(f.app.handoff.origin, '/api/handoffs/' + ticket.id + '/prepare', { from },
          { Authorization: 'Bearer ' + ticket.token }), 403, 'ORIGIN_REQUIRED');
        expect(await f.phone(ticket, 'prepare', { from }, { 'Content-Type': 'text/plain' }), 415, 'JSON_REQUIRED');
        expect(await f.phone(ticket, 'prepare', []), 400, 'JSON_OBJECT_REQUIRED');
        expect(await f.phone(ticket, 'prepare', { padding: 'x'.repeat(4096) }), 413, 'BODY_TOO_LARGE');
        assert.equal(f.app.store.jobs().length, 0);
      } finally { await f.close(); }
    });

    await t.test('exact/overpaid selected-CA batch uses one real nonce, fixed payout and receipt; other coins untouched', async () => {
      const f = await fixture();
      try {
        const exact = await funded(f), over = await f.order(deployed.b, '2'), under = await f.order();
        await pay(over, '2.5', deployed.b); await pay(exact, '7', deployed.b); await pay(under, '0.5');
        const nonce = await signer.getNonce('pending'), native = await provider.getBalance(from);
        const a = await deployed.a.balanceOf(deployed.payout), b = await deployed.b.balanceOf(deployed.payout);
        const ticket = await f.ticket([exact, over, under]);
        assert.deepEqual(new Set(ticket.entries.map(e => e.reference)), new Set([exact.reference, over.reference]));
        const prepared = await f.prepare(ticket); assert.equal(prepared.job.state, 'PREPARED');
        assert.equal(f.app.store.jobs().length, 1);
        assert.equal(f.app.store.handoff(ticket.id).jobId, prepared.job.id);
        assert.equal(f.app.store.job(prepared.job.id).handoffId, ticket.id);
        const begun = await f.begin(ticket); assert.equal(begun.job.state, 'UNKNOWN');
        assert.equal(await signer.getNonce('pending'), nonce); assert.equal(await provider.getBalance(from), native);
        assert.equal(begun.transaction.to, deployed.factory.target);
        const { job, receipt } = await complete(f, ticket, begun.transaction);
        assert.equal(receipt.to, deployed.factory.target); assert.equal(receipt.from, from);
        assert.equal(job.events.filter(e => e.name === 'Collected').length, 2);
        assert.equal(await signer.getNonce('pending'), nonce + 1);
        assert.equal(await deployed.a.balanceOf(deployed.payout) - a, 1000000n);
        assert.equal(await deployed.b.balanceOf(deployed.payout) - b, ethers.parseUnits('2.5', 18));
        assert.equal(await deployed.a.balanceOf(exact.address), 0n);
        assert.equal(await deployed.b.balanceOf(over.address), 0n);
        assert.equal(await deployed.b.balanceOf(exact.address), ethers.parseUnits('7', 18));
        assert.equal(await deployed.a.balanceOf(under.address), 500000n);
        expect(await f.phone(ticket, 'prepare', { from }), 409, 'HANDOFF_USED');
        assert.equal(f.app.store.jobs().length, 1);
      } finally { await f.close(); }
    });

    await t.test('same sender reuses PREPARED; different sender and every scope override fail closed', async () => {
      const f = await fixture();
      try {
        const ticket = await f.ticket([await funded(f)]), prepared = await f.prepare(ticket);
        const repeated = await f.prepare(ticket);
        assert.equal(repeated.job.id, prepared.job.id); assert.equal(repeated.transaction, undefined); assert.deepEqual(repeated.summary, prepared.summary);
        expect(await f.phone(ticket, 'prepare', { from: await customer.getAddress() }), 409, 'HANDOFF_USED');
        for (const override of [{ orderIds: [] }, { chainId: 97 }, { target: from }, { to: from }, { payout: from },
          { token: deployed.b.target }, { mode: 'manual' }, { factory: from }]) {
          expect(await f.phone(ticket, 'prepare', { from, ...override }), 403, 'HANDOFF_SCOPE_OVERRIDE');
        }
        expect(await f.phone(ticket, 'begin', { from }), 403, 'HANDOFF_SCOPE_OVERRIDE');
        assert.equal(f.app.store.jobs().length, 1);
      } finally { await f.close(); }
    });

    await t.test('expired READY ticket cannot prepare or begin and creates no job', async () => {
      const f = await fixture();
      try {
        const ticket = await f.ticket([await funded(f)]); f.expire(ticket);
        expect(await f.phone(ticket, 'prepare', { from }), 410, 'HANDOFF_EXPIRED');
        expect(await f.phone(ticket, 'begin', {}), 410, 'HANDOFF_EXPIRED');
        assert.equal(f.app.store.jobs().length, 0);
      } finally { await f.close(); }
    });

    await t.test('revoked READY/PREPARED cannot begin; PREPARED revoke cancels and releases global lock', async () => {
      const f = await fixture();
      try {
        const order = await funded(f), ready = await f.ticket([order]);
        await f.admin('handoffs/' + ready.id + '/revoke', {});
        expect(await f.phone(ready, 'prepare', { from }), 410, 'HANDOFF_REVOKED');
        const ticket = await f.ticket([order]), prepared = await f.prepare(ticket);
        await f.admin('handoffs/' + ticket.id + '/revoke', {});
        assert.equal(f.app.store.job(prepared.job.id).state, 'CANCELLED');
        expect(await f.phone(ticket, 'begin', {}), 410, 'HANDOFF_REVOKED');
        const replacement = await f.ticket([order]); assert.equal((await f.prepare(replacement)).job.state, 'PREPARED');
      } finally { await f.close(); }
    });

    await t.test('ticket expiration after PREPARED prevents begin without broadcasting', async () => {
      const f = await fixture();
      try {
        const ticket = await f.ticket([await funded(f)]); await f.prepare(ticket);
        const nonce = await signer.getNonce('pending'); f.expire(ticket);
        expect(await f.phone(ticket, 'begin', {}), 410, 'HANDOFF_EXPIRED');
        expect(await f.phone(ticket, 'prepare', { from }), 410, 'HANDOFF_EXPIRED');
        assert.equal(await signer.getNonce('pending'), nonce);
      } finally { await f.close(); }
    });

    for (const invalidation of ['expire', 'revoke']) {
      await t.test('UNKNOWN survives ' + invalidation + ' and accepts its original real transaction hash', async () => {
        const f = await fixture();
        try {
          const ticket = await f.ticket([await funded(f)]); const prepared = await f.prepare(ticket);
          const begun = await f.begin(ticket);
          if (invalidation === 'expire') f.expire(ticket); else await f.admin('handoffs/' + ticket.id + '/revoke', {});
          assert.equal(f.app.store.job(prepared.job.id).state, 'UNKNOWN');
          assert.equal(expect(await f.phone(ticket)).job.state, 'UNKNOWN');
          expect(await f.phone(ticket, 'prepare', { from }), 410);
          expect(await f.phone(ticket, 'begin', {}), 410);
          await complete(f, ticket, begun.transaction);
        } finally { await f.close(); }
      });
    }

    await t.test('explicit phone rejection (4001 path) releases UNKNOWN but cannot reuse consumed ticket', async () => {
      const f = await fixture();
      try {
        const order = await funded(f), ticket = await f.ticket([order]);
        const nonce = await signer.getNonce('pending'); await f.prepare(ticket); await f.begin(ticket);
        // The dedicated reject endpoint is the phone's explicit 4001 branch; it accepts no provider payload.
        const rejected = expect(await f.phone(ticket, 'reject', {}));
        assert.equal(rejected.state, 'CANCELLED'); assert.equal(rejected.error, 'USER_REJECTED');
        expect(await f.phone(ticket, 'prepare', { from }), 409, 'HANDOFF_USED');
        assert.equal(f.app.store.jobs().length, 1); assert.equal(await signer.getNonce('pending'), nonce);
        const next = await f.ticket([order]); assert.equal((await f.prepare(next)).job.state, 'PREPARED');
      } finally { await f.close(); }
    });

    await t.test('concurrent prepare creates exactly one bound job; PREPARED and UNKNOWN persist restart', async () => {
      const f = await fixture();
      try {
        const ticket = await f.ticket([await funded(f)]);
        const replies = await Promise.all([f.phone(ticket, 'prepare', { from }), f.phone(ticket, 'prepare', { from })]);
        assert.ok(replies.some(r => r.status === 200));
        for (const reply of replies) assert.ok([200, 409].includes(reply.status), JSON.stringify(reply));
        const prepared = replies.find(r => r.status === 200).body;
        for (const reply of replies.filter(r => r.status === 200)) assert.equal(reply.body.job.id, prepared.job.id);
        assert.equal(f.app.store.jobs().length, 1);
        await f.restart();
        assert.equal(f.app.store.handoff(ticket.id).jobId, prepared.job.id);
        assert.equal(f.app.store.job(prepared.job.id).handoffId, ticket.id);
        assert.equal((await f.prepare(ticket)).job.id, prepared.job.id);
        const begun = await f.begin(ticket); await f.restart();
        assert.equal(expect(await f.phone(ticket)).job.state, 'UNKNOWN');
        expect(await f.phone(ticket, 'prepare', { from }), 409, 'HANDOFF_USED');
        assert.equal(f.app.store.jobs().length, 1);
        await complete(f, ticket, begun.transaction);
      } finally { await f.close(); }
    });

    await t.test('manual retry resumes one UNKNOWN/rejected job, keeps original checkpoint and rejects stale rejection', async () => {
      const f = await fixture();
      try {
        const ticket = await f.ticket([await funded(f)]), prepared = await f.prepare(ticket), begun = await f.begin(ticket);
        const original = f.app.store.job(prepared.job.id), nonce = await signer.getNonce('pending');
        const retry = expect(await f.phone(ticket, 'retry', {}));
        assert.equal(retry.job.id, original.id); assert.equal(retry.job.walletRequestRevision, 1);
        assert.equal(retry.transaction.data, begun.transaction.data); assert.equal(retry.transaction.to, begun.transaction.to);
        assert.equal(retry.transaction.nonce, undefined); assert.equal(f.app.store.jobs().length, 1);
        assert.equal(f.app.store.job(original.id).dispatchBlockHash, original.dispatchBlockHash);
        expect(await f.phone(ticket, 'reject', {requestRevision:0}), 409, 'STALE_WALLET_REQUEST');
        assert.equal(f.app.store.job(original.id).state, 'UNKNOWN');
        expect(await f.phone(ticket, 'reject', {requestRevision:1}));
        assert.equal(f.app.store.job(original.id).state, 'CANCELLED');
        const again = expect(await f.phone(ticket, 'retry', {}));
        assert.equal(again.job.walletRequestRevision, 2); assert.equal(again.job.id, original.id);
        assert.equal(f.app.store.job(original.id).watchUntilBlock, undefined);
        assert.equal(await signer.getNonce('pending'), nonce);
        await complete(f, ticket, again.transaction);
        const finished = expect(await f.phone(ticket, 'retry', {}));
        assert.equal(finished.transaction, null); assert.equal(finished.job.state, 'MINED');
        assert.equal(await signer.getNonce('pending'), nonce+1);
      } finally { await f.close(); }
    });

    await t.test('retry retains a late second wallet hash without replacing the canonical original transaction', async () => {
      const f = await fixture();
      try {
        const ticket = await f.ticket([await funded(f)]); await f.prepare(ticket);
        const begun = await f.begin(ticket), retry = expect(await f.phone(ticket, 'retry', {}));
        const first = await broadcast(retry.transaction);
        expect(await f.phone(ticket, 'attach', {transactionHash:first.sent.hash, requestRevision:1}));
        const second = await broadcast(begun.transaction);
        const job = expect(await f.phone(ticket, 'attach', {transactionHash:second.sent.hash, requestRevision:0}));
        assert.equal(job.txHash, first.sent.hash);
        const stored = f.app.store.job(job.id), reports = stored.history.filter(h=>h.type==='CLIENT_REPORTED_WALLET_HASH');
        assert.deepEqual(reports.map(h=>h.hash), [first.sent.hash,second.sent.hash]);
        assert.deepEqual(reports.map(h=>h.revision), [1,0]);
      } finally { await f.close(); }
    });

    await t.test('retry preserves capability/origin/scope/expiry/revoke gates and cannot send a PREPARED job', async () => {
      const f = await fixture();
      try {
        const ticket = await f.ticket([await funded(f)]); await f.prepare(ticket);
        expect(await f.phone(ticket,'retry',{}),409,'WALLET_RETRY_UNAVAILABLE');await f.begin(ticket);
        expect(await f.phone(ticket,'retry',{}, {Authorization:'Bearer wrong'}),401,'INVALID_HANDOFF_TOKEN');
        expect(await f.phone(ticket,'retry',{}, {Origin:'https://wrong.invalid'}),403,'ORIGIN_REQUIRED');
        expect(await f.phone(ticket,'retry',{from}),403,'HANDOFF_SCOPE_OVERRIDE');
        const r=f.app.store.handoff(ticket.id), expiry=r.expiresAt;
        f.expire(ticket);expect(await f.phone(ticket,'retry',{}),410,'HANDOFF_EXPIRED');
        r.expiresAt=expiry;f.app.store.saveHandoff(r);await f.admin('handoffs/'+ticket.id+'/revoke',{});
        expect(await f.phone(ticket,'retry',{}),410,'HANDOFF_REVOKED');
      } finally { await f.close(); }
    });

    await t.test('handoff supports custom chains while preserving scope and origin policy', async () => {
      const f = await fixture();
      try {
        const chain = f.app.merchant.chain, original = chain.config;
        try {
          for (const chainId of [1, 56, 137, 11155111]) {
            chain.config = { ...original, chainId };
            assert.equal(f.app.handoff.chain(), chain);
          }
          chain.config = { ...original, rpcUrl: 'https://not-loopback.invalid/' };
          assert.equal(f.app.handoff.chain(), chain);
          chain.config = { ...original, chainId: 97 };
          assert.equal(f.app.handoff.chain(), chain); // Policy only; no testnet RPC or transaction.
        } finally { chain.config = original; }
        for (const origin of ['http://merchant.invalid', 'ftp://localhost', 'https://u:p@merchant.invalid',
          'https://merchant.invalid/path', 'https://merchant.invalid/?q=x', 'https://merchant.invalid/#secret']) {
          assert.throws(() => new Handoff(f.app.merchant, f.app.handoff.wallet, { origin }), { code: 'INVALID_HANDOFF_ORIGIN' });
        }
        for (const origin of ['https://merchant.invalid', 'http://localhost:1234', 'http://127.0.0.1:1234', 'http://[::1]:1234']) {
          assert.equal(new Handoff(f.app.merchant, f.app.handoff.wallet, { origin }).origin, origin);
        }
      } finally { await f.close(); }
    });
  } finally {
    for (const f of fixtures) { if (f.app) await f.app.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
    provider.destroy(); await local.server.close();
  }
});
