'use strict';
const { apiKey, readAuth, initializePassword, PASSWORD } = require('./helpers/auth.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { ethers } = require('ethers');
const { start } = require('../server.cjs');
const { Store } = require('../store.cjs');
const { localServer } = require('./fixtures/dev-chain.cjs');
const { deployLocal } = require('./fixtures/local-tools.cjs');
const { publicIP, Webhooks } = require('../webhooks.cjs');

test('merchant backend with real local EVM, HTTP and isolated durable storage', { timeout: 120000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upaynow-backend-test-'));
  const local = await localServer(0);
  const provider = new ethers.JsonRpcProvider(local.url, undefined, { cacheTimeout: -1 });
  const received = []; let webhookStatus = 500;
  const receiver = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received.push({ headers: req.headers, body }); res.writeHead(webhookStatus); res.end('received');
  });
  await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
  const webhookUrl = 'http://127.0.0.1:' + receiver.address().port + '/paid';
  let app;
  try {
    const deployed = await deployLocal(provider);
    app = await start({ dir, port: 0, pollMs: 0, allowLocalWebhook: true });
    const secret = apiKey(dir);
    await initializePassword(app, dir);
    const authState = readAuth(dir);
    const api = async (route, data, expected = 200) => {
      const response = await fetch(app.url + '/api/' + route, { method: data === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + secret, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: data === undefined ? undefined : JSON.stringify(data) });
      const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
    };
    // Independent fixture wallet drives the real unsigned HTTP protocol, never a backend signer.
    const externalCollect = async (mode, data, expected = 202) => {
      const signer = await provider.getSigner(0), from = await signer.getAddress();
      const prepared = await api('wallet/prepare', { ...data, mode, from }, expected === 202 ? 201 : expected);
      if (expected !== 202) return prepared;
      if (!prepared.job) return prepared;
      const begun = await api('wallet/jobs/' + prepared.job.id + '/begin', {});
      const { gas, chainId, ...transaction } = begun.transaction;
      assert.equal(Number(BigInt(chainId)), 31337);
      const sent = await signer.sendTransaction({ ...transaction, gasLimit: gas });
      await sent.wait();
      await provider.send('evm_mine', []); // configured depth is two for collection as well as deposits
      const job = await api('wallet/jobs/' + prepared.job.id + '/attach', { transactionHash: sent.hash });
      assert.equal(job.state, 'MINED');
      return mode === 'paid' ? { ...prepared, job } : job;
    };
    const customer = await provider.getSigner(2);
    const pay = async (order, amount, token = deployed.a) => {
      const decimals = Number(await token.decimals()), units = ethers.parseUnits(amount, decimals);
      await (await token.mint(await customer.getAddress(), units)).wait();
      return (await token.connect(customer).transfer(order.address, units)).wait();
    };
    const mine = () => provider.send('evm_mine', []);
    const create = (reference, amount = '1', extra = {}) => api('orders', {
      reference, amount, token: deployed.a.target, expiresInSeconds: 1800, ...extra }, 201);
    let main;

    await t.test('authentication, cookie CSRF, host checks and single-owner storage', async () => {
      assert.equal((await fetch(app.url + '/api/orders')).status, 401);
      assert.throws(() => new Store(dir), /STATE_DIRECTORY_LOCKED/);
      const login = await fetch(app.url + '/api/login', { method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie').split(';')[0];
      assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
      const denied = await fetch(app.url + '/api/scan', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(denied.status, 403);
      const invalidHostStatus = await new Promise((resolve, reject) => {
        http.get(app.url + '/health', { headers: { Host: 'attacker.invalid' } }, response => {
          response.resume(); resolve(response.statusCode);
        }).on('error', reject);
      });
      assert.equal(invalidHostStatus, 403);
      assert.equal((await api('orders', { reference: 'no-config', token: deployed.a.target, amount: '1' }, 409)).error, 'CHAIN_NOT_CONFIGURED');
    });
    await t.test('verify factory payout, chain, immutable CA list and different token decimals', async () => {
      const config = { rpcUrl: local.url, chainId: 31337, factory: deployed.factory.target,
        payout: deployed.payout, startBlock: 0, confirmations: 2 };
      assert.equal((await api('config', { ...config, payout: await customer.getAddress() }, 409)).error, 'FACTORY_IDENTITY_MISMATCH');
      const status = await api('config', config);
      assert.deepEqual(status.config.tokens.map(x => x.decimals), [6, 18]);
      assert.equal(status.config.rpcUrl, undefined);
      assert.equal(status.externalTransactionsEnabled, false);
      await api('scan', {});
    });
    await t.test('durable idempotent order creation, exact decimals and public checkout/real QR without admin fields', async () => {
      main = await create('SHOP-001', '3.5', { webhookUrl });
      const again = await create('SHOP-001', '3.50', { webhookUrl }); assert.equal(again.id, main.id);
    });
    // Explicit conflict/precision checks are kept separate so API assertions cannot swallow a failure.
    await t.test('reject conflicting references and non-decimal/overprecision amounts', async () => {
      assert.equal((await api('orders', { reference: 'SHOP-001', amount: '4', token: deployed.a.target, webhookUrl }, 409)).error, 'REFERENCE_CONFLICT');
      assert.equal((await api('orders', { reference: 'bad-precision', amount: '1.0000001', token: deployed.a.target }, 400)).error, 'INVALID_AMOUNT_PRECISION');
      assert.equal((await api('orders', { reference: 'bad-number', amount: 1, token: deployed.a.target }, 400)).error, 'AMOUNT_MUST_BE_DECIMAL_STRING');
      assert.equal((await api('config', {}, 409)).error, 'CONFIG_LOCKED_BY_EXISTING_ORDERS');
      const pub = await fetch(app.url + '/api/pay/' + main.publicToken); const publicData = await pub.json();
      assert.equal(pub.status, 200); assert.equal(publicData.address, main.address);
      for (const key of ['reference', 'webhookUrl', 'publicToken', 'collectionJobs']) assert.equal(publicData[key], undefined);
      const qr = await fetch(app.url + '/api/pay/' + main.publicToken + '/qr'); assert.match(await qr.text(), /<svg/);
      assert.equal((await fetch(app.url + main.checkoutPath)).status, 200);
      assert.equal(await provider.getCode(main.address), '0x');
    });
    await t.test('partial selected-asset deposits never mix values from another supported asset', async () => {
      await pay(main, '1.25'); await pay(main, '100', deployed.b); await mine();
      await api('scan', {}); const order = await api('orders/' + main.id);
      assert.equal(order.status, 'PARTIAL'); assert.equal(order.confirmedAmount, '1.25');
      assert.deepEqual(order.otherTokens, [deployed.b.target]);
      assert.equal(order.paid, false); assert.equal(received.length, 0);
      const again = await api('scan', {}); assert.equal(again.syncError, null);
      assert.equal((await api('orders/' + main.id)).deposits.length, 2);
    });
    await t.test('actual collection goes directly to payout; zero order balance does not erase previous payment', async () => {
      const before = await deployed.a.balanceOf(deployed.payout);
      const job = await externalCollect('manual', { orderIds: [main.id] }, 202);
      assert.equal(job.state, 'MINED'); assert.equal(job.outcome, 'SUCCESS');
      assert.equal((await deployed.a.balanceOf(deployed.payout)) - before, ethers.parseUnits('1.25', 6));
      assert.equal(await deployed.a.balanceOf(main.address), 0n);
      assert.equal(await deployed.b.balanceOf(main.address), ethers.parseUnits('100', 18));
      assert.equal(await deployed.a.balanceOf(deployed.factory.target), 0n);
      await api('scan', {});
      assert.equal((await api('orders/' + main.id)).confirmedAmount, '1.25');
    });
    await t.test('another supported CA can be normally collected without changing the invoice currency or counting it as payment', async () => {
      const before = await deployed.b.balanceOf(deployed.payout);
      const job = await externalCollect('manual', { orderIds: [main.id], token: deployed.b.target }, 202);
      assert.equal(job.outcome, 'SUCCESS'); assert.equal(job.pairs[0].token, deployed.b.target);
      assert.equal((await deployed.b.balanceOf(deployed.payout)) - before, ethers.parseUnits('100', 18));
      assert.equal(await deployed.b.balanceOf(main.address), 0n);
      await api('scan', {}); const order = await api('orders/' + main.id);
      assert.equal(order.token, deployed.a.target); assert.equal(order.confirmedAmount, '1.25'); assert.equal(order.paid, false);
      assert.equal((await externalCollect('manual', { orderIds: [main.id], token: ethers.ZeroAddress }, 400)).error, 'UNSUPPORTED_COLLECTION_TOKEN');
    });
    await t.test('top-up waits for confirmations; durable signed webhook retries use the same event ID', async () => {
      await pay(main, '2.25'); await api('scan', {});
      assert.equal((await api('orders/' + main.id)).status, 'CONFIRMING');
      await mine(); await api('scan', {});
      await app.hooks.tick();
      const order = await api('orders/' + main.id); assert.equal(order.status, 'PAID');
      assert.equal(order.confirmedAmount, '3.5'); assert.equal(received.length, 1);
      let n = (await api('notifications'))[0]; assert.equal(n.state, 'PENDING'); assert.equal(n.attempts, 1);
      const signatureSecret = fs.readFileSync(path.join(dir, 'webhook.secret'), 'utf8').trim();
      const first = received[0];
      assert.equal(first.headers['x-upaynow-signature'], crypto.createHmac('sha256', signatureSecret)
        .update(first.headers['x-upaynow-timestamp'] + '.' + first.body).digest('hex'));
      assert.equal(JSON.parse(first.body).confirmedUnits, ethers.parseUnits('3.5', 6).toString());
      webhookStatus = 200; n.nextAttempt = 0; app.store.notify(n); await api('scan', {}); await app.hooks.tick();
      assert.equal(received.length, 2); assert.equal(received[0].body, received[1].body);
      assert.equal(received[0].headers['x-upaynow-event'], received[1].headers['x-upaynow-event']);
      assert.equal((await api('notifications'))[0].state, 'DELIVERED');
      await api('scan', {}); assert.equal(received.length, 2);
    });
    await t.test('batch receipts distinguish successful and blocked orders instead of treating outer success as all success', async () => {
      const good = await create('BATCH-GOOD'), bad = await create('BATCH-BAD');
      await pay(good, '1'); await pay(bad, '1');
      await (await deployed.a.setBlocked(bad.address, true)).wait();
      const job = await externalCollect('manual', { orderIds: [good.id, bad.id] }, 202);
      assert.equal(job.outcome, 'PARTIAL_FAILURE');
      assert.ok(job.events.some(e => e.name === 'Collected' && e.orderHash === good.orderHash));
      assert.ok(job.events.some(e => e.name === 'CollectFailed' && e.orderHash === bad.orderHash));
      assert.equal(await deployed.a.balanceOf(bad.address), ethers.parseUnits('1', 6));
      assert.equal(await deployed.a.balanceOf(good.address), 0n);
    });
    await t.test('manual wrong-token collection is explicit, rejects all supported CAs, and cannot change payout', async () => {
      assert.equal((await externalCollect('manual', { orderIds: [main.id], wrongToken: deployed.b.target, confirmWrongToken: true }, 400)).error, 'SUPPORTED_TOKEN_USE_NORMAL_COLLECTION');
      const fixture = deployed.artifacts.token;
      const wrong = await new ethers.ContractFactory(fixture.abi, fixture.evm.bytecode.object, customer).deploy('WRONG', 6);
      await wrong.waitForDeployment(); await pay(main, '2', wrong);
      assert.equal((await externalCollect('manual', { orderIds: [main.id], wrongToken: wrong.target }, 400)).error, 'WRONG_TOKEN_CONFIRMATION_REQUIRED');
      const before = await wrong.balanceOf(deployed.payout);
      const job = await externalCollect('manual', { orderIds: [main.id], wrongToken: wrong.target, confirmWrongToken: true }, 202);
      assert.equal(job.outcome, 'SUCCESS');
      assert.equal((await wrong.balanceOf(deployed.payout)) - before, ethers.parseUnits('2', 6));
      assert.equal(await wrong.balanceOf(main.address), 0n);
    });
    await t.test('actual local chain reorg removes orphaned incoming transfers and reverses payment state', async () => {
      await api('scan', {});
      const snapshot = await provider.send('evm_snapshot', []);
      const order = await create('REORG', '1', { webhookUrl }); await pay(order, '1'); await mine(); await api('scan', {});
      assert.equal(JSON.parse(received.at(-1).body).type, 'payment.paid');
      assert.equal((await api('orders/' + order.id)).paid, true);
      assert.equal(await provider.send('evm_revert', [snapshot]), true); await mine();
      await api('scan', {});
      const reverted = await api('orders/' + order.id);
      assert.equal(reverted.paid, false); assert.equal(reverted.confirmedAmount, '0.0');
      assert.equal(reverted.deposits.length, 0);
      const reversal = JSON.parse(received.at(-1).body);
      assert.equal(reversal.type, 'payment.reversed'); assert.equal(reversal.orderId, order.id);
      assert.ok(reversal.stateVersion > JSON.parse(received.at(-2).body).stateVersion);
    });
    await t.test('one-click collection includes exact/overpaid invoices and sub-invoice remainders, excluding unpaid/wrong/empty balances', async () => {
      const a = await create('EXCESS-A', '10');
      const b = await create('EXCESS-B', '2', { token: deployed.b.target });
      const exact = await create('EXCESS-EXACT', '10'), under = await create('EXCESS-UNDER', '10');
      const wrong = await create('EXCESS-WRONG', '10'), empty = await create('EXCESS-EMPTY');
      const pending = await create('EXCESS-PENDING', '10');
      await pay(a, '10.1'); await pay(a, '7', deployed.b); await pay(b, '2.01', deployed.b);
      await pay(exact, '10'); await pay(under, '9'); await pay(wrong, '100', deployed.b);
      await pay(empty, '2'); await externalCollect('manual', { orderIds: [empty.id] }, 202);
      await mine(); await pay(pending, '11');
      const signer = await provider.getSigner(0), nonce = await signer.getNonce('pending');
      const blocked = app.store.reference('BATCH-BAD');
      const preview = await api('collect-all/preview', {});
      assert.equal(preview.policy, 'CONFIRMED_PAID'); assert.equal(preview.payout, deployed.payout);
      assert.deepEqual(new Set(preview.entries.map(o => o.id)), new Set([main.id, a.id, b.id, exact.id, blocked.id]));
      assert.equal(await signer.getNonce('pending'), nonce, 'preview must not sign or broadcast');
      const beforeA = await deployed.a.balanceOf(deployed.payout), beforeB = await deployed.b.balanceOf(deployed.payout);
      const result = await externalCollect('paid', { orderIds: [main.id, a.id, b.id, exact.id, blocked.id, under.id, wrong.id, empty.id, pending.id] }, 202);
      assert.equal(result.skipped, 4); assert.equal(result.job.outcome, 'PARTIAL_FAILURE');
      assert.ok(result.job.events.some(e => e.name === 'CollectFailed' && e.orderHash === blocked.orderHash));
      assert.deepEqual(new Set(result.job.pairs.map(p => p.token)), new Set([deployed.a.target, deployed.b.target]));
      assert.equal((await deployed.a.balanceOf(deployed.payout)) - beforeA, ethers.parseUnits('10.1', 6) + ethers.parseUnits('10', 6) + ethers.parseUnits('2.25', 6));
      assert.equal((await deployed.b.balanceOf(deployed.payout)) - beforeB, ethers.parseUnits('2.01', 18));
      assert.equal(await deployed.a.balanceOf(a.address), 0n); assert.equal(await deployed.b.balanceOf(b.address), 0n);
      assert.equal(await deployed.b.balanceOf(a.address), ethers.parseUnits('7', 18), 'other CA at an eligible address must remain untouched');
      assert.equal(await deployed.a.balanceOf(exact.address), 0n);
      assert.equal(await deployed.a.balanceOf(main.address), 0n, 'paid invoice remainder below its price must also be swept');
      assert.equal(await deployed.a.balanceOf(under.address), ethers.parseUnits('9', 6));
      assert.equal(await deployed.b.balanceOf(wrong.address), ethers.parseUnits('100', 18));
      assert.equal(await deployed.a.balanceOf(pending.address), ethers.parseUnits('11', 6));
      const nonceAfter = await signer.getNonce('pending'); assert.equal(nonceAfter, nonce + 1);
      const repeated = await externalCollect('paid', { orderIds: [main.id, a.id, b.id, exact.id] }, 202);
      assert.equal(repeated.job, null); assert.equal(repeated.skipped, 4);
      assert.equal(await signer.getNonce('pending'), nonceAfter, 'empty retry must not spend gas');
      assert.equal((await externalCollect('paid', { orderIds: [a.id, a.id] }, 400)).error, 'DUPLICATE_ORDER_IDS');
    });
    await t.test('late funds are recorded separately and do not complete the invoice', async () => {
      const late = await create('LATE', '1', { expiresInSeconds: 1 });
      await provider.send('evm_increaseTime', [3600]); await pay(late, '1'); await mine(); await api('scan', {});
      const order = await api('orders/' + late.id);
      assert.equal(order.paid, false); assert.equal(order.status, 'LATE_PAYMENT');
      assert.equal(order.lateAmount, '1.0'); assert.equal(order.confirmedAmount, '0.0');
    });
    await t.test('unknown outgoing transaction blocks resubmission; wrong receipt cannot resolve it', async () => {
      const unknown = { id: crypto.randomUUID(), state: 'UNKNOWN', orderIds: [main.id], txHash: null, events: [], nonce: 0, from: await customer.getAddress(), data: '0x' };
      const unrelated = (await api('jobs')).find(j => j.state === 'MINED');
      app.store.saveJob(unknown);
      assert.equal((await externalCollect('manual', { orderIds: [main.id] }, 409)).error, 'TRANSACTION_RECONCILIATION_REQUIRED');
      const preview = await api('collect-all/preview', {});
      assert.equal(preview.heldCount, 1);
      assert(!preview.entries.some(o => o.id === main.id));
      assert.equal((await externalCollect('paid', { orderIds: [main.id] }, 409)).error, 'TRANSACTION_RECONCILIATION_REQUIRED');
      assert.equal((await api('jobs/' + unknown.id + '/reconcile', { transactionHash: unrelated.txHash }, 400)).error, 'TRANSACTION_DOES_NOT_MATCH_JOB');
      assert.equal(app.store.job(unknown.id).state, 'UNKNOWN');
    });
    await t.test('durable restart preserves orders, payment ledger, jobs and separated credentials', async () => {
      await app.close(); app = await start({ dir, port: 0, pollMs: 0, allowLocalWebhook: true });
      assert.equal((await api('orders/' + main.id)).confirmedAmount, '3.5');
      assert.ok((await api('jobs')).some(j => j.state === 'UNKNOWN'));
      assert.deepEqual(readAuth(dir), authState);
      const login = await fetch(app.url + '/api/login', { method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
      assert.equal(login.status, 200);
    });
    await t.test('webhook allowlist and private-network rejection are fail-closed outside isolated test mode', async () => {
      for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fc00::1', '::ffff:127.0.0.1']) assert.equal(publicIP(ip), false, ip);
      assert.equal(publicIP('8.8.8.8'), true);
      const realPolicy = new Webhooks(app.store);
      await assert.rejects(realPolicy.target(webhookUrl), e => e.code === 'WEBHOOK_HOST_NOT_ALLOWED');
      await assert.rejects(realPolicy.target('https://user:password@example.com/'), e => e.code === 'INVALID_WEBHOOK_URL');
    });
  } finally {
    if (app) await app.close();
    provider.destroy(); await local.server.close(); await new Promise(resolve => receiver.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
