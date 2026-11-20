'use strict';
// Seed a pre-retirement READY record in isolated tests. No production opt-in,
// HTTP bypass, signer or broadcast; legacy creation is no longer a product API.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { ethers } = require('ethers');
const { normalized, StrictProvider, artifacts } = require('../../deployment-service.cjs');
async function historicalDeployment(service, input) {
  assert.equal(new URL(input.rpcUrl).hostname, '127.0.0.1');
  assert([31337,31338].includes(Number(input.chainId)), 'Historical fixture must use an isolated test chain');
  const summary = normalized({ ...input, scheme: 'legacy-v1' });
  const provider = new StrictProvider(summary.rpcUrl);
  try {
    summary.tokens = await Promise.all(input.tokens.map(async value => {
      const address = typeof value === 'string' ? value : value.address;
      const token = new ethers.Contract(address, ['function decimals() view returns(uint8)', 'function symbol() view returns(string)'], provider);
      return { address: ethers.getAddress(address), decimals: Number(await token.decimals()), symbol: await token.symbol() };
    }));
    const artifact = artifacts().ForwarderFactory;
    const { data } = await new ethers.ContractFactory(artifact.abi, artifact.bytecode).getDeployTransaction(summary.payout, summary.tokens.map(t => t.address));
    return service.view(service.save({ id: randomUUID(), state: 'READY', summary, data, createdAt: new Date().toISOString() }));
  } finally { provider.destroy(); }
}
module.exports = { historicalDeployment };
