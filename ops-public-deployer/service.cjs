'use strict';
// Separate ops entrypoint: no merchant store, payout, tokens, private keys or signing.
const { ethers, requireValue: check } = require('../backend/chain.cjs');
const { rpcConfig, StrictProvider } = require('../backend/deployment-service.cjs');
const D = require('../backend/deterministic.cjs');
async function inspect(input, prepare = false) {
  check(input && Object.keys(input).every(k => ['chainId', 'rpcUrl', ...(prepare ? ['from'] : [])].includes(k)), 'OPS_SCOPE_OVERRIDE', 403);
  const config = rpcConfig(input), provider = new StrictProvider(config.rpcUrl);
  try {
    const root = await D.inspectRoot(provider, config);
    const result = { ...config, singleton: root.singleton, deployer: root.deployer, ready: root.deployerReady,
      creationCodeHash: ethers.keccak256(root.artifact.bytecode), runtimeCodeHash: ethers.keccak256(root.artifact.deployedBytecode), transaction: null };
    if (!prepare || root.deployerReady) return result;
    const from = ethers.getAddress(input.from); check(from !== ethers.ZeroAddress, 'INVALID_SENDER');
    const data = new ethers.Interface(D.singletonABI).encodeFunctionData('deploy', [root.artifact.bytecode, D.SALT]);
    const tx = { from, to: root.singleton, data, value: '0x0' };
    const outer = await provider.estimateGas(tx);
    const creation = await provider.estimateGas({ from, data: root.artifact.bytecode, value: '0x0' });
    const gas = (outer > creation ? outer : creation) * 120n / 100n;
    const simulated = await provider.call({ ...tx, gasLimit: gas });
    const [created] = new ethers.Interface(D.singletonABI).decodeFunctionResult('deploy', simulated);
    check(created.toLowerCase() === root.deployer.toLowerCase(), 'BOOTSTRAP_SIMULATION_FAILED', 409);
    const final = await D.inspectRoot(provider, config);
    if (final.deployerReady) return { ...result, ready: true };
    return { ...result, transaction: { ...tx, chainId: ethers.toQuantity(config.chainId), gas: ethers.toQuantity(gas) } };
  } finally { provider.destroy(); }
}
module.exports = { preview: input => inspect(input), prepare: input => inspect(input, true) };
