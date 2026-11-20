'use strict';
const { apiKey, readAuth } = require('../backend/test/helpers/auth.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start } = require('../backend/server.cjs');

test('a fresh product instance has no preset deployment, orders, transactions or signing key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upay-product-install-'));
  let app;
  const open = () => start({ dir, port: 0, pollMs: 0, externalWallet: true, multiChain: true });
  try {
    app = await open();
    const keyFile = path.join(dir, 'auth.json'), auth = readAuth(dir), key = apiKey(dir);
    assert.equal(auth.version, 1);
    assert.equal(auth.password, null);
    assert.equal(Buffer.from(auth.recoveryKey, 'base64url').length, 32);
    assert.notEqual(auth.recoveryKey, key);
    assert.equal(Buffer.from(key, 'base64url').length, 32);
    if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
    assert.equal((await fetch(app.url + '/api/status')).status, 401);
    const authStatus = await fetch(app.url + '/api/auth/status');
    assert.equal(authStatus.status, 200);
    assert.deepEqual(await authStatus.json(), { passwordSet: false, passwordMinLength: 12 });
    assert.equal((await fetch(app.url + '/api/status', { headers: { Authorization: 'Bearer ' + auth.recoveryKey } })).status, 401);
    const get = async route => {
      const response = await fetch(app.url + route, { headers: { Authorization: 'Bearer ' + key } });
      assert.equal(response.status, 200, route);
      return response.json();
    };
    const status = await get('/api/status');
    assert.equal(status.configured, false);
    assert.equal(status.config, null);
    assert.equal(status.sendMode, 'CONNECTED_WALLET');
    assert(!status.gasWallet);
    assert.deepEqual(await get('/api/orders'), []);
    assert.deepEqual(await get('/api/jobs'), []);
    const deployments = (await get('/api/deployments')).deployments;
    assert(deployments.every(d => d.chainId === null && d.factory === null && d.payout === null && d.tokens.length === 0));
    assert(!fs.readdirSync(dir).some(name => /(?:gas|private.?key|wallet).*\.secret/i.test(name)));
    await app.close(); app = null;
    app = await open();
    assert.deepEqual(readAuth(dir), auth);
    assert.deepEqual(app.store.orders(), []);
  } finally {
    await app?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
