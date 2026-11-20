'use strict';
const { apiKey } = require('./helpers/auth.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ethers } = require('ethers');
const { localServer } = require('./fixtures/dev-chain.cjs');
const { deployLocal } = require('./fixtures/local-tools.cjs');
const { start } = require('../server.cjs');

test('quick handoff: real isolated batch receipt closes tunnel; UNKNOWN survives timeout and local reconciliation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upay-quick-integration-'));
  const local = await localServer(0);
  const provider = new ethers.JsonRpcProvider(local.url, undefined, { cacheTimeout: -1 });
  let app, offset = 0;
  try {
    assert.equal(Number((await provider.getNetwork()).chainId), 31337);
    const deployment = await deployLocal(provider), signer = await provider.getSigner(2), from = await signer.getAddress();
    const options = { dir, port: 0, pollMs: 0, externalWallet: true, handoffPort: 0,
      handoffQuick: { workerPath: path.join(__dirname, 'fixtures/fake-tunnel-worker.cjs'), now: () => Date.now() + offset } };
    app = await start(options);
    await app.merchant.configure({ rpcUrl: local.url, chainId: 31337, factory: deployment.factory.target,
      payout: deployment.payout, startBlock: deployment.startBlock, confirmations: 2 });
    const key = apiKey(dir);
    const admin = async (route, body) => {
      const response = await fetch(app.url + '/api/' + route, { method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await response.json(); assert.equal(response.ok, true, JSON.stringify(data)); return data;
    };
    const entry = async (reference, token, expected, payment) => {
      const order = await app.merchant.create({ reference, amount: expected, token: token.target, expiresInSeconds: 1800 });
      await (await token.mint(order.address, ethers.parseUnits(payment, Number(await token.decimals())))).wait();
      return order;
    };
    const send = async tx => {
      const { gas, ...request } = tx;
      const sent = await signer.sendTransaction({ ...request, gasLimit: gas }); await sent.wait(); return sent.hash;
    };
    const call = async (ticket, action, body) => {
      const response = await fetch(app.handoff.localOrigin + '/api/handoffs/' + ticket.id + (action ? '/' + action : ''), {
        method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + new URL(ticket.url).hash.slice(1),
          Origin: new URL(ticket.url).origin, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await response.json(); assert.equal(response.ok, true, JSON.stringify(data)); return data;
    };
    const orders = [await entry('QUICK-EXACT', deployment.a, '1', '1'), await entry('QUICK-EXCESS', deployment.b, '2', '2.1')];
    await provider.send('evm_mine', []);
    const nonce = await signer.getNonce('pending');
    const ticket = await admin('handoffs', { mode: 'paid', orderIds: orders.map(o => o.id) });
    assert.equal(ticket.tunnel.state, 'RUNNING'); assert.equal(app.store.jobs().length, 0);
    assert.equal(await signer.getNonce('pending'), nonce);
    assert.ok(ticket.expiresAt <= Date.now() + 300000);
    await call(ticket, 'prepare', { from });
    const begun = await call(ticket, 'begin', {});
    const hash = await send(begun.transaction);
    const completed = await call(ticket, 'attach', { transactionHash: hash });
    assert.equal(completed.state, 'MINED'); assert.equal(completed.outcome, 'SUCCESS');
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('TUNNEL_DID_NOT_CLOSE_AFTER_RECEIPT')), 3000);
      app.handoff.tunnel.ended.then(() => { clearTimeout(timeout); resolve(); });
    });
    assert.equal(app.handoff.tunnel.status().reason, 'COMPLETED'); assert.equal(app.handoff.tunnel.status().state, 'CLOSED');
    assert.equal(await signer.getNonce('pending'), nonce + 1);
    assert.equal(await deployment.a.balanceOf(deployment.payout), ethers.parseUnits('1', 6));
    assert.equal(await deployment.b.balanceOf(deployment.payout), ethers.parseUnits('2.1', 18));
    assert.equal((await fetch(app.handoff.localOrigin + '/c/' + ticket.id)).status, 410);

    const next = await entry('QUICK-UNKNOWN', deployment.a, '3', '3'); await provider.send('evm_mine', []);
    const second = await admin('handoffs', { mode: 'paid', orderIds: [next.id] });
    await call(second, 'prepare', { from });
    const pending = await call(second, 'begin', {});
    const before = await signer.getNonce('pending');
    offset = 300001; app.handoff.tunnel.tick(); await app.handoff.tunnel.ended;
    assert.equal(app.handoff.tunnel.status().reason, 'TIMEOUT');
    assert.equal(app.store.job(pending.job.id).state, 'UNKNOWN'); assert.equal(await signer.getNonce('pending'), before);
    const lateHash = await send(pending.transaction);
    const recovered = await admin('jobs/' + pending.job.id + '/reconcile', { transactionHash: lateHash });
    assert.equal(recovered.state, 'MINED'); assert.equal(recovered.outcome, 'SUCCESS');
    assert.equal(app.handoff.tunnel.status().state, 'CLOSED'); assert.equal(await signer.getNonce('pending'), before + 1);
    assert.equal(await deployment.a.balanceOf(next.address), 0n);
    assert.equal(app.store.jobs().length, 2);
  } finally { await app?.close(); provider.destroy(); await local.server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
