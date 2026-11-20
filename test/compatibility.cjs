'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { buildInput } = require('../scripts/build-input.cjs');
const { compileInput } = require('../scripts/compile.cjs');

async function main() {
  const hardfork = process.argv[2];
  assert.ok(['cancun', 'shanghai'].includes(hardfork), 'Choose cancun or shanghai');
  // A fresh process per VM is essential: hardhat_reset cannot change hardfork.
  const hre = require('hardhat');
  for (const config of [hre.config.networks.hardhat, hre.network.config]) {
    config.hardfork = hardfork;
    config.throwOnTransactionFailures = false;
  }
  const rpc = hre.network.provider;
  const provider = new ethers.BrowserProvider(rpc, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 10;
  assert.equal(await provider.send('eth_chainId', []), '0x7a69');
  const signer = await provider.getSigner(0);
  const payout = await (await provider.getSigner(1)).getAddress();
  const canonical = buildInput();
  const input = structuredClone(canonical);
  for (const name of ['MockToken.sol', 'Compatibility.sol']) {
    input.sources[`test/${name}`] = { content: fs.readFileSync(path.join(__dirname, name), 'utf8') };
  }
  const output = compileInput(input);
  const artifact = name => {
    for (const contracts of Object.values(output.contracts)) if (contracts[name]) return contracts[name];
    throw new Error(`Missing ${name}`);
  };
  const fa = artifact('ForwarderFactory');
  const canonicalFa = compileInput(canonical).contracts['src/ForwarderFactory.sol'].ForwarderFactory;
  assert.equal(fa.evm.bytecode.object, canonicalFa.evm.bytecode.object);
  assert.equal(fa.evm.deployedBytecode.object, canonicalFa.evm.deployedBytecode.object);
  const deploy = async (a, args = []) => {
    const c = await new ethers.ContractFactory(a.abi, a.evm.bytecode.object, signer).deploy(...args);
    await c.waitForDeployment();
    return c;
  };
  const token = await deploy(artifact('MockToken'));
  if (hardfork === 'cancun') {
    const factory = await deploy(fa, [payout, [token.target]]);
    const order = ethers.id('cancun-real-guard-roundtrip');
    const address = await factory.predictAddress(order);
    await (await token.mint(address, 123n)).wait();
    await (await factory.collect(order, token.target)).wait();
    assert.equal(await token.balanceOf(payout), 123n);
    assert.equal(await token.balanceOf(address), 0n);
    console.log('PASS compatibility Cancun: canonical Factory deploys and prefunded order settles');
    const harness = await deploy(artifact('CompatibilityHarness'));
    const receipt = await (await harness.constructAndCollect(payout, token.target)).wait();
    const event = receipt.logs.map(l => { try { return harness.interface.parseLog(l); } catch { return null; } })
      .find(e => e?.name === 'ConstructedAndCollected');
    assert.ok(event);
    assert.equal(event.args.amount, 0n);
    assert.notEqual(await provider.getCode(event.args.factory), '0x');
    console.log('PASS compatibility Cancun: construction and collect in same transaction prove guard is cleared');
  } else {
    const data = new ethers.ContractFactory(fa.abi, fa.evm.bytecode.object, signer);
    const creation = await data.getDeployTransaction(payout, [token.target]);
    const sent = await signer.sendTransaction({ ...creation, gasLimit: 10_000_000n });
    const receipt = await provider.send('eth_getTransactionReceipt', [sent.hash]);
    assert.equal(BigInt(receipt.status), 0n, 'Unsupported VM must reject Factory deployment');
    const predicted = ethers.getCreateAddress({ from: sent.from, nonce: sent.nonce });
    assert.equal(await provider.getCode(predicted), '0x');
    const trace = await provider.send('debug_traceTransaction', [sent.hash, { disableMemory: true, disableStorage: true }]);
    const last = trace.structLogs.at(-1);
    assert.ok(last);
    assert.equal(last.depth, 1);
    assert.equal(fa.evm.bytecode.object.slice(last.pc * 2, last.pc * 2 + 2), '5c', 'Deployment must fail specifically at constructor TLOAD');
    console.log(`PASS compatibility Shanghai: creation status=0, no Factory code, rejected at TLOAD pc=${last.pc}`);

    // Negative control changes only the constructor modifier, in memory. This
    // rules out an unrelated compiler/parameter failure producing a false pass.
    const unguarded = structuredClone(canonical);
    const source = unguarded.sources['src/ForwarderFactory.sol'].content;
    const marker = 'constructor(address payout_, address[] memory settlementTokens_) nonReentrant {';
    assert.ok(source.includes(marker));
    unguarded.sources['src/ForwarderFactory.sol'].content = source.replace(marker,
      'constructor(address payout_, address[] memory settlementTokens_) {');
    const control = compileInput(unguarded).contracts['src/ForwarderFactory.sol'].ForwarderFactory;
    const oldBehavior = await deploy(control, [payout, [token.target]]);
    assert.notEqual(await provider.getCode(oldBehavior.target), '0x');
    await assert.rejects(oldBehavior.collect.staticCall(ethers.ZeroHash, token.target),
      error => error.code === 'CALL_EXCEPTION' && typeof error.data === 'string');
    console.log('PASS compatibility Shanghai negative control: removing only probe permits deployment but collect fails');
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
