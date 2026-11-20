'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');

// Hardhat fork reads pass through this loopback-only allowlist. Even if a test
// accidentally routes a signing RPC here, no public node receives a write.
const READ_ONLY = new Set([
  'eth_chainId', 'net_version', 'eth_blockNumber', 'eth_getBlockByNumber',
  'eth_getBlockByHash', 'eth_getCode', 'eth_getStorageAt', 'eth_getBalance',
  'eth_getTransactionCount', 'eth_getTransactionByHash', 'eth_getTransactionReceipt',
  'eth_getLogs', 'eth_call', 'eth_getProof',
]);

async function readOnlyForkRpc(endpoint) {
  const url = new URL(endpoint);
  assert.equal(url.protocol, 'https:', 'Public fork source must use HTTPS');
  const label = url.origin; // Never record credentials/query/path API keys.
  const stats = { upstreamRequests: 0, cacheHits: 0, deniedMethods: [], methods: {} };
  const cache = new Map();
  let sequence = 0;
  async function read(method, params = []) {
    if (!READ_ONLY.has(method)) {
      stats.deniedMethods.push(method);
      throw new Error(`Public RPC write/unknown method denied: ${method}`);
    }
    const key = JSON.stringify([method, params]);
    const immutable = !params.includes('latest') && !params.includes('pending')
      && !['eth_blockNumber', 'eth_getLogs', 'eth_call'].includes(method);
    if (immutable && cache.has(key)) { stats.cacheHits++; return cache.get(key); }
    const operation = (async () => {
      let last;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          stats.upstreamRequests++;
          stats.methods[method] = (stats.methods[method] || 0) + 1;
          const response = await fetch(endpoint, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }),
            signal: AbortSignal.timeout(25_000),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status} from ${label}`);
          const body = await response.json();
          if (body.error) throw new Error(`Read RPC ${method}: ${String(body.error.message).slice(0, 250)}`);
          if (!Object.hasOwn(body, 'result')) throw new Error('Read RPC returned no result');
          return body.result;
        } catch (error) {
          last = error;
          if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        }
      }
      throw last;
    })();
    if (immutable) cache.set(key, operation);
    try { return await operation; }
    catch (error) { cache.delete(key); throw error; }
  }
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        assert.ok(size < 1_048_576, 'Unexpected fork request size');
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString());
      const handle = async item => {
        try { return { jsonrpc: '2.0', id: item.id, result: await read(item.method, item.params || []) }; }
        catch (error) { return { jsonrpc: '2.0', id: item.id, error: { code: -32000, message: error.message } }; }
      };
      const output = Array.isArray(input) ? await Promise.all(input.map(handle)) : await handle(input);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(output));
    } catch {
      res.writeHead(400).end('Invalid read-only fork request');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    read, label, stats, url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
module.exports = { readOnlyForkRpc, READ_ONLY };
