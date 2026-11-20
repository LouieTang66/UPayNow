'use strict';
const { apiKey, readAuth, initializePassword, PASSWORD } = require('./helpers/auth.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { start } = require('../server.cjs');
const { Store } = require('../store.cjs');
async function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upay-required-auth-'));
  try {
    const app = await start({ dir, port: 0, pollMs: 0, ...options });
    return { app, dir, close: async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
  } catch (error) { fs.rmSync(dir, { recursive: true, force: true }); throw error; }
}
test('all instances generate private persistent separated credentials and require authentication', async () => {
  const f = await fixture();
  try {
    const file = path.join(f.dir, 'auth.json'), state = readAuth(f.dir), key = apiKey(f.dir);
    assert.equal(state.version, 1);
    assert.equal(state.password, null);
    assert.equal(Buffer.from(state.recoveryKey, 'base64url').length, 32);
    assert.equal(Buffer.from(key, 'base64url').length, 32);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal((await fetch(f.app.url + '/api/status')).status, 401);
    assert.equal((await fetch(f.app.url + '/api/status', { headers: { Cookie: 'upay_session=invalid' } })).status, 401);
    assert.equal((await fetch(f.app.url + '/api/orders')).status, 401);
    assert.deepEqual(await (await fetch(f.app.url + '/api/auth/status')).json(), { passwordSet: false, passwordMinLength: 12 });
    assert.equal((await fetch(f.app.url + '/api/status', { headers: { Authorization: 'Bearer ' + state.recoveryKey } })).status, 401);
    const r = await fetch(f.app.url + '/api/status', { headers: { Authorization: 'Bearer ' + key } });
    assert.equal(r.status, 200); assert.equal((await r.json()).authMode, 'PASSWORD');
    assert.equal(f.app.server.address().address, '127.0.0.1');
    await f.app.close();
    const reopened = await start({ dir: f.dir, port: 0, pollMs: 0, externalWallet: true });
    try {
      assert.deepEqual(readAuth(f.dir), state);
      assert.equal((await fetch(reopened.url + '/api/status', { headers: { Authorization: 'Bearer ' + key } })).status, 200);
    } finally { await reopened.close(); }
  } finally { await f.close(); }
});
test('password login issues a session, cookie writes keep origin checks, and logout revokes the session', async () => {
  const f = await fixture({ externalWallet: true });
  try {
    const key = apiKey(f.dir), base = f.app.url;
    await initializePassword(f.app, f.dir);
    for (const password of [key, readAuth(f.dir).recoveryKey]) {
      const denied = await fetch(base + '/api/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      assert.equal(denied.status, 401);
    }
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal((await fetch(base + '/api/status', { headers: { Cookie: cookie } })).status, 200);
    const logout = origin => fetch(base + '/api/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin } });
    assert.equal((await logout('https://evil.invalid')).status, 403);
    assert.equal((await logout(base)).status, 200);
    assert.equal((await fetch(base + '/api/status', { headers: { Cookie: cookie } })).status, 401);
    const hostile = await new Promise((resolve, reject) => {
      http.get(base + '/api/status', { headers: { Host: 'evil.invalid', Authorization: 'Bearer ' + key } }, r => { r.resume(); r.on('end', () => resolve(r.statusCode)); }).on('error', reject);
    });
    assert.equal(hostile, 403);
  } finally { await f.close(); }
});
test('legacy no-login option is rejected before creating state or opening a listener', async () => {
  await assert.rejects(fixture({ externalWallet: true, localTestNoLogin: true }), { code: 'NO_LOGIN_MODE_REMOVED' });
  await assert.rejects(fixture({ localTestNoLogin: true }), { code: 'NO_LOGIN_MODE_REMOVED' });
});
test('authenticated startup restores custom/mainnet configuration without a test-only policy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upay-testnet-policy-'));
  try {
    const store = new Store(dir);
    store.set('config', { rpcUrl: 'https://unused.invalid', chainId: 56, factory: '0x0000000000000000000000000000000000000001' }); store.close();
    const app = await start({ dir, port: 0, pollMs: 0 });
    assert.equal(app.merchant.status().config.chainId, 56);
    assert.equal(app.merchant.status().sendMode, 'CONNECTED_WALLET');
    await app.close();
    assert.equal(fs.existsSync(path.join(dir, 'owner.lock')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
