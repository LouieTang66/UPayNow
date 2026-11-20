'use strict';
const { apiKey } = require('./helpers/auth.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start } = require('../server.cjs');
const { createEngine } = require('../engine.cjs');
const ID = '1234567890abcdef1234567890abcdef';

test('Project ID saves before chain setup, survives restart, and does not unlock transactions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upay-wallet-settings-'));
  let app;
  const open = () => start({ dir, port: 0, pollMs: 0, multiChain: true });
  try {
    app = await open();
    const key = apiKey(dir);
    const api = async (route, body) => {
      const response = await fetch(app.url + '/api/' + route, { method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    };
    assert.equal((await fetch(app.url + '/api/wallet/config')).status, 401);
    let response = await api('wallet/config');
    assert.equal(response.status, 200); assert.equal(response.value.enabled, false);
    assert.equal(response.value.chainId, null);
    response = await api('wallet/config', { projectId: ID });
    assert.equal(response.status, 200); assert.equal(response.value.projectId, ID);
    assert.equal(response.value.enabled, false); assert.equal(app.merchant.chain, null);
    assert.equal((await api('status')).value.configured, false);
    for (const route of ['wallet/prepare', 'orders']) {
      response = await api(route, {});
      assert.equal(response.status, 409); assert.equal(response.value.error, 'CHAIN_NOT_CONFIGURED');
    }
    response = await api('wallet/config', { projectId: 'not-a-project-id' });
    assert.equal(response.status, 400); assert.equal(response.value.error, 'INVALID_WALLETCONNECT_PROJECT_ID');
    assert.equal((await api('wallet/config')).value.projectId, ID);
    await app.close(); app = await open();
    assert.equal((await api('wallet/config')).value.projectId, ID);
    assert.equal((await api('wallet/config', { projectId: '' })).value.projectId, '');
    assert.deepEqual(app.store.orders(), []); assert.deepEqual(app.store.jobs(), []);
  } finally { await app?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('later deployments inherit the initial Project ID without losing their existing overrides', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upay-wallet-defaults-'));
  let root, child;
  try {
    root = await createEngine(path.join(dir, 'root'), { pollMs: 0, multiChain: true });
    root.wallet.saveConfig({ projectId: ID });
    child = await createEngine(path.join(dir, 'child'), { pollMs: 0, multiChain: true, walletConnectDefaults: root.store });
    assert.equal(child.wallet.config().projectId, ID);
    assert.equal(child.wallet.config().enabled, false);
    const override = 'abcdef1234567890abcdef1234567890';
    child.wallet.saveConfig({ projectId: override });
    assert.equal(child.wallet.config().projectId, override);
    assert.equal(root.wallet.config().projectId, ID);
    await child.close(); child = await createEngine(path.join(dir, 'child'), { pollMs: 0, multiChain: true, walletConnectDefaults: root.store });
    assert.equal(child.wallet.config().projectId, override);
    child.wallet.saveConfig({ projectId: '' });
    assert.equal(child.wallet.config().projectId, '');
    assert.equal(root.wallet.config().projectId, ID);
  } finally { await child?.close(); await root?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
