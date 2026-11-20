'use strict';
const { apiKey } = require('./helpers/auth.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ethers } = require('ethers');
const { start } = require('../server.cjs');
const { localArtifacts } = require('./fixtures/local-tools.cjs');
const { isolatedChain } = require('./fixtures/multichain-local.cjs');
const { historicalDeployment } = require('./fixtures/historical-deployment.cjs');

test('multichain HTTP integration: independent HTTPS EVMs, scoped storage and restart', { timeout: 150000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upay-multichain-'));
  const options = { dir, port: 0, externalWallet: true, multiChain: true, pollMs: 0,
    handoffPort: 0, handoffQuick: false, deploymentPort: 0, deploymentQuick: false,
    deploymentOrigin: 'https://deploy.example.test',
    deploymentNetworks: [31337,31338].map(chainId => ({chainId,name:'Isolated '+chainId,nativeSymbol:'TEST_ETH',defaultRPC:'https://test.invalid'})) };
  let app, first, second, childId, createdDeploymentId, rootOrder, childOrder, bodyOrder;
  const config = c => ({ name: 'Isolated chain ' + c.chainId, chainId: c.chainId, rpcUrl: c.url,
    payout: c.payout, tokens: [c.token.target], factory: c.factory.target,
    startBlock: c.startBlock, confirmations: 1, nativeSymbol: 'TEST_ETH' });
  const request = async (route, { method = 'GET', input, deployment, publicRequest = false, base } = {}) => {
    // Never log the root administrator credential or phone capability.
    const headers = publicRequest ? {} : { Authorization: 'Bearer ' + apiKey(dir) };
    if (deployment) headers['X-Upay-Deployment'] = deployment;
    if (input !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch((base || app.url) + route, { method, headers,
      ...(input !== undefined ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(15000) });
    return { status: response.status, body: await response.json() };
  };
  const orderInput = c => ({ reference: 'same-business-reference', token: c.token.target, amount: '1.25', expiresInSeconds: 1800 });
  try {
    const artifacts = localArtifacts();
    first = await isolatedChain(31337, artifacts);
    second = await isolatedChain(31338, artifacts);
    assert.notEqual(first.url, second.url);
    for (const c of [first, second]) {
      assert.equal(new URL(c.url).protocol, 'https:');
      assert.ok(!['18545', '8797', '8798'].includes(new URL(c.url).port));
    }
    assert.notEqual((await first.provider.getNetwork()).chainId, (await second.provider.getNetwork()).chainId);
    // Equal deterministic contract addresses on separate chains stress chain+Factory identity.
    assert.equal(first.factory.target, second.factory.target);
    app = await start(options);
    await app.merchant.configure(config(first));
    await t.test('legacy stays default and authenticated import returns only serializable entry', async () => {
      assert.equal((await request('/api/deployments', { publicRequest: true })).status, 401);
      const initial = await request('/api/deployments');
      assert.equal(initial.status, 200); assert.equal(initial.body.defaultId, 'legacy');
      assert.equal(initial.body.deployments.length, 1);
      const imported = await request('/api/deployments/import', { method: 'POST', input: config(second) });
      assert.equal(imported.status, 201, 'import response: ' + JSON.stringify(imported.body));
      childId = imported.body.id;
      assert.match(childId, /^[a-f0-9-]{36}$/);
      for (const key of ['store', 'merchant', 'wallet', 'handoff', 'hooks', 'engine']) assert.equal(imported.body[key], undefined, 'engine internals must not escape');
      assert.equal(imported.body.chainId, second.chainId);
      const duplicate = await request('/api/deployments/import', { method: 'POST', input: config(second) });
      assert.equal(duplicate.status, 201); assert.equal(duplicate.body.id, childId);
      assert.equal((await request('/api/deployments')).body.deployments.length, 2);
    });
    // Continue useful independent cases even when the import response is defective.
    childId ||= app.deployments.list().deployments.find(d => d.id !== 'legacy')?.id;
    assert.ok(childId, 'import must register an independent child deployment');
    await t.test('same reference is isolated; header/body routing and conflicts fail closed', async () => {
      const root = await request('/api/orders', { method: 'POST', input: orderInput(first) });
      const child = await request('/api/orders', { method: 'POST', deployment: childId, input: orderInput(second) });
      assert.equal(root.status, 201); assert.equal(child.status, 201);
      rootOrder = root.body; childOrder = child.body;
      assert.equal(rootOrder.deploymentId, 'legacy'); assert.equal(childOrder.deploymentId, childId);
      assert.notEqual(rootOrder.id, childOrder.id); assert.notEqual(rootOrder.publicToken, childOrder.publicToken);
      assert.notEqual(rootOrder.address, childOrder.address);
      const byBody = await request('/api/orders', { method: 'POST', input: { ...orderInput(second), reference: 'body-scoped', deploymentId: childId } });
      assert.equal(byBody.status, 201); bodyOrder = byBody.body;
      assert.equal(bodyOrder.chainId, second.chainId);
      assert.equal((await request('/api/orders', { method: 'POST', deployment: 'legacy', input: { ...orderInput(second), deploymentId: childId } })).status, 409);
      assert.deepEqual((await request('/api/orders')).body.map(o => o.id), [rootOrder.id]);
      assert.deepEqual(new Set((await request('/api/orders', { deployment: childId })).body.map(o => o.id)), new Set([childOrder.id, bodyOrder.id]));
      assert.equal((await request('/api/orders/' + childOrder.id)).status, 404);
      assert.equal((await request('/api/orders/' + rootOrder.id, { deployment: childId })).status, 404);
      assert.equal((await request('/api/orders', { deployment: 'missing' })).status, 404);
      assert.equal((await request('/api/orders', { method: 'POST', input: { ...orderInput(first), deploymentId: 'missing' } })).status, 404);
      const engine = app.deployments.get(childId);
      assert.notEqual(engine.store, app.store);
      assert.equal(path.dirname(engine.store.dir), path.join(dir, 'deployments'));
      assert.equal(engine.store.order(rootOrder.id), null);
      assert.equal(app.store.order(childOrder.id), null);
    });
    await t.test('real payment scans remain independent; public lookup ignores selected deployment', async () => {
      assert.ok(rootOrder && childOrder, 'orders created');
      await (await second.token.mint(childOrder.address, ethers.parseUnits('1.25', 6))).wait();
      assert.equal(await first.token.balanceOf(childOrder.address), 0n);
      assert.equal((await request('/api/scan', { method: 'POST', input: {} })).status, 200);
      assert.equal((await request('/api/scan', { method: 'POST', input: {}, deployment: childId })).status, 200);
      const root = await request('/api/pay/' + rootOrder.publicToken, { publicRequest: true, deployment: childId });
      const child = await request('/api/pay/' + childOrder.publicToken, { publicRequest: true, deployment: 'legacy' });
      assert.equal(root.status, 200); assert.equal(child.status, 200);
      assert.equal(root.body.chainId, first.chainId); assert.equal(child.body.chainId, second.chainId);
      assert.equal(root.body.status, 'WAITING'); assert.equal(child.body.status, 'PAID');
      assert.equal(child.body.confirmedAmount, '1.25');
      for (const body of [root.body, child.body]) {
        assert.equal(body.publicToken, undefined); assert.equal(body.reference, undefined);
      }
      assert.equal((await request('/api/pay/' + 'x'.repeat(32), { publicRequest: true })).status, 404);
    });
    await t.test('deployment phone capability rejects missing token, overrides and management API', async () => {
      const job = await historicalDeployment(app.deploymentService, { ...config(second), name: 'Phone isolated job' });
      const ticket = await app.deploymentHandoff.create(job.id);
      const token = new URL(ticket.url).hash.slice(1);
      const base = app.deploymentHandoff.localOrigin;
      const phone = async (route, input, authorized = true) => {
        const headers = { ...(authorized ? { Authorization: 'Bearer ' + token } : {}), Origin: options.deploymentOrigin };
        if (input !== undefined) headers['Content-Type'] = 'application/json';
        const r = await fetch(base + route, { headers, method: input === undefined ? 'GET' : 'POST',
          ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(15000) });
        return { status: r.status, body: await r.json() };
      };
      assert.equal((await phone('/api/deploy/' + job.id, undefined, false)).status, 401);
      assert.equal((await phone('/api/deploy/' + job.id)).status, 200);
      assert.equal((await phone('/api/orders')).status, 404);
      const from = await (await second.provider.getSigner(3)).getAddress();
      for (const override of [{ payout: first.payout }, { chainId: 31337 }, { data: '0x00' }, { to: first.factory.target }, { value: '0x1' }]) {
        assert.equal((await phone('/api/deploy/' + job.id + '/begin', { from, ...override })).status, 403);
      }
      assert.equal(app.deploymentService.record(job.id).state, 'READY');
      assert.ok(ticket.expiresAt > Date.now());
      const begun = await phone('/api/deploy/' + job.id + '/begin', { from });
      assert.equal(begun.status, 200);
      assert.equal(begun.body.expiresAt, ticket.expiresAt, 'phone begin must expose capability expiry');
      assert.equal(app.deploymentService.record(job.id).state, 'UNKNOWN');
      // Complete the actual phone API -> local wallet creation -> verified registry vertical slice.
      const signer = await second.provider.getSigner(3);
      const { gas, ...creation } = begun.body.transaction;
      const sent = await signer.sendTransaction({ ...creation, gasLimit: gas });
      await sent.wait();
      const attached = await phone('/api/deploy/' + job.id + '/attach', { transactionHash: sent.hash });
      assert.equal(attached.status, 200, JSON.stringify(attached.body));
      assert.equal(attached.body.state, 'MINED'); assert.equal(attached.body.outcome, 'SUCCESS');
      createdDeploymentId = attached.body.deploymentId;
      assert.ok(createdDeploymentId && createdDeploymentId !== childId);
      assert.notEqual(attached.body.factory, second.factory.target);
      assert.equal(app.deployments.get(createdDeploymentId).merchant.chain.config.factory, attached.body.factory);
      assert.equal((await request('/api/deployments')).body.deployments.length, 3);
    });
    await t.test('restart restores root and child orders/config/cursors without merging stores', async () => {
      const childCursor = app.deployments.get(childId).store.get('cursor');
      await app.close(); app = null;
      app = await start(options);
      assert.equal((await request('/api/deployments')).body.deployments.length, 3);
      assert.equal(app.deployments.get(createdDeploymentId).merchant.chain.config.chainId, second.chainId);
      assert.equal((await request('/api/status')).body.config.chainId, first.chainId);
      assert.equal((await request('/api/status', { deployment: childId })).body.config.chainId, second.chainId);
      assert.deepEqual((await request('/api/orders')).body.map(o => o.id), [rootOrder.id]);
      assert.equal(app.deployments.get(childId).store.get('cursor'), childCursor);
      assert.equal((await request('/api/orders/' + childOrder.id, { deployment: childId })).body.status, 'PAID');
      assert.equal((await request('/api/pay/' + childOrder.publicToken, { publicRequest: true })).body.chainId, second.chainId);
      assert.equal(app.store.order(childOrder.id), null);
      assert.equal(app.deployments.get(childId).store.order(rootOrder.id), null);
    });
  } finally {
    await app?.close();
    await second?.close(); await first?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
