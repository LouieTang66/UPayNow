'use strict';
// Two independent in-process EVMs; no public RPC, fork or persistent user state.
const hre = require('hardhat');
const https = require('node:https');
const { ethers } = require('ethers');
const { createProvider } = require('hardhat/internal/core/providers/construction');
const { JsonRpcHandler } = require('hardhat/internal/hardhat-network/jsonrpc/handler');
const { createLocalTLS, trustCA } = require('./tls-local.cjs');
async function isolatedChain(chainId, artifacts) {
  const config = { ...hre.config, networks: { hardhat: { ...hre.config.networks.hardhat, chainId, forking: undefined } } };
  const evm = await createProvider(config, 'hardhat', hre.artifacts);
  const credentials = createLocalTLS();
  let listener, provider;
  try {
    trustCA(credentials.caFile);
    const handler = new JsonRpcHandler(evm);
    listener = https.createServer({ key: credentials.key, cert: credentials.cert }, handler.handleHttp);
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    const url = 'https://127.0.0.1:' + listener.address().port;
    provider = new ethers.JsonRpcProvider(url, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
    if (Number((await provider.getNetwork()).chainId) !== chainId) throw new Error('FIXTURE_CHAIN_ID_MISMATCH');
    const signer = await provider.getSigner(0), payout = await (await provider.getSigner(1)).getAddress();
    const deploy = async (artifact, args) => {
      const contract = await new ethers.ContractFactory(artifact.abi, artifact.evm.bytecode.object, signer).deploy(...args);
      await contract.waitForDeployment(); return contract;
    };
    const token = await deploy(artifacts.token, ['TEST_USDT', 6]);
    const factory = await deploy(artifacts.factory, [payout, [token.target]]);
    return { chainId, url, provider, evm, token, factory, payout,
      startBlock: (await factory.deploymentTransaction().wait()).blockNumber,
      close: async () => {
        provider.destroy();
        await new Promise(resolve => { listener.close(resolve); listener.closeIdleConnections(); });
        credentials.cleanup();
      } };
  } catch (error) {
    provider?.destroy();
    if (listener?.listening) await new Promise(resolve => listener.close(resolve));
    credentials.cleanup(); throw error;
  }
}
module.exports = { isolatedChain };
