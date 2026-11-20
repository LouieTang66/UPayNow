'use strict';
const { initializePassword, PASSWORD } = require('./helpers/auth.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start } = require('../server.cjs');

test('v2 real HTTP routes retain session auth and scoped phone boundaries', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upaynow-v2-http-'));
  const previous = process.env.UPAY_FRONTEND;
  delete process.env.UPAY_FRONTEND;
  let app;
  try {
    app = await start({ dir, port: 0, pollMs: 0, multiChain: true, externalWallet: true,
      handoffPort: 0, deploymentPort: 0, deploymentQuick: false });
    const read = (origin, route) => fetch(origin + route);
    const removedRoutes = ['/legacy', '/legacy/', '/admin.html', '/app.js', '/wallet.js', '/checkout.js',
      '/mobile.html', '/mobile.js', '/deploy-mobile.html', '/deploy-mobile.js', '/style.css',
      '/public/admin.html', '/public/app.js', '/backend/public/admin.html'];
    const post = (route, input, cookie, origin = app.url) => fetch(app.url + '/api/' + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(input)
    });
    await t.test('default admin, aliases and existing checkout URLs serve built v2, never demo mode', async () => {
      for (const route of ['/', '/v2/', '/v2/index.html']) {
        const res = await read(app.url, route); assert.equal(res.status, 200);
        assert.match(await res.text(), /\/v2\/assets\/admin\.js/);
      }
      for (const route of ['/pay/' + 'a'.repeat(32), '/v2/pay/' + 'a'.repeat(32)]) {
        const res = await read(app.url, route); assert.equal(res.status, 200);
        assert.match(await res.text(), /\/v2\/assets\/checkout\.js/);
      }
      assert.deepEqual(await (await read(app.url, '/v2/mode.json')).json(), { mode: 'live' });
      assert.equal((await read(app.url, '/v2/assets/admin.js')).status, 200);
      assert.equal((await read(app.url, '/v2/assets/admin.js.map')).status, 404);
      const license = await read(app.url, '/v2/assets/admin.js.LEGAL.txt');
      assert.equal(license.status, 200);
      assert.match(license.headers.get('content-type'), /^text\/plain/);
      assert.ok((await license.text()).length > 0);
      for (const route of ['/v2/assets/unknown.js.LEGAL.txt', '/v2/assets/app.css.LEGAL.txt', '/v2/assets/admin.js.LEGAL.txt.map']) {
        assert.equal((await read(app.url, route)).status, 404);
      }
      assert.equal((await read(app.url, '/v2/assets/../README.md')).status, 404);
    });
    await t.test('password login, real deployment data, Origin rejection and logout', async () => {
      assert.equal((await read(app.url, '/api/deployments')).status, 401);
      await initializePassword(app, dir);
      assert.equal((await post('login', { password: 'wrong' })).status, 401);
      const login = await post('login', { password: PASSWORD }); assert.equal(login.status, 200);
      assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const deployments = await fetch(app.url + '/api/deployments', { headers: { Cookie: cookie } });
      assert.equal(deployments.status, 200); assert.equal((await deployments.json()).deployments[0].id, 'legacy');
      assert.equal((await post('logout', {}, cookie, 'https://wrong.invalid')).status, 403);
      assert.equal((await post('logout', {}, cookie)).status, 200);
      assert.equal((await fetch(app.url + '/api/orders', { headers: { Cookie: cookie } })).status, 401);
    });
    await t.test('phone deployment serves only its page/assets and retains capability checks', async () => {
      const origin = app.deploymentHandoff.localOrigin, id = 'a'.repeat(8) + '-bbbb-cccc-dddd-' + 'e'.repeat(12);
      for (const route of ['/d/' + id, '/v2/d/' + id]) {
        const res = await read(origin, route); assert.equal(res.status, 200);
        assert.match(await res.text(), /\/v2\/assets\/deploy\.js/);
      }
      assert.equal((await read(origin, '/v2/assets/deploy.js')).status, 200);
      for (const asset of ['base.css', 'public.css']) assert.equal((await read(origin, '/v2/assets/' + asset)).status, 200);
      assert.equal((await read(origin, '/v2/assets/admin.js')).status, 404);
      assert.equal((await read(origin, '/v2/assets/admin.js.LEGAL.txt')).status, 404);
      assert.equal((await read(origin, '/v2/assets/collect.js')).status, 404);
      assert.equal((await read(origin, '/api/orders')).status, 404);
      assert.notEqual((await read(origin, '/api/deploy/' + id)).status, 200);
      assert.deepEqual(await (await read(origin, '/v2/mode.json')).json(), { mode: 'live' });
    });
    await t.test('phone collection pages retain handoff routing and cannot expose admin assets/API', async () => {
      const origin = app.handoff.localOrigin, id = 'f'.repeat(8) + '-bbbb-cccc-dddd-' + 'e'.repeat(12);
      app.store.saveHandoff({ id, state: 'READY', tokenHash: '0'.repeat(64), expiresAt: Date.now() + 60000 });
      for (const route of ['/c/' + id, '/v2/c/' + id]) {
        const res = await read(origin, route); assert.equal(res.status, 200);
        assert.match(await res.text(), /\/v2\/assets\/collect\.js/);
      }
      assert.equal((await read(origin, '/v2/assets/collect.js')).status, 200);
      for (const asset of ['base.css', 'public.css']) assert.equal((await read(origin, '/v2/assets/' + asset)).status, 200);
      assert.equal((await read(origin, '/v2/assets/admin.js')).status, 404);
      assert.equal((await read(origin, '/v2/assets/admin.js.LEGAL.txt')).status, 404);
      assert.equal((await read(origin, '/v2/assets/deploy.js')).status, 404);
      assert.equal((await read(origin, '/api/orders')).status, 404);
      assert.equal((await read(origin, '/api/handoffs/' + id)).status, 401);
    });
    await t.test('removed legacy entries and resources return 404 on every listener', async () => {
      for (const origin of [app.url, app.handoff.localOrigin, app.deploymentHandoff.localOrigin]) {
        for (const route of removedRoutes) assert.equal((await read(origin, route)).status, 404, origin + route);
      }
    });
    await t.test('legacy environment cannot switch original URLs away from the new frontend', async () => {
      process.env.UPAY_FRONTEND = 'legacy';
      for (const route of ['/', '/v2/']) {
        const response = await read(app.url, route); assert.equal(response.status, 200);
        assert.match(await response.text(), /\/v2\/assets\/admin\.js/);
      }
      const id = 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee';
      for (const [origin, route, asset] of [
        [app.url, '/pay/' + 'a'.repeat(32), 'checkout'],
        [app.handoff.localOrigin, '/c/' + id, 'collect'],
        [app.deploymentHandoff.localOrigin, '/d/' + id, 'deploy']
      ]) {
        const response = await read(origin, route); assert.equal(response.status, 200);
        assert.ok((await response.text()).includes('/v2/assets/' + asset + '.js'));
      }
      for (const origin of [app.url, app.handoff.localOrigin, app.deploymentHandoff.localOrigin]) {
        for (const route of removedRoutes) assert.equal((await read(origin, route)).status, 404, origin + route);
      }
      delete process.env.UPAY_FRONTEND;
    });
  } finally {
    if (previous === undefined) delete process.env.UPAY_FRONTEND; else process.env.UPAY_FRONTEND = previous;
    await app?.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
