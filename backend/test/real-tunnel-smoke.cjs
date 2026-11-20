'use strict';
// Explicit opt-in public connectivity test. No configured blockchain, real orders or wallet signing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { start } = require('../server.cjs');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upay-real-tunnel-'));
  let app;
  try {
    app = await start({ dir, port: 0, pollMs: 0, externalWallet: true, handoffPort: 0, handoffQuick: true });
    assert.equal(app.handoff.tunnel.status().state, 'CLOSED');
    const id = crypto.randomUUID();
    app.store.saveHandoff({ id, state: 'READY', expiresAt: Date.now() + 300000, tokenHash: crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex'), entries: [], jobId: null });
    const ready = await app.handoff.tunnel.open(id);
    console.log(JSON.stringify({ phase: 'CONNECTOR_READY', origin: ready.origin, expiresAt: ready.expiresAt }));
    const record = app.store.handoff(id); record.tunnelSessionId = ready.id; record.expiresAt = ready.expiresAt; app.store.saveHandoff(record);
    async function publicGet(route) {
      let response;
      for (let i = 0; i < 5; i++) {
        try { response = await fetch(ready.origin + route, { signal: AbortSignal.timeout(10000), redirect: 'error' }); }
        catch (error) { if (i === 4) throw error; console.log(JSON.stringify({ phase: 'PUBLIC_RETRY', code: error.cause?.code || error.name })); await delay(1500); continue; }
        if (![502, 503].includes(response.status)) return response;
        await response.arrayBuffer(); await delay(1000);
      }
      return response;
    }
    const page = await publicGet('/c/' + id);
    assert.equal(page.status, 200); assert.match(await page.text(), /\/v2\/assets\/collect\.js/);
    for (const route of ['/v2/c/' + id, '/v2/assets/collect.js', '/v2/assets/base.css', '/v2/assets/public.css']) {
      assert.equal((await publicGet(route)).status, 200);
    }
    for (const route of ['/legacy', '/legacy/', '/mobile.js', '/style.css', '/admin.html', '/app.js',
      '/wallet.js', '/checkout.js', '/deploy-mobile.js', '/public/mobile.js', '/backend/public/mobile.html',
      '/v2/', '/v2/assets/admin.js', '/v2/assets/deploy.js']) assert.equal((await publicGet(route)).status, 404);
    assert.equal((await publicGet('/api/orders')).status, 404);
    assert.equal((await publicGet('/api/wallet/config')).status, 404);
    assert.equal((await publicGet('/api/handoffs/' + id)).status, 401);
    console.log(JSON.stringify({ phase: 'PUBLIC_READY', https: ready.origin, maxDurationSeconds: 300, expiresAt: ready.expiresAt, publicPage: 200, publicAdmin: 404, unauthenticatedTicket: 401, realOrders: 0, walletTransactions: 0 }));
    if (process.argv.includes('--wait-expiry')) {
      await delay(Math.max(0, ready.expiresAt - Date.now()) + 350);
      app.handoff.tunnel.tick(); await app.handoff.tunnel.ended;
      assert.equal(app.handoff.tunnel.status().state, 'CLOSED');
      assert.equal(app.handoff.tunnel.status().reason, 'TIMEOUT');
    } else await app.handoff.tunnel.close('MANUAL');
    assert.equal(app.handoff.tunnel.worker, null);
    const closed = await fetch(app.handoff.localOrigin + '/c/' + id);
    assert.equal(closed.status, 410);
    const result = { phase: 'PASS', state: app.handoff.tunnel.status().state, reason: app.handoff.tunnel.status().reason,
      localGateAfterClose: closed.status, watchdogExited: true, jobs: app.store.jobs().length, walletTransactions: 0 };
    const output = path.join(__dirname, '../verification-tunnel'); fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'real-tunnel-result.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } finally { await app?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
