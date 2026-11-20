import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('./src/shared/api.js', import.meta.url), 'utf8');
const { liveClient, sequencer, detectMode } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const withFetch = async (fake, fn) => { const saved = globalThis.fetch; globalThis.fetch = fake; try { await fn(); } finally { globalThis.fetch = saved; } };

test('live client requires explicit deployment scope without issuing requests', () => withFetch(() => { throw Error('must not fetch'); }, async () => {
  await assert.rejects(liveClient().get('orders'), { code: 'DEPLOYMENT_REQUIRED' });
}));
test('live reads use same-origin session cookies, explicit scope and no redirects', () => withFetch(async (url, opts) => {
  assert.equal(url, '/api/orders'); assert.equal(opts.method, 'GET');
  assert.equal(opts.headers['X-Upay-Deployment'], 'fixture-deployment');
  assert.equal(opts.credentials, 'same-origin'); assert.equal(opts.redirect, 'error'); assert.equal(opts.cache, 'no-store');
  return response([]);
}, async () => assert.deepEqual(await liveClient().get('orders', { deploymentId: 'fixture-deployment' }), [])));
test('login sends JSON only to the actual global endpoint', () => withFetch(async (url, opts) => {
  assert.equal(url, '/api/login'); assert.equal(opts.method, 'POST');
  assert.equal(opts.headers['X-Upay-Deployment'], undefined); assert.equal(opts.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(opts.body), { password: 'isolated-fixture-only' }); return response({ ok: true });
}, async () => assert.deepEqual(await liveClient().post('login', { password: 'isolated-fixture-only' }), { ok: true })));
test('opened networks use the global authenticated client without a deployment selection', () => withFetch(async (url, opts) => {
  assert.equal(url, '/api/deployment-networks');
  assert.equal(opts.headers['X-Upay-Deployment'], undefined);
  assert.equal(opts.credentials, 'same-origin');
  return response([{ chainId: 97 }, { chainId: 11155111 }]);
}, async () => assert.deepEqual(await liveClient().get('deployment-networks'), [{ chainId: 97 }, { chainId: 11155111 }])));
test('401 is not converted into demo data or a successful response', () => withFetch(async () => response({ error: 'UNAUTHORIZED' }, 401), async () => {
  await assert.rejects(liveClient().get('deployments'), { code: 'UNAUTHORIZED', status: 401 });
}));
test('HTML or invalid JSON cannot masquerade as a successful backend response', () => withFetch(async () => new Response('<html>proxy error</html>'), async () => {
  await assert.rejects(liveClient().get('deployments'), { code: 'INVALID_API_RESPONSE' });
}));
test('requests time out and expose uncertainty instead of retrying writes', () => withFetch((_url, opts) => new Promise((_resolve, reject) => {
  opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
}), async () => {
  await assert.rejects(liveClient().post('deployment-jobs/id/begin', {}, { timeoutMs: 10 }), { code: 'REQUEST_TIMEOUT' });
}));
test('a stalled response body remains a timeout rather than malformed JSON', async () => {
  await withFetch(async (_, options) => ({ ok: true, status: 200,
    json: () => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted body'))))
  }), async () => {
    await assert.rejects(liveClient().get('status', { deploymentId: 'one', timeoutMs: 10 }), e => e.code === 'REQUEST_TIMEOUT');
  });
});
test('phone preparation includes download time; preview, send routes and explicit overrides keep their budgets', async () => {
  const saved = globalThis.setTimeout, scheduled = [];
  globalThis.setTimeout = (fn, ms, ...args) => { scheduled.push(ms); return saved(fn, ms, ...args); };
  try {
    await withFetch(async () => response({ ok: true }), async () => {
      const client = liveClient(), scope = { deploymentId: 'fixture-deployment' };
      await client.post('collect-all/preview', {}, scope);
      await client.get('orders', scope);
      await client.post('collect-all', {}, scope);
      await client.post('wallet/jobs/id/begin', {}, scope);
      await client.get('collect-all/preview', scope);
      await client.post('collect-all/preview', {}, { ...scope, timeoutMs: 1234 });
      await client.post('handoffs', {}, scope);
      await client.post('deployment-jobs/id/handoff', {});
      await client.post('deployment-jobs/id/begin', {});
      await client.post('handoffs', {}, { ...scope, timeoutMs: 1234 });
      assert.deepEqual(scheduled, [60000, 15000, 15000, 15000, 15000, 1234, 180000, 180000, 15000, 1234]);
    });
  } finally { globalThis.setTimeout = saved; }
});
test('sequencer drops older responses and previous-deployment errors', async () => {
  const seq = sequencer(); let release;
  const first = seq.run('orders', () => new Promise(resolve => { release = resolve; }));
  assert.equal((await seq.run('orders', async () => 'new')).value, 'new');
  release('old'); assert.deepEqual(await first, { stale: true });
  let fail; const prior = seq.run('status', () => new Promise((_r, reject) => { fail = reject; }));
  seq.reset(); fail(new Error('stale 401')); assert.deepEqual(await prior, { stale: true });
});
test('deterministic preview and recovery prepare are global; wallet job recovery keeps target header', () => withFetch(async (url, opts) => {
  if (url.includes('/wallet/jobs/')) assert.equal(opts.headers['X-Upay-Deployment'], 'TARGET');
  else assert.equal(opts.headers['X-Upay-Deployment'], undefined);
  return response({ ok: true });
}, async () => {
  const client = liveClient();
  await client.post('deterministic/preview', { chainId: 56 });
  await client.post('crosschain-recovery/preview', { sourceDeploymentId: 'SOURCE', targetDeploymentId: 'TARGET' });
  await client.post('crosschain-recovery/prepare', { sourceDeploymentId: 'SOURCE', targetDeploymentId: 'TARGET' });
  for (const action of ['begin', 'attach', 'refresh', 'cancel']) await client.post('wallet/jobs/recovery/' + action, {}, { deploymentId: 'TARGET' });
}));

test('frontend is live-only without reading a mode endpoint', () => withFetch(() => assert.fail('mode detection must not fetch'), async () => {
  assert.equal(await detectMode(), 'live');
  assert.equal(liveClient().mode, 'live');
}));
