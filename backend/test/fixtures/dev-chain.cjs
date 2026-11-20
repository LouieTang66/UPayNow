'use strict';
const hre = require('hardhat');
const https = require('node:https');
const { JsonRpcHandler } = require('hardhat/internal/hardhat-network/jsonrpc/handler');
const { createLocalTLS, trustCA } = require('./tls-local.cjs');
async function localServer(port = 18545) {
  if (await hre.network.provider.send('eth_chainId') !== '0x7a69') throw new Error('LOCAL_CHAIN_ONLY');
  const credentials = createLocalTLS();
  try {
    trustCA(credentials.caFile);
    const handler = new JsonRpcHandler(hre.network.provider);
    // Direct TLS termination: no plaintext RPC listener, not even on loopback.
    const listener = https.createServer({ key: credentials.key, cert: credentials.cert }, handler.handleHttp);
    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(port, '127.0.0.1', resolve);
    });
    const server = { close: () => new Promise((resolve, reject) => {
      listener.close(error => { credentials.cleanup(); error ? reject(error) : resolve(); });
      listener.closeIdleConnections();
    }) };
    return { server, url: 'https://127.0.0.1:' + listener.address().port, caFile: credentials.caFile };
  } catch (error) { credentials.cleanup(); throw error; }
}
if (require.main === module) localServer().then(({ server, url, caFile }) => {
  console.log('LOCAL TEST CHAIN 31337 ready: ' + url);
  console.log('For setup/pay: UPAY_LOCAL_CA=' + caFile + ' UPAY_LOCAL_RPC_URL=' + url);
  console.log('Start the backend with NODE_EXTRA_CA_CERTS=' + caFile + ' (normal TLS verification remains enabled).');
  console.log('Ephemeral chain and CA, test accounts only. No private keys printed. Keep this process running while using its orders.');
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (!stopping) { stopping = true; await server.close(); process.exit(0); } });
}).catch(() => { console.error('Local chain failed; check port 18545, openssl, Node >=22.19 and Hardhat configuration.'); process.exitCode = 1; });
module.exports = { localServer };
