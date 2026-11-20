'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { buildInput } = require('../../../scripts/build-input.cjs');
const { compileInput } = require('../../../scripts/compile.cjs');
function localArtifacts() {
  const input = buildInput();
  input.sources['backend/fixtures/LocalToken.sol'] = { content: fs.readFileSync(path.join(__dirname, '../../fixtures/LocalToken.sol'), 'utf8') };
  const result = compileInput(input);
  return { factory: result.contracts['src/ForwarderFactory.sol'].ForwarderFactory,
    token: result.contracts['backend/fixtures/LocalToken.sol'].LocalToken };
}
async function deployLocal(provider) {
  if (Number((await provider.getNetwork()).chainId) !== 31337) throw new Error('LOCAL_CHAIN_ONLY');
  const artifacts = localArtifacts(), signer = await provider.getSigner(0), payout = await (await provider.getSigner(1)).getAddress();
  const deploy = async (artifact, args) => {
    const c = await new ethers.ContractFactory(artifact.abi, artifact.evm.bytecode.object, signer).deploy(...args);
    await c.waitForDeployment(); return c;
  };
  const a = await deploy(artifacts.token, ['TEST_USDT', 6]);
  const b = await deploy(artifacts.token, ['TEST_USDC', 18]);
  const factory = await deploy(artifacts.factory, [payout, [a.target, b.target]]);
  return { a, b, factory, payout, artifacts, startBlock: (await factory.deploymentTransaction().wait()).blockNumber };
}
function localRpcProvider() {
  const rpcUrl = process.env.UPAY_LOCAL_RPC_URL || 'https://127.0.0.1:18545';
  const url = new URL(rpcUrl);
  if (url.protocol !== 'https:' || url.username || url.password ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('LOCAL_HTTPS_RPC_REQUIRED');
  if (process.env.UPAY_LOCAL_CA) require('./tls-local.cjs').trustCA(process.env.UPAY_LOCAL_CA);
  return new ethers.JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
}
module.exports = { localArtifacts, deployLocal, localRpcProvider };
