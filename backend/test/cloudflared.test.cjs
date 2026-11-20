'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const https = require('node:https');
const { ensureCloudflared, download, allowedURL, VERSION } = require('../cloudflared.cjs');
const { ManagedTunnel } = require('../managed-tunnel.cjs');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
async function fixture(t, data = Buffer.from('offline mock binary')) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'upay-cloudflared-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const asset = { name: 'cloudflared-linux-amd64', sha256: hash(data) };
  const options = { dir, platform: 'linux', arch: 'x64', assets: { 'linux-x64': asset },
    executable: async () => false, download: async () => { calls++; return data; } };
  return { dir, data, asset, options, calls: () => calls };
}
test('download is verified, atomic, reusable; modified cache is replaced', async t => {
  const f = await fixture(t);
  const binary = await ensureCloudflared(f.options);
  assert.equal(f.calls(), 1); assert.deepEqual(await fs.readFile(binary), f.data);
  assert.equal(binary, path.join(f.dir, 'components/cloudflared', `${VERSION}-${f.asset.name}`));
  assert.equal(await ensureCloudflared(f.options), binary); assert.equal(f.calls(), 1);
  await fs.writeFile(binary, 'tampered');
  await ensureCloudflared(f.options); assert.equal(f.calls(), 2);
  assert.deepEqual(await fs.readdir(path.dirname(binary)), [path.basename(binary)]);
});
test('integrity failure leaves no files, then retry succeeds', async t => {
  const f = await fixture(t);
  await assert.rejects(ensureCloudflared({ ...f.options, download: async () => Buffer.from('wrong') }), { code: 'CLOUDFLARED_INTEGRITY_FAILED' });
  assert.deepEqual(await fs.readdir(path.join(f.dir, 'components/cloudflared')), []);
  await ensureCloudflared(f.options); assert.equal(f.calls(), 1);
});
test('download failure is retryable, single-process concurrent calls deduplicate', async t => {
  const f = await fixture(t);
  await assert.rejects(ensureCloudflared({ ...f.options, download: async () => { throw Error('offline'); } }), { code: 'CLOUDFLARED_DOWNLOAD_FAILED' });
  const results = await Promise.all(Array.from({ length: 8 }, () => ensureCloudflared(f.options)));
  assert.equal(new Set(results).size, 1); assert.equal(f.calls(), 1);
});
test('explicit binary and PATH reused without download; bad explicit config never falls back', async t => {
  const f = await fixture(t);
  assert.equal(await ensureCloudflared({ ...f.options, binary: '/explicit', executable: async value => value === '/explicit' }), '/explicit');
  assert.equal(await ensureCloudflared({ ...f.options, executable: async () => true }), process.env.UPAY_CLOUDFLARED || 'cloudflared');
  await assert.rejects(ensureCloudflared({ ...f.options, binary: '/missing' }), { code: 'CLOUDFLARED_NOT_FOUND' });
  assert.equal(f.calls(), 0);
});
test('unsupported platform fails clearly without fetching', async t => {
  const f = await fixture(t);
  await assert.rejects(ensureCloudflared({ ...f.options, platform: 'plan9' }), { code: 'CLOUDFLARED_UNSUPPORTED_PLATFORM' });
  assert.equal(f.calls(), 0);
});
test('verified macOS archive extraction repairs tampered executable from trusted archive', async t => {
  const payload = Buffer.from('mock Mach-O'), header = Buffer.alloc(512);
  header.write('cloudflared'); header.write(payload.length.toString(8).padStart(11, '0'), 124); header[156] = 48;
  const archive = gzipSync(Buffer.concat([header, payload, Buffer.alloc(512 - payload.length), Buffer.alloc(1024)]));
  const f = await fixture(t, archive); f.asset.name = 'cloudflared-darwin-arm64.tgz';
  const binary = await ensureCloudflared(f.options);
  assert.deepEqual(await fs.readFile(binary), payload);
  await fs.writeFile(binary, 'modified');
  await ensureCloudflared(f.options);
  assert.deepEqual(await fs.readFile(binary), payload); assert.equal(f.calls(), 1);
});
test('only official HTTPS download URLs and safe redirect hosts are allowed', () => {
  for (const value of ['http://github.com/cloudflare/cloudflared/releases/download/2026.3.0/a',
    'https://evil.example/a', 'https://github.com/other/repo/a', 'https://user:pass@release-assets.githubusercontent.com/a',
    'https://release-assets.githubusercontent.com:444/a']) assert.throws(() => allowedURL(value));
  assert.equal(allowedURL('https://release-assets.githubusercontent.com/a').protocol, 'https:');
});
test('HTTPS transport bounds lengths, redirects, errors, abort; entirely offline', async t => {
  const original = https.get; t.after(() => { https.get = original; });
  let mode = 'ok', calls = 0;
  https.get = (url, options, callback) => {
    calls++;
    const request = new EventEmitter();
    queueMicrotask(() => {
      if (mode === 'abort' || options.signal.aborted) { request.emit('error', Error('aborted')); return; }
      const response = Readable.from([Buffer.from('body')]);
      response.statusCode = mode === 'redirect' ? 302 : 200;
      response.headers = mode === 'large' ? { 'content-length': '999999999' } : mode === 'short' ? { 'content-length': '8' }
        : mode === 'redirect' ? { location: 'https://evil.example/a' } : { 'content-length': '4' };
      callback(response);
    });
    return request;
  };
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/cloudflared-linux-amd64`;
  assert.equal((await download(url)).toString(), 'body');
  for (mode of ['large', 'short', 'redirect', 'abort']) await assert.rejects(download(url));
  assert.equal(calls, 5); // Redirect target is rejected before any request.
});
function manager(t, options = {}) {
  const record = { id: 'test' };
  const handoff = { store: { handoff: () => record, transaction: fn => fn(), saveHandoff: () => {} },
    server: { address: () => ({ port: 12345 }) }, localOrigin: 'http://127.0.0.1:12345' };
  const tunnel = new ManagedTunnel(handoff, options);
  t.after(() => tunnel.shutdown()); return { tunnel, record };
}
test('custom fake worker opens without preparing/downloading', async t => {
  const { tunnel } = manager(t, { workerPath: path.join(__dirname, 'fixtures/fake-tunnel-worker.cjs') });
  await tunnel.open('test'); assert.equal(tunnel.status().state, 'RUNNING');
  assert.equal(tunnel.preparing, undefined); await tunnel.close();
});
for (const action of ['close', 'shutdown']) test(`${action} while preparing waits, prevents late fork and concurrent opens`, async t => {
  let release, signal;
  const { tunnel, record } = manager(t, { ensureCloudflared: options => {
    signal = options.signal; return new Promise(resolve => { release = resolve; });
  } });
  const opening = tunnel.open('test');
  const rejected = assert.rejects(opening, { code: 'TUNNEL_CLOSED' });
  assert.equal(tunnel.status().state, 'STARTING'); assert.ok(!tunnel.worker);
  await assert.rejects(tunnel.open('test'), { code: 'TUNNEL_BUSY' });
  let done = false;
  const closing = tunnel[action]().then(() => { done = true; });
  await Promise.resolve(); assert.equal(done, false); assert.equal(signal.aborted, true);
  assert.equal(tunnel.status().state, 'CLOSING');
  release('/mock'); await rejected; await closing;
  assert.equal(tunnel.status().state, 'CLOSED'); assert.ok(!tunnel.worker);
  assert.equal(record.closeReason, action === 'shutdown' ? 'BACKEND_SHUTDOWN' : 'MANUAL');
});
test('deployment adapter resolves underlying Store.dir and preparation does not spend connector budget', async t => {
  const original = global.setTimeout, delays = [];
  t.after(() => { global.setTimeout = original; });
  global.setTimeout = (callback, delay, ...args) => { delays.push(delay); return original(callback, delay, ...args); };
  let release, captured, calls = 0;
  const { tunnel } = manager(t, { workerPath: path.join(__dirname, 'fixtures/fake-tunnel-worker.cjs'), ensureCloudflared: options => {
    calls++; captured = options.dir; return new Promise(resolve => { release = resolve; });
  } });
  tunnel.handoff.database = { dir: '/offline/deployment-appdata' };
  assert.equal(calls, 0);
  const opening = tunnel.open('test');
  assert.equal(captured, '/offline/deployment-appdata');
  assert.equal(delays.includes(50000), false);
  release('/offline/cloudflared'); await opening;
  assert.equal(delays.includes(50000), true);
  await tunnel.close();
});
test('prepare failure records FAILED; later user open retries and uses fake worker', async t => {
  let calls = 0;
  const { tunnel } = manager(t, { workerPath: path.join(__dirname, 'fixtures/fake-tunnel-worker.cjs'), ensureCloudflared: async () => {
    if (!calls++) throw Object.assign(Error('offline'), { code: 'CLOUDFLARED_DOWNLOAD_FAILED' }); return '/mock';
  } });
  await assert.rejects(tunnel.open('test'), { code: 'CLOUDFLARED_DOWNLOAD_FAILED' });
  assert.equal(tunnel.status().state, 'FAILED');
  await tunnel.open('test'); assert.equal(tunnel.status().state, 'RUNNING'); assert.equal(calls, 2);
});
