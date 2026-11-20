'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { ethers } = require('ethers');
const { localArtifacts } = require('./fixtures/local-tools.cjs');
const { isolatedChain } = require('./fixtures/multichain-local.cjs');
const { start } = require('../../ops-public-deployer/server.cjs');
const D = require('../deterministic.cjs');
test('ops phone: scoped QR, durable UNKNOWN, explicit rejection, real local root deployment and recovery', { timeout: 90000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upay-ops-phone-'));
  const c = await isolatedChain(31340, localArtifacts());
  const options = { phone: { dir, quick: false, origin: 'https://ops-phone.example.test' } };
  let app = await start(0, options), ticket, begun;
  const input = { chainId: c.chainId, rpcUrl: c.url };
  const desk = async (route, data, origin = app.url) => {
    const r = await fetch(app.url + '/api/' + route, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: r.status, body: await r.json() };
  };
  const phone = async (action = '', data, token) => {
    const u = new URL(ticket.url), headers = { Authorization: 'Bearer ' + (token === undefined ? u.hash.slice(1) : token) };
    if (data !== undefined) { headers.Origin = options.phone.origin; headers['Content-Type'] = 'application/json'; }
    const r = await fetch(app.phone.localOrigin + '/api/ops/' + ticket.id + (action ? '/' + action : ''),
      { method: data === undefined ? 'GET' : 'POST', headers, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: r.status, body: await r.json() };
  };
  try {
    await c.evm.request({ method: 'hardhat_setCode', params: [D.SINGLETON, D.SINGLETON_RUNTIME] });
    await t.test('desktop same-origin, restricted ticket and public static page; no RPC in phone view', async () => {
      assert.equal((await desk('phone', input, 'https://evil.test')).status, 403);
      assert.equal(app.phone, undefined);
      const made = await desk('phone', input); assert.equal(made.status, 200, JSON.stringify(made.body)); ticket = made.body;
      assert.match(ticket.qrSvg, /<svg/); assert.match(ticket.url, /^https:\/\/ops-phone\.example\.test\/o\/[a-f0-9-]{36}#[a-zA-Z0-9_-]{43}$/);
      assert.ok(ticket.expiresAt > Date.now() && ticket.expiresAt <= Date.now() + 300000);
      assert.equal((await phone('', undefined, '')).status, 401);
      const view = await phone(); assert.equal(view.status, 200); assert.equal(view.body.chainId, c.chainId); assert.equal(view.body.state, 'READY');
      assert.equal(view.body.rpcUrl, undefined); assert.ok(!JSON.stringify(view.body).includes(c.url));
      const p = app.phone.localOrigin;
      assert.equal((await fetch(p + '/o/' + ticket.id)).status, 200); assert.equal((await fetch(p + '/phone.js')).status, 200);
      assert.equal((await fetch(p + '/api/prepare')).status, 404); assert.equal((await fetch(p + '/api/deployment-jobs')).status, 404);
      assert.equal((await phone('begin', { from: c.payout, rpcUrl: c.url })).status, 403);
    });
    const signer = await c.provider.getSigner(1), nonce = await signer.getNonce();
    await t.test('begin returns fixed tx once; rejection retry is revision-bound and makes no broadcast', async () => {
      const result = await phone('begin', { from: c.payout }); assert.equal(result.status, 200, JSON.stringify(result.body)); begun = result.body;
      assert.equal(begun.state, 'UNKNOWN'); assert.equal(begun.transaction.to, D.SINGLETON); assert.equal(begun.transaction.value, '0x0');
      assert.equal(begun.transaction.chainId, ethers.toQuantity(c.chainId)); assert.equal(await signer.getNonce(), nonce);
      assert.equal((await phone('begin', { from: c.payout })).status, 409);
      assert.equal((await desk('phone', input)).body.error, 'OPS_SEND_UNRESOLVED');
      assert.equal((await phone('reject', { requestRevision: 0 })).status, 409);
      assert.equal((await phone('reject', { requestRevision: begun.requestRevision })).body.state, 'READY');
      const previous = begun.requestRevision; begun = (await phone('begin', { from: c.payout })).body;
      assert.equal(begun.requestRevision, previous + 1); assert.equal((await phone('reject', { requestRevision: previous })).status, 409);
      assert.equal(await signer.getNonce(), nonce);
    });
    await t.test('UNKNOWN survives independent ops restart; no new ticket or implicit transaction', async () => {
      await app.close(); app = await start(0, options);
      assert.equal(app.phone, undefined);
      assert.equal((await desk('prepare', { ...input, from: c.payout })).body.error, 'OPS_SEND_UNRESOLVED');
      assert.equal((await desk('phone', input)).body.error, 'OPS_SEND_UNRESOLVED');
      assert.equal((await desk('phone/status', { id: ticket.id })).body.state, 'UNKNOWN');
      assert.equal(await signer.getNonce(), nonce);
      await app.phone.listen(0); // Local fixture reopens its isolated phone listener, no public tunnel.
    });
    await t.test('real local wallet deployment, hash attach, fixed-runtime verification and result ack', async () => {
      const { gas, ...tx } = begun.transaction;
      const sent = await signer.sendTransaction({ ...tx, gasLimit: gas }); assert.equal((await sent.wait()).status, 1);
      const attached = await phone('attach', { transactionHash: sent.hash, requestRevision: begun.requestRevision });
      assert.equal(attached.status, 200, JSON.stringify(attached.body)); assert.equal(attached.body.ready, true); assert.equal(attached.body.state, 'MINED');
      assert.equal(attached.body.hash, sent.hash.toLowerCase()); assert.equal(await signer.getNonce(), nonce + 1);
      assert.equal((await phone('begin', { from: c.payout })).status, 409);
      assert.equal((await phone('ack', {})).status, 200);
      assert.ok(app.phone.record(ticket.id).resultAcknowledgedAt);
      assert.equal((await desk('phone', input)).body.error, 'OPS_ALREADY_READY');
      assert.equal((await desk('phone/close', {})).body.state, 'MINED');
      assert.equal((await desk('verify', input)).body.ready, true);
    });
  } finally { await app.close(); await c.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
