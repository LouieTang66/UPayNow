'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Chain, ethers } = require('../chain.cjs');
const { localServer } = require('./fixtures/dev-chain.cjs');
const { deployLocal } = require('./fixtures/local-tools.cjs');
const { createLocalTLS, trustCA } = require('./fixtures/tls-local.cjs');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
const config = rpcUrl => ({ rpcUrl, factory: ethers.ZeroAddress });

test('Chain rejects every plaintext RPC and URL credentials before factory construction', () => {
  for (const url of ['http://example.invalid', 'http://localhost:18545', 'http://127.0.0.1:18545', 'http://[::1]:18545', 'ws://localhost', 'file:///tmp/rpc']) {
    assert.throws(() => new Chain(config(url)), { code: 'RPC_HTTPS_REQUIRED' });
  }
  assert.throws(() => new Chain(config('https://user:password@localhost')), { code: 'RPC_CREDENTIALS_NOT_ALLOWED' });
  assert.throws(() => new Chain(config('not a url')), { code: 'INVALID_RPC_URL' });
});

test('trusted loopback HTTPS carries real EVM deployment, transfer and Chain identity', { timeout: 90000 }, async () => {
  const local = await localServer(0);
  const provider = new ethers.JsonRpcProvider(local.url, undefined, { cacheTimeout: -1 });
  let chain;
  try {
    assert.match(local.url, /^https:\/\/127\.0\.0\.1:/);
    const d = await deployLocal(provider);
    chain = new Chain({ rpcUrl: local.url, chainId: 31337, factory: d.factory.target, payout: d.payout });
    assert.equal((await chain.identity()).length, 2);
    const sender = await (await provider.getSigner(0)).getAddress();
    await (await d.a.mint(sender, 123n)).wait();
    await (await d.a.transfer(d.payout, 123n)).wait();
    assert.equal(await chain.balance(d.a.target, d.payout), 123n);
    const { stdout } = await promisify(execFile)(process.execPath, ['-e',
      "const p=require('./backend/test/fixtures/local-tools.cjs').localRpcProvider();p.send('eth_chainId',[]).then(v=>{console.log(v);p.destroy()}).catch(e=>{p.destroy();console.error(e);process.exitCode=1})"],
      { cwd: require('node:path').join(__dirname, '../..'), env: { ...process.env, UPAY_LOCAL_CA: local.caFile, UPAY_LOCAL_RPC_URL: local.url } });
    assert.equal(stdout.trim(), '0x7a69');
  } finally { chain?.close(); provider.destroy(); await local.server.close(); }
});

test('ethers TLS rejects an untrusted certificate (no trust or validation bypass)', async () => {
  const credentials = createLocalTLS();
  const server = https.createServer(credentials, (_req, res) => res.end('{}'));
  await listen(server);
  try {
    const req = new ethers.FetchRequest('https://127.0.0.1:' + server.address().port);
    req.timeout = 3000;
    await assert.rejects(req.send(), /certificate|issuer|verify/i);
  } finally { await close(server); credentials.cleanup(); }
});

test('ethers default refuses HTTPS to HTTP redirect without contacting downgrade target', async () => {
  const credentials = createLocalTLS();
  trustCA(credentials.caFile);
  let hits = 0;
  const target = http.createServer((_req, res) => { hits++; res.end('{}'); });
  await listen(target);
  const server = https.createServer(credentials, (_req, res) => {
    res.writeHead(302, { Location: 'http://127.0.0.1:' + target.address().port }); res.end();
  });
  await listen(server);
  try {
    const req = new ethers.FetchRequest('https://127.0.0.1:' + server.address().port);
    assert.throws(() => req.redirect('http://127.0.0.1:' + target.address().port), /unsupported redirect/);
    const response = await req.send();
    assert.equal(response.statusCode, 302);
    assert.equal(hits, 0);
  } finally { await close(server); await close(target); credentials.cleanup(); }
});
