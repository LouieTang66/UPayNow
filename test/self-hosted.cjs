'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const solc = require('solc');
const { ethers } = require('ethers');
const hre = require('hardhat');
const { buildInput } = require('../scripts/build-input.cjs');
const { compileInput, SOLC_LONG_VERSION } = require('../scripts/compile.cjs');

async function main() {
  assert.equal(await hre.network.provider.send('eth_chainId'), '0x7a69');
  const input = buildInput(process.env.UPAY_TEST_SOURCE);
  if (!process.env.UPAY_TEST_SOURCE) {
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(__dirname, '../contracts/standard-json-input.json'), 'utf8')), input);
  }
  for (const file of ['MockToken.sol', 'Adversarial.sol']) {
    input.sources[`test/${file}`] = { content: fs.readFileSync(path.join(__dirname, file), 'utf8') };
  }
  console.log(`Compiler ${solc.version()}; optimizer ${input.settings.optimizer.runs}; ${input.settings.evmVersion}; viaIR ${input.settings.viaIR}`);
  const output = compileInput(input);
  const errors = (output.errors || []).filter(e => e.severity === 'error');
  assert.equal(errors.length, 0, errors.map(e => e.formattedMessage).join('\n'));
  for (const warning of (output.errors || []).filter(e => e.severity !== 'error')) console.log(warning.formattedMessage);
  const artifact = name => {
    for (const contracts of Object.values(output.contracts)) if (contracts[name]) return contracts[name];
    throw new Error(`Missing compiled artifact ${name}`);
  };
  const fa = artifact('ForwarderFactory');
  const fi = artifact('ForwarderImpl');
  const factoryInterface = new ethers.Interface(fa.abi);
  const forwarderInterface = new ethers.Interface(fi.abi);
  const names = fa.abi.filter(x => x.type === 'function').map(x => x.name).sort();
  const expectedNames = ['SALT_VERSION', 'collect', 'collectBatch',
    'collectBatchItem', 'collectWrongToken', 'computeSalt', 'deploy', 'forwarderCodehash', 'implementation',
    'isForwarder', 'payout', 'predictAddress', 'isSupportedToken', 'getSettlementTokens'].sort();
  // Negative control: old fee/hold/admin ABI must fail here, not quietly pass.
  assert.deepEqual(names, expectedNames, 'Only the fixed-payout multi-CA ABI may remain');
  assert.deepEqual(fa.abi.find(x => x.type === 'constructor').inputs.map(x => x.name), ['payout_', 'settlementTokens_']);
  for (const contract of [fa, fi]) {
    const size = contract.evm.deployedBytecode.object.length / 2;
    assert.ok(size <= 24576);
    console.log(`Runtime bytes: ${size}`);
  }
  // Tests change token state and retry identical calls within milliseconds.
  // Do not reuse ethers' short-lived estimateGas cache across those changes.
  const provider = new ethers.BrowserProvider(hre.network.provider, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 10;
  const deployer = await provider.getSigner(0);
  const merchant = await provider.getSigner(1);
  const stranger = await provider.getSigner(2);
  const payout = await merchant.getAddress();
  const strangerAddress = await stranger.getAddress();
  const deployerAddress = await deployer.getAddress();
  const tx = async promise => (await promise).wait();
  async function deploy(name, args = [], signer = deployer) {
    const a = artifact(name);
    const c = await new ethers.ContractFactory(a.abi, a.evm.bytecode.object, signer).deploy(...args);
    await c.waitForDeployment();
    return c;
  }
  async function fails(promise, errorName) {
    await assert.rejects(promise, err => {
      if (!errorName) return true;
      const data = err.data || err.info?.error?.data;
      if (typeof data !== 'string') return false;
      for (const iface of [factoryInterface, forwarderInterface]) {
        try { if (iface.parseError(data)?.name === errorName) return true; } catch {}
      }
      return false;
    }, errorName || 'Expected revert');
  }
  function events(receipt, factory) {
    return receipt.logs.filter(l => l.address.toLowerCase() === factory.target.toLowerCase())
      .map(l => { try { return factoryInterface.parseLog(l); } catch { return null; } }).filter(Boolean);
  }
  const select = (receipt, f, name) => events(receipt, f).filter(e => e.name === name);
  const requests = (ids, token) => ids.map(orderIdHash => ({ orderIdHash, token }));
  let count = 0;
  async function test(name, fn) { await fn(); console.log(`PASS ${++count}: ${name}`); }
  const token = await deploy('MockToken');
  const wrong = await deploy('MockToken');
  const second = await deploy('MockToken');
  const factory = await deploy('ForwarderFactory', [payout, [token.target, second.target]]);
  let nextOrder = 0;
  async function order(amount, f = factory, t = token, id) {
    const hash = id || ethers.id(`self-hosted-order-${++nextOrder}`);
    const address = await f.predictAddress(hash);
    if (amount) await tx(t.mint(address, amount));
    return { hash, address };
  }
  async function assertNoCode(address) { assert.equal(await provider.send('eth_getCode', [address, 'latest']), '0x'); }

  await test('Hardhat artifacts match tested bytecode and canonical Standard JSON settings', async () => {
    if (process.env.UPAY_TEST_SOURCE) return; // baseline negative controls use different sources
    const canonical = buildInput();
    for (const key of ['optimizer', 'evmVersion', 'viaIR', 'metadata']) {
      assert.deepEqual(hre.config.solidity.compilers[0].settings[key], canonical.settings[key]);
    }
    for (const name of ['ForwarderFactory', 'ForwarderImpl']) {
      const qualified = `src/${name}.sol:${name}`;
      const saved = await hre.artifacts.readArtifact(qualified);
      const tested = artifact(name);
      assert.deepEqual(saved.abi, tested.abi);
      assert.equal(saved.bytecode, `0x${tested.evm.bytecode.object}`);
      assert.equal(saved.deployedBytecode, `0x${tested.evm.deployedBytecode.object}`);
      const info = await hre.artifacts.getBuildInfo(qualified);
      assert.ok(info);
      assert.equal(info.solcLongVersion, SOLC_LONG_VERSION);
      assert.deepEqual(info.input, canonical);
    }
  });
  await test('ABI has no fees, holds, pause, admin, recipient setters or upgrades', async () => {
    assert.deepEqual(names, expectedNames);
    for (const name of ['deploy', 'predictAddress']) {
      assert.deepEqual(factoryInterface.getFunction(name).inputs.map(x => x.type), ['bytes32']);
    }
    for (const name of ['collect', 'collectBatchItem']) assert.deepEqual(factoryInterface.getFunction(name).inputs.map(x => x.type), ['bytes32', 'address']);
    assert.equal(factoryInterface.getFunction('collectBatch').inputs[0].type, 'tuple[]');
    assert.deepEqual(factoryInterface.getFunction('collectWrongToken').inputs.map(x => x.type), ['bytes32', 'address']);
    assert.equal(fa.abi.some(x => x.type === 'receive' || x.type === 'fallback'), false);
    assert.equal(fi.abi.some(x => x.name === 'initialize'), false);
    for (const obsolete of ['InsufficientBatchGas', 'BATCH_ITEM_GAS_LIMIT', 'SettlementAmountMismatch', 'MAX_BATCH', 'BatchLimit']) {
      assert.equal([...fa.abi, ...fi.abi].some(x => x.name === obsolete), false);
    }
    assert.equal(names.some(n => /paid|paymentStatus|expiry|deadline|confirmation|requiredAmount/i.test(n)), false);
  });
  await test('deployment permanently binds payout/token list independently of deployer', async () => {
    assert.equal(await factory.payout(), payout);
    assert.deepEqual(Array.from(await factory.getSettlementTokens()), [token.target, second.target]);
    const impl = new ethers.Contract(await factory.implementation(), fi.abi, provider);
    assert.equal(await impl.hub(), factory.target);
    assert.equal(await impl.payout(), payout);
    assert.equal(fi.abi.some(x => x.name === 'settlementToken'), false);
    assert.equal(await factory.isSupportedToken(token.target), true);
    assert.equal(await factory.isSupportedToken(second.target), true);
    assert.equal(await factory.isSupportedToken(wrong.target), false);
    const separate = await deploy('ForwarderFactory', [payout, [token.target]], stranger);
    assert.equal(await separate.payout(), payout);
    assert.notEqual(separate.target, factory.target);
  });
  await test('invalid payout/token constructor parameters are rejected', async () => {
    for (const [p, t] of [[ethers.ZeroAddress, token.target], [token.target, token.target], [payout, ethers.ZeroAddress], [payout, strangerAddress]]) {
      await fails(deploy('ForwarderFactory', [p, [t]]));
    }
    // Predict the next factory's own CREATE address and reject it as payout.
    const nonce = await provider.getTransactionCount(deployerAddress, 'pending');
    const self = ethers.getCreateAddress({ from: deployerAddress, nonce });
    await fails(deploy('ForwarderFactory', [self, [token.target]]), 'InvalidPayout');
  });
  await test('CREATE2 prediction matches independent EIP-1167 calculation and distinct orders', async () => {
    const hash = ethers.id('independent-prediction');
    const salt = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint8', 'bytes32', 'address'], [3, hash, payout]));
    assert.equal(await factory.computeSalt(hash), salt);
    const initCode = ethers.concat(['0x3d602d80600a3d3981f3', '0x363d3d373d3d3d363d73', await factory.implementation(), '0x5af43d82803e903d91602b57fd5bf3']);
    assert.equal(await factory.predictAddress(hash), ethers.getCreate2Address(factory.target, salt, ethers.keccak256(initCode)));
    assert.notEqual(await factory.predictAddress(hash), await factory.predictAddress(ethers.id('other-order')));
    const second = await deploy('ForwarderFactory', [strangerAddress, [token.target]]);
    assert.notEqual(await factory.predictAddress(hash), await second.predictAddress(hash));
    await tx(factory.deploy(ethers.ZeroHash)); // all bytes32 order IDs, including zero, are valid
  });
  await test('stranger may front-run deployment but cannot initialize or replace recipient', async () => {
    const o = await order(12345n);
    await assertNoCode(o.address);
    const receipt = await tx(factory.connect(stranger).deploy(o.hash));
    assert.equal(select(receipt, factory, 'ForwarderDeployed').length, 1);
    assert.equal(await factory.isForwarder(o.address), true);
    const clone = new ethers.Contract(o.address, fi.abi, stranger);
    assert.equal(await clone.payout(), payout);
    assert.equal(await clone.hub(), factory.target);
    assert.equal(forwarderInterface.hasFunction('settlementToken'), false);
    for (const sig of ['initialize(address)', 'setPayout(address)', 'transferOwnership(address)']) {
      const iface = new ethers.Interface([`function ${sig}`]);
      await fails(stranger.sendTransaction({ to: o.address, data: iface.encodeFunctionData(sig.split('(')[0], [strangerAddress]) }));
    }
    await fails(clone.sweepSettlementToken.staticCall(token.target), 'OnlyHub');
    await fails(clone.sweepWrongToken.staticCall(wrong.target), 'OnlyHub');
    const before = await token.balanceOf(payout);
    await tx(factory.connect(stranger).collect(o.hash, token.target));
    assert.equal((await token.balanceOf(payout)) - before, 12345n);
    assert.equal(await token.balanceOf(strangerAddress), 0n);
    assert.equal(select(await tx(factory.deploy(o.hash)), factory, 'ForwarderDeployed').length, 0);
  });
  await test('single prefunded order transfers directly to payout, never Factory', async () => {
    const amount = ethers.parseEther('100');
    const o = await order(amount);
    const before = await token.balanceOf(payout);
    const receipt = await tx(factory.connect(stranger).collect(o.hash, token.target));
    assert.equal((await token.balanceOf(payout)) - before, amount);
    assert.equal(await token.balanceOf(o.address), 0n);
    assert.equal(await token.balanceOf(factory.target), 0n);
    const transfers = receipt.logs.filter(l => l.address.toLowerCase() === token.target.toLowerCase())
      .map(l => token.interface.parseLog(l)).filter(e => e.name === 'Transfer');
    assert.equal(transfers.length, 1);
    assert.equal(transfers[0].args.from, o.address);
    assert.equal(transfers[0].args.to, payout);
    const collected = select(receipt, factory, 'Collected');
    assert.equal(collected.length, 1);
    assert.equal(collected[0].args.amount, amount);
    assert.equal(collected[0].args.orderIdHash, o.hash);
  });
  await test('settlement reads only the order balance before transfer, not payout or post-transfer balances', async () => {
    const o = await order(19n);
    const receipt = await tx(factory.collect(o.hash, token.target));
    const trace = await provider.send('debug_traceTransaction', [receipt.hash,
      { disableStorage: true, disableMemory: false }]);
    const reads = [];
    for (const step of trace.structLogs) {
      if (step.op !== 'STATICCALL') continue;
      const stack = step.stack;
      const target = `0x${stack[stack.length - 2].slice(-40)}`;
      if (target.toLowerCase() !== token.target.toLowerCase()) continue;
      const offset = Number(BigInt(`0x${stack[stack.length - 3]}`));
      const size = Number(BigInt(`0x${stack[stack.length - 4]}`));
      const data = `0x${step.memory.join('').slice(offset * 2, (offset + size) * 2)}`;
      reads.push(data);
    }
    assert.deepEqual(reads, [token.interface.encodeFunctionData('balanceOf', [o.address])]);
  });
  await test('tiny and empty collections do not imply payment status or double-transfer', async () => {
    const o = await order(1n);
    const before = await token.balanceOf(payout);
    assert.equal(select(await tx(factory.collect(o.hash, token.target)), factory, 'Collected')[0].args.amount, 1n);
    assert.equal(select(await tx(factory.collect(o.hash, token.target)), factory, 'Collected').length, 0);
    const empty = await order(0n);
    assert.equal(select(await tx(factory.collect(empty.hash, token.target)), factory, 'Collected').length, 0);
    assert.equal((await token.balanceOf(payout)) - before, 1n);
  });
  await test('historical address accepts late deposits without expiry or backend authorization', async () => {
    const o = await order(3n);
    await tx(factory.collect(o.hash, token.target));
    await hre.network.provider.send('evm_increaseTime', [120 * 86400]);
    await hre.network.provider.send('evm_mine');
    const before = await token.balanceOf(payout);
    await tx(token.mint(o.address, 321n));
    await tx(factory.connect(stranger).collect(o.hash, token.target));
    assert.equal((await token.balanceOf(payout)) - before, 321n);
  });
  await test('permissionless batch settles fresh and deployed orders, including duplicates', async () => {
    const a = await order(11n), b = await order(22n);
    await tx(factory.deploy(b.hash));
    const before = await token.balanceOf(payout);
    assert.deepEqual(Array.from(await factory.connect(stranger).collectBatch.staticCall(requests([a.hash, b.hash, a.hash], token.target))), [3n, 0n]);
    const receipt = await tx(factory.connect(stranger).collectBatch(requests([a.hash, b.hash, a.hash], token.target)));
    assert.equal(select(receipt, factory, 'Collected').length, 2);
    assert.equal((await token.balanceOf(payout)) - before, 33n);
    assert.equal(await token.balanceOf(factory.target), 0n);
  });
  await test('failed single transfer rolls back deployment and leaves prefunded assets untouched', async () => {
    const o = await order(55n);
    await tx(token.setBlocked(o.address, true));
    await fails(factory.collect.staticCall(o.hash, token.target));
    // Exercise an actual reverted transaction, not only an eth_call.
    await fails(tx(factory.collect(o.hash, token.target, { gasLimit: 500000 })));
    await assertNoCode(o.address);
    assert.equal(await factory.isForwarder(o.address), false);
    assert.equal(await token.balanceOf(o.address), 55n);
    await tx(token.setBlocked(o.address, false));
    await tx(factory.collect(o.hash, token.target));
  });
  await test('batch isolates blocked middle item across entire deployment and transfer', async () => {
    const a = await order(101n), b = await order(202n), c = await order(303n);
    await tx(token.setBlocked(b.address, true));
    const before = await token.balanceOf(payout);
    assert.deepEqual(Array.from(await factory.collectBatch.staticCall(requests([a.hash, b.hash, c.hash], token.target))), [2n, 1n]);
    const receipt = await tx(factory.collectBatch(requests([a.hash, b.hash, c.hash], token.target)));
    assert.equal((await token.balanceOf(payout)) - before, 404n);
    assert.equal(select(receipt, factory, 'Collected').length, 2);
    const failures = select(receipt, factory, 'CollectFailed');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].args.orderIdHash, b.hash);
    assert.equal(failures[0].args.reasonSelector, '0x08c379a0');
    assert.equal(await token.balanceOf(b.address), 202n);
    await assertNoCode(b.address);
    assert.equal(await factory.isForwarder(b.address), false);
    await tx(token.setBlocked(b.address, false));
    await tx(factory.collect(b.hash, token.target));
  });
  await test('payout blacklist makes all items fail without moving funds, then retry succeeds', async () => {
    const a = await order(31n), b = await order(32n);
    await tx(token.setBlocked(payout, true));
    const before = await token.balanceOf(payout);
    const receipt = await tx(factory.collectBatch(requests([a.hash, b.hash], token.target)));
    assert.equal(select(receipt, factory, 'CollectFailed').length, 2);
    assert.equal(select(receipt, factory, 'Collected').length, 0);
    assert.equal(await token.balanceOf(payout), before);
    assert.equal(await token.balanceOf(a.address), 31n);
    assert.equal(await token.balanceOf(b.address), 32n);
    await tx(token.setBlocked(payout, false));
    await tx(factory.collectBatch(requests([a.hash, b.hash], token.target)));
  });
  await test('batch has no fixed gas reserve; ordinary one-item collection fits its estimated budget', async () => {
    const o = await order(17n);
    const estimate = await factory.collectBatch.estimateGas(requests([o.hash], token.target));
    assert.ok(estimate < 200000n, `Unexpected one-item estimate ${estimate}`);
    const receipt = await tx(factory.collectBatch(requests([o.hash], token.target), { gasLimit: 200000 }));
    assert.equal(select(receipt, factory, 'Collected').length, 1);
    assert.equal(await token.balanceOf(o.address), 0n);
  });
  await test('empty batches still revert without creating orders', async () => {
    await fails(factory.collectBatch.staticCall(requests([], token.target)), 'EmptyBatch');
    await fails(tx(factory.collectBatch(requests([], token.target), { gasLimit: 100000 })));
  });
  await test('batch above the former 50-item ceiling succeeds using execution-based gas estimation', async () => {
    const orders = [];
    for (let i = 0; i < 60; ++i) orders.push(await order(BigInt(i + 1)));
    const before = await token.balanceOf(payout);
    const hashes = orders.map(o => o.hash);
    const expected = orders.reduce((sum, _, i) => sum + BigInt(i + 1), 0n);
    const estimate = await factory.collectBatch.estimateGas(requests(hashes, token.target));
    const gasLimit = estimate + estimate / 5n;
    assert.deepEqual(Array.from(await factory.collectBatch.staticCall(requests(hashes, token.target), { gasLimit })), [60n, 0n]);
    const receipt = await tx(factory.connect(stranger).collectBatch(requests(hashes, token.target), { gasLimit }));
    assert.equal(select(receipt, factory, 'Collected').length, 60);
    assert.equal(select(receipt, factory, 'CollectFailed').length, 0);
    assert.equal((await token.balanceOf(payout)) - before, expected);
    for (const o of orders) assert.equal(await token.balanceOf(o.address), 0n);
    console.log(`  60-item batch gas estimate/used: ${estimate}/${receipt.gasUsed}`);
  });
  await test('internal per-item entry point cannot be called by strangers or deployer', async () => {
    const o = await order(0n);
    await fails(factory.connect(stranger).collectBatchItem.staticCall(o.hash, token.target), 'OnlySelf');
    await fails(factory.collectBatchItem.staticCall(o.hash, token.target), 'OnlySelf');
  });
  await test('same-runtime foreign clones are not registered and cannot be swept via this Factory', async () => {
    const cloner = await deploy('ForeignCloner');
    const salt = ethers.id('foreign-clone');
    const foreign = await cloner.predict(await factory.implementation(), salt);
    await tx(cloner.clone(await factory.implementation(), salt));
    assert.equal(ethers.keccak256(await provider.send('eth_getCode', [foreign, 'latest'])), await factory.forwarderCodehash());
    assert.equal(await factory.isForwarder(foreign), false);
    await tx(token.mint(foreign, 19n));
    await fails(new ethers.Contract(foreign, fi.abi, stranger).sweepSettlementToken.staticCall(token.target), 'OnlyHub');
    // Passing foreign address bytes as an order ID derives a DIFFERENT registered order.
    const foreignHash = ethers.zeroPadValue(foreign, 32);
    await tx(factory.collect(foreignHash, token.target));
    assert.equal(await token.balanceOf(foreign), 19n);
  });
  await test('normal collect never touches wrong ERC-20 or native assets', async () => {
    const o = await order(70n);
    await tx(wrong.mint(o.address, 80n));
    await tx(deployer.sendTransaction({ to: o.address, value: 90n }));
    await tx(factory.collect(o.hash, token.target));
    assert.equal(await wrong.balanceOf(o.address), 80n);
    assert.equal(BigInt(await provider.send('eth_getBalance', [o.address, 'latest'])), 90n);
    const before = await wrong.balanceOf(payout);
    const receipt = await tx(factory.connect(stranger).collectWrongToken(o.hash, wrong.target));
    assert.equal((await wrong.balanceOf(payout)) - before, 80n);
    assert.equal(select(receipt, factory, 'WrongTokenCollected')[0].args.amountSent, 80n);
    const beforeNative = BigInt(await provider.send('eth_getBalance', [payout, 'latest']));
    await tx(factory.connect(stranger).collectWrongToken(o.hash, ethers.ZeroAddress));
    assert.equal(BigInt(await provider.send('eth_getBalance', [payout, 'latest'])) - beforeNative, 90n);
    assert.equal(await wrong.balanceOf(factory.target), 0n);
  });
  await test('manual wrong-token sweep deploys counterfactual order and rejects settlement/EOA tokens', async () => {
    const o = await order(0n);
    await tx(wrong.mint(o.address, 45n));
    await assertNoCode(o.address);
    const before = await wrong.balanceOf(payout);
    await tx(factory.connect(stranger).collectWrongToken(o.hash, wrong.target));
    assert.equal((await wrong.balanceOf(payout)) - before, 45n);
    await fails(factory.collectWrongToken.staticCall(o.hash, token.target), 'SettlementTokenProtected');
    await fails(factory.collectWrongToken.staticCall(o.hash, strangerAddress), 'InvalidToken');
    assert.equal(select(await tx(factory.collectWrongToken(o.hash, wrong.target)), factory, 'WrongTokenCollected').length, 0);
  });
  await test('predeployment native deposit can be recovered manually straight to payout', async () => {
    const o = await order(0n);
    await tx(deployer.sendTransaction({ to: o.address, value: 123n, gasLimit: 21000 }));
    const before = BigInt(await provider.send('eth_getBalance', [payout, 'latest']));
    await tx(factory.connect(stranger).collectWrongToken(o.hash, ethers.ZeroAddress));
    assert.equal(BigInt(await provider.send('eth_getBalance', [payout, 'latest'])) - before, 123n);
  });
  await test('native recipient rejection rolls back; reentrant recipient cannot resweep', async () => {
    const receiver = await deploy('PayoutReceiver');
    const f = await deploy('ForwarderFactory', [receiver.target, [token.target]]);
    const o = await order(0n, f);
    await tx(deployer.sendTransaction({ to: o.address, value: 987n }));
    await tx(receiver.configure(true, ethers.ZeroAddress, '0x'));
    await fails(tx(f.collectWrongToken(o.hash, ethers.ZeroAddress, { gasLimit: 500000 })));
    await assertNoCode(o.address);
    assert.equal(BigInt(await provider.send('eth_getBalance', [o.address, 'latest'])), 987n);
    await tx(receiver.configure(false, f.target, f.interface.encodeFunctionData('collectWrongToken', [o.hash, ethers.ZeroAddress])));
    const receipt = await tx(f.collectWrongToken(o.hash, ethers.ZeroAddress));
    assert.equal(select(receipt, f, 'WrongTokenCollected').length, 1);
    assert.equal(await receiver.lastCallbackSucceeded(), false);
    assert.equal(BigInt(await provider.send('eth_getBalance', [receiver.target, 'latest'])), 987n);
  });
  await test('legacy non-returning ERC-20 supports direct single and batch transfers', async () => {
    const t = await deploy('NoReturnToken');
    const f = await deploy('ForwarderFactory', [payout, [t.target]]);
    const a = await order(55n, f, t), b = await order(66n, f, t);
    const before = await t.balanceOf(payout);
    await tx(f.connect(stranger).collect(a.hash, (await f.getSettlementTokens())[0]));
    await tx(f.connect(stranger).collectBatch(requests([b.hash], (await f.getSettlementTokens())[0])));
    assert.equal((await t.balanceOf(payout)) - before, 121n);
    assert.equal(await t.balanceOf(f.target), 0n);
  });
  const adversarial = await deploy('TransferTestToken');
  const af = await deploy('ForwarderFactory', [payout, [adversarial.target]]);
  await test('SafeERC20 false-return failure rolls back and does not block ordinary batch siblings', async () => {
    const bad = await order(100n, af, adversarial), good = await order(7n, af, adversarial);
    await tx(adversarial.setReturnFalse(bad.address, true));
    const before = await adversarial.balanceOf(payout);
    await fails(tx(af.collect(bad.hash, adversarial.target, { gasLimit: 500000 })));
    await assertNoCode(bad.address);
    assert.equal(await af.isForwarder(bad.address), false);
    const hashes = [bad.hash, good.hash];
    const estimate = await af.collectBatch.estimateGas(requests(hashes, adversarial.target));
    const receipt = await tx(af.collectBatch(requests(hashes, adversarial.target), { gasLimit: estimate + estimate / 5n }));
    assert.equal(select(receipt, af, 'CollectFailed').length, 1);
    assert.equal(select(receipt, af, 'Collected').length, 1);
    assert.equal((await adversarial.balanceOf(payout)) - before, 7n);
    assert.equal(await adversarial.balanceOf(bad.address), 100n);
    await assertNoCode(bad.address);
    await tx(adversarial.setReturnFalse(bad.address, false));
    await tx(af.collect(bad.hash, adversarial.target));
  });
  await test('token callbacks cannot reenter single/batch/wrong-token/internal entry points', async () => {
    for (const name of ['collect', 'collectBatch', 'collectWrongToken', 'collectBatchItem']) {
      const o = await order(33n, af, adversarial);
      const args = name === 'collectBatch' ? [requests([o.hash], adversarial.target)] : name === 'collectWrongToken' ? [o.hash, ethers.ZeroAddress] : [o.hash, adversarial.target];
      await tx(adversarial.setCallback(o.address, af.target, af.interface.encodeFunctionData(name, args)));
      const before = await adversarial.balanceOf(payout);
      await tx(af.collect(o.hash, adversarial.target));
      assert.equal(await adversarial.lastCallbackSucceeded(), false);
      assert.equal((await adversarial.balanceOf(payout)) - before, 33n);
    }
    const o = await order(34n, af, adversarial);
    await tx(adversarial.setCallback(o.address, af.target, af.interface.encodeFunctionData('collectBatch', [requests([o.hash], adversarial.target)])));
    await tx(af.collectBatch(requests([o.hash], adversarial.target)));
    assert.equal(await adversarial.lastCallbackSucceeded(), false);
  });
  await test('manual wrong-token callback cannot reenter collection of the trusted settlement token', async () => {
    const o = await order(29n);
    await tx(adversarial.mint(o.address, 13n));
    await tx(adversarial.setCallback(o.address, factory.target,
      factory.interface.encodeFunctionData('collect', [o.hash, token.target])));
    const receipt = await tx(factory.collectWrongToken(o.hash, adversarial.target));
    assert.equal(await adversarial.lastCallbackSucceeded(), false);
    assert.equal(select(receipt, factory, 'Collected').length, 0);
    assert.equal(select(receipt, factory, 'WrongTokenCollected').length, 1);
    assert.equal(await token.balanceOf(o.address), 29n);
    await tx(factory.collect(o.hash, token.target));
    assert.equal(await token.balanceOf(o.address), 0n);
  });
  await test('factory rejects native deposits and cannot sweep an accidentally sent ERC-20', async () => {
    const f = await deploy('ForwarderFactory', [payout, [token.target]]);
    await fails(stranger.sendTransaction({ to: f.target, value: 1n }));
    await tx(wrong.mint(f.target, 17n));
    const o = await order(0n, f);
    await tx(f.collectWrongToken(o.hash, wrong.target));
    assert.equal(await wrong.balanceOf(f.target), 17n);
    assert.equal(names.some(n => /recover|admin|owner|upgrade/i.test(n)), false);
  });
  await test('server/deployer cannot call old setters to redirect fixed payout', async () => {
    for (const name of ['setPayout', 'setFeeRecipient', 'transferAdmin', 'upgradeTo']) {
      const iface = new ethers.Interface([`function ${name}(address)`]);
      await fails(deployer.sendTransaction({ to: factory.target, data: iface.encodeFunctionData(name, [strangerAddress]) }));
    }
    assert.equal(await factory.payout(), payout);
    assert.deepEqual(Array.from(await factory.getSettlementTokens()), [token.target, second.target]);
    // A new factory does not invalidate funded old orders or change their payout.
    const o = await order(71n);
    await deploy('ForwarderFactory', [strangerAddress, [token.target]]);
    const before = await token.balanceOf(payout);
    await tx(factory.connect(stranger).collect(o.hash, token.target));
    assert.equal((await token.balanceOf(payout)) - before, 71n);
  });
  await test('seeded mixed deposits/single/batch operations conserve all settlement assets', async () => {
    const t = await deploy('MockToken');
    const f = await deploy('ForwarderFactory', [payout, [t.target]]);
    const orders = [];
    for (let i = 0; i < 8; ++i) orders.push(await order(0n, f, t));
    let seed = 638n, minted = 0n;
    for (let i = 0; i < 36; ++i) {
      seed = (seed * 1103515245n + 12345n) % 2147483648n;
      const index = Number(seed % 8n), amount = seed % 100000n + 1n;
      await tx(t.mint(orders[index].address, amount));
      minted += amount;
      if (i % 3 === 0) await tx(f.connect(stranger).collect(orders[index].hash, (await f.getSettlementTokens())[0]));
      else if (i % 3 === 1) await tx(f.connect(stranger).collectBatch(requests([orders[index].hash, orders[(index + 1) % 8].hash], (await f.getSettlementTokens())[0])));
      const balances = await Promise.all(orders.map(o => t.balanceOf(o.address)));
      const accounted = balances.reduce((a, b) => a + b, 0n) + await t.balanceOf(payout);
      assert.equal(accounted, minted);
      assert.equal(await t.balanceOf(f.target), 0n);
      assert.equal(await t.balanceOf(strangerAddress), 0n);
    }
    await tx(f.collectBatch(requests(orders.map(o => o.hash), (await f.getSettlementTokens())[0])));
    assert.equal(await t.balanceOf(payout), minted);
  });
  await test('runtime-code shape alone is rejected without factory registration', async () => {
    const existing = await order(0n);
    await tx(factory.deploy(existing.hash));
    const runtime = await provider.send('eth_getCode', [existing.address, 'latest']);
    const forged = await order(0n);
    // Local fault injection only: no external account can normally install code
    // at this factory's CREATE2 address. Exercise the defense-in-depth branch.
    await hre.network.provider.send('hardhat_setCode', [forged.address, runtime]);
    await fails(factory.deploy.staticCall(forged.hash), 'UnknownForwarder');
    await fails(factory.collect.staticCall(forged.hash, token.target), 'UnknownForwarder');
    await hre.network.provider.send('hardhat_setCode', [forged.address, '0x']);
    await tx(factory.deploy(forged.hash));
    assert.equal(await factory.isForwarder(forged.address), true);
    await hre.network.provider.send('hardhat_setCode', [forged.address, '0x00']);
    await fails(factory.deploy.staticCall(forged.hash), 'UnknownForwarder');
    await hre.network.provider.send('hardhat_setCode', [forged.address, runtime]);
  });
  await test('fixed supported-token registry rejects empty, duplicate, EOA and payout entries; no mutation API', async () => {
    await fails(deploy('ForwarderFactory', [payout, []]), 'EmptySettlementTokens');
    await fails(deploy('ForwarderFactory', [payout, [token.target, token.target]]), 'DuplicateSettlementToken');
    await fails(deploy('ForwarderFactory', [payout, [token.target, ethers.ZeroAddress]]), 'InvalidSettlementToken');
    await fails(deploy('ForwarderFactory', [payout, [token.target, strangerAddress]]), 'InvalidSettlementToken');
    await fails(deploy('ForwarderFactory', [token.target, [second.target, token.target]]), 'InvalidPayout');
    for (const sig of ['addSettlementToken(address)', 'removeSettlementToken(address)', 'setSettlementToken(address)']) {
      const iface = new ethers.Interface([`function ${sig}`]);
      await fails(stranger.sendTransaction({ to: factory.target,
        data: iface.encodeFunctionData(sig.split('(')[0], [wrong.target]) }));
    }
    assert.deepEqual(Array.from(await factory.getSettlementTokens()), [token.target, second.target]);
    assert.equal(await factory.isSupportedToken(wrong.target), false);
    assert.equal(await factory.isSupportedToken(ethers.ZeroAddress), false);
    assert.equal(await factory.isSupportedToken(factory.target), false);
  });
  await test('one counterfactual order receives both supported tokens; selected CA alone is swept', async () => {
    const o = await order(17n);
    await tx(second.mint(o.address, 29n));
    await tx(wrong.mint(o.address, 41n));
    await assertNoCode(o.address);
    const predicted = await factory.predictAddress(o.hash);
    const beforeA = await token.balanceOf(payout), beforeB = await second.balanceOf(payout);
    const first = await tx(factory.connect(stranger).collect(o.hash, token.target));
    assert.equal((await token.balanceOf(payout)) - beforeA, 17n);
    assert.equal(await second.balanceOf(payout), beforeB);
    assert.equal(await second.balanceOf(o.address), 29n);
    assert.equal(await wrong.balanceOf(o.address), 41n);
    assert.equal(select(first, factory, 'Collected')[0].args.token, token.target);
    assert.equal(select(first, factory, 'Collected')[0].args.amount, 17n);
    const collectedLog = first.logs.find(l => l.address.toLowerCase() === factory.target.toLowerCase()
      && l.topics[0] === factoryInterface.getEvent('Collected').topicHash);
    assert.equal(collectedLog.topics.length, 4);
    const next = await tx(factory.connect(stranger).collect(o.hash, second.target));
    assert.equal(select(next, factory, 'ForwarderDeployed').length, 0);
    assert.equal(select(next, factory, 'Collected')[0].args.token, second.target);
    assert.equal(select(next, factory, 'Collected')[0].args.amount, 29n);
    assert.equal((await second.balanceOf(payout)) - beforeB, 29n);
    assert.equal(await factory.predictAddress(o.hash), predicted);
    assert.equal(await token.balanceOf(o.address), 0n);
    assert.equal(await second.balanceOf(o.address), 0n);
    assert.equal(await wrong.balanceOf(o.address), 41n);
    for (const t of [token, second]) assert.equal(await t.balanceOf(factory.target), 0n);
  });
  await test('batch supports same order with different CA and duplicate pairs; events keep currencies separate', async () => {
    const o = await order(23n);
    await tx(second.mint(o.address, 37n));
    const batch = [{ orderIdHash: o.hash, token: token.target },
      { orderIdHash: o.hash, token: second.target }, { orderIdHash: o.hash, token: token.target }];
    assert.deepEqual(Array.from(await factory.collectBatch.staticCall(batch, { gasLimit: 1_000_000n })), [3n, 0n]);
    const beforeA = await token.balanceOf(payout), beforeB = await second.balanceOf(payout);
    const receipt = await tx(factory.connect(stranger).collectBatch(batch, { gasLimit: 1_000_000n }));
    const done = select(receipt, factory, 'Collected');
    assert.equal(done.length, 2);
    assert.deepEqual(done.map(e => [e.args.orderIdHash, e.args.forwarder, e.args.token, e.args.amount]),
      [[o.hash, o.address, token.target, 23n], [o.hash, o.address, second.target, 37n]]);
    assert.equal(select(receipt, factory, 'ForwarderDeployed').length, 1);
    assert.equal(select(receipt, factory, 'CollectFailed').length, 0);
    assert.equal((await token.balanceOf(payout)) - beforeA, 23n);
    assert.equal((await second.balanceOf(payout)) - beforeB, 37n);
  });
  await test('unsupported CA cannot use normal path or deploy an order; batch isolates bad token pair', async () => {
    const o = await order(13n), never = await order(0n);
    await tx(second.mint(o.address, 31n));
    await tx(wrong.mint(o.address, 47n));
    for (const t of [wrong.target, ethers.ZeroAddress, strangerAddress]) {
      await fails(factory.collect.staticCall(never.hash, t), 'UnsupportedSettlementToken');
    }
    await fails(tx(factory.collect(never.hash, wrong.target, { gasLimit: 500000 } )));
    await assertNoCode(never.address);
    assert.equal(await factory.isForwarder(never.address), false);
    const batch = [{ orderIdHash: o.hash, token: token.target },
      { orderIdHash: o.hash, token: wrong.target }, { orderIdHash: o.hash, token: second.target }];
    assert.deepEqual(Array.from(await factory.collectBatch.staticCall(batch, { gasLimit: 1_000_000n })), [2n, 1n]);
    const receipt = await tx(factory.collectBatch(batch, { gasLimit: 1_000_000n }));
    const failed = select(receipt, factory, 'CollectFailed');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].args.orderIdHash, o.hash);
    assert.equal(failed[0].args.forwarder, o.address);
    assert.equal(failed[0].args.token, wrong.target);
    assert.equal(failed[0].args.reasonSelector, factoryInterface.getError('UnsupportedSettlementToken').selector);
    assert.equal(await wrong.balanceOf(o.address), 47n);
    assert.equal(await token.balanceOf(o.address), 0n);
    assert.equal(await second.balanceOf(o.address), 0n);
  });
  await test('blocked token does not block another supported token at the SAME order address; retry retains registry', async () => {
    const o = await order(53n);
    await tx(second.mint(o.address, 61n));
    await tx(token.setBlocked(o.address, true));
    const beforeA = await token.balanceOf(payout), beforeB = await second.balanceOf(payout);
    const batch = [{ orderIdHash: o.hash, token: token.target }, { orderIdHash: o.hash, token: second.target }];
    assert.deepEqual(Array.from(await factory.collectBatch.staticCall(batch, { gasLimit: 1_000_000n })), [1n, 1n]);
    const receipt = await tx(factory.collectBatch(batch, { gasLimit: 1_000_000n }));
    assert.equal(select(receipt, factory, 'CollectFailed')[0].args.token, token.target);
    assert.equal(select(receipt, factory, 'Collected')[0].args.token, second.target);
    assert.equal(await token.balanceOf(payout), beforeA);
    assert.equal((await second.balanceOf(payout)) - beforeB, 61n);
    assert.equal(await token.balanceOf(o.address), 53n);
    assert.equal(await factory.isForwarder(o.address), true);
    await tx(token.setBlocked(o.address, false));
    const retry = await tx(factory.collect(o.hash, token.target));
    assert.equal(select(retry, factory, 'ForwarderDeployed').length, 0);
    assert.equal((await token.balanceOf(payout)) - beforeA, 53n);
  });
  await test('every supported CA is protected from manual wrong-token classification', async () => {
    const o = await order(7n);
    await tx(second.mint(o.address, 11n));
    for (const t of [token.target, second.target]) {
      await fails(factory.collectWrongToken.staticCall(o.hash, t), 'SettlementTokenProtected');
    }
    await assertNoCode(o.address);
    assert.equal(await token.balanceOf(o.address), 7n);
    assert.equal(await second.balanceOf(o.address), 11n);
    const clone = new ethers.Contract(await factory.implementation(), fi.abi, stranger);
    await fails(clone.sweepWrongToken.staticCall(second.target), 'OnlyHub');
    await fails(clone.sweepSettlementToken.staticCall(second.target), 'OnlyHub');
  });
  await test('shared reentrancy guard blocks callbacks into another supported CA and mixed batch', async () => {
    const f = await deploy('ForwarderFactory', [payout, [adversarial.target, second.target]]);
    for (const method of ['collect', 'collectBatch', 'collectWrongToken', 'collectBatchItem']) {
      const o = await order(73n, f, adversarial);
      await tx(second.mint(o.address, 89n));
      const args = method === 'collectBatch' ? [[{ orderIdHash: o.hash, token: second.target }]]
        : method === 'collectWrongToken' ? [o.hash, ethers.ZeroAddress] : [o.hash, second.target];
      await tx(adversarial.setCallback(o.address, f.target, f.interface.encodeFunctionData(method, args)));
      const beforeB = await second.balanceOf(payout);
      await tx(f.collect(o.hash, adversarial.target));
      assert.equal(await adversarial.lastCallbackSucceeded(), false);
      assert.equal(await second.balanceOf(o.address), 89n);
      assert.equal(await second.balanceOf(payout), beforeB);
      await tx(f.collect(o.hash, second.target));
      assert.equal((await second.balanceOf(payout)) - beforeB, 89n);
    }
  });
  await test('seeded multi-CA deposits and pair batches conserve each asset independently without conversion', async () => {
    const a = await deploy('MockToken'), b = await deploy('MockToken');
    const f = await deploy('ForwarderFactory', [payout, [a.target, b.target]]);
    const tokens = [a, b], minted = [0n, 0n], orders = [];
    for (let i = 0; i < 5; ++i) orders.push(await order(0n, f, a));
    let seed = 173n;
    for (let i = 0; i < 24; ++i) {
      seed = (seed * 1103515245n + 12345n) % 2147483648n;
      const index = Number(seed % 5n), ti = Number(seed % 2n), amount = seed % 997n + 1n;
      await tx(tokens[ti].mint(orders[index].address, amount));
      minted[ti] += amount;
      const batch = [{ orderIdHash: orders[index].hash, token: tokens[ti].target },
        { orderIdHash: orders[(index + 1) % orders.length].hash, token: tokens[1 - ti].target }];
      await tx(f.connect(stranger).collectBatch(batch));
      for (let j = 0; j < tokens.length; ++j) {
        const balances = await Promise.all(orders.map(o => tokens[j].balanceOf(o.address)));
        assert.equal(balances.reduce((sum, n) => sum + n, 0n) + await tokens[j].balanceOf(payout), minted[j]);
        assert.equal(await tokens[j].balanceOf(f.target), 0n);
        assert.equal(await tokens[j].balanceOf(strangerAddress), 0n);
      }
    }
    await tx(f.collectBatch(orders.flatMap(o => tokens.map(t => ({ orderIdHash: o.hash, token: t.target })))));
    for (let j = 0; j < tokens.length; ++j) assert.equal(await tokens[j].balanceOf(payout), minted[j]);
    assert.deepEqual(Array.from(await f.getSettlementTokens()), [a.target, b.target]);
  });
  await test('same-order batch success then failure preserves successful funds, deployment and registration', async () => {
    const a = await deploy('MockToken'), b = await deploy('MockToken');
    const f = await deploy('ForwarderFactory', [payout, [a.target, b.target]]);
    for (const predeployed of [false, true]) {
      const o = await order(11n, f, a);
      await tx(b.mint(o.address, 13n));
      if (predeployed) await tx(f.deploy(o.hash));
      else await assertNoCode(o.address);
      await tx(b.setBlocked(o.address, true));
      const beforeA = await a.balanceOf(payout), beforeB = await b.balanceOf(payout);
      const batch = [a, b].map(t => ({ orderIdHash: o.hash, token: t.target }));
      assert.deepEqual(Array.from(await f.collectBatch.staticCall(batch, { gasLimit: 1_000_000n })), [1n, 1n]);
      const receipt = await tx(f.connect(stranger).collectBatch(batch, { gasLimit: 1_000_000n }));
      assert.equal(receipt.status, 1);
      assert.deepEqual(events(receipt, f).map(e => e.name),
        [...(predeployed ? [] : ['ForwarderDeployed']), 'Collected', 'CollectFailed']);
      for (const [name, t] of [['Collected', a], ['CollectFailed', b]]) {
        const e = select(receipt, f, name)[0];
        assert.equal(e.args.orderIdHash, o.hash);
        assert.equal(e.args.forwarder, o.address);
        assert.equal(e.args.token, t.target);
      }
      assert.equal(select(receipt, f, 'Collected')[0].args.amount, 11n);
      assert.equal(select(receipt, f, 'CollectFailed')[0].args.reasonSelector, ethers.id('Error(string)').slice(0, 10));
      assert.equal((await a.balanceOf(payout)) - beforeA, 11n);
      assert.equal(await b.balanceOf(payout), beforeB);
      assert.equal(await a.balanceOf(o.address), 0n);
      assert.equal(await b.balanceOf(o.address), 13n);
      assert.equal(await f.predictAddress(o.hash), o.address);
      assert.equal(await f.isForwarder(o.address), true);
      assert.equal(ethers.keccak256(await provider.getCode(o.address)), await f.forwarderCodehash());
      for (const t of [a, b]) assert.equal(await t.balanceOf(f.target), 0n);
      await tx(b.setBlocked(o.address, false));
      const retry = await tx(f.collect(o.hash, b.target));
      assert.equal(select(retry, f, 'ForwarderDeployed').length, 0);
      assert.equal((await b.balanceOf(payout)) - beforeB, 13n);
      assert.equal((await a.balanceOf(payout)) - beforeA, 11n);
      assert.equal(await b.balanceOf(o.address), 0n);
    }
  });
  await test('same-order batch with both tokens blocked rolls back fresh deployment but preserves existing clone', async () => {
    const a = await deploy('MockToken'), b = await deploy('MockToken');
    const f = await deploy('ForwarderFactory', [payout, [a.target, b.target]]);
    for (const predeployed of [false, true]) {
      const o = await order(17n, f, a);
      await tx(b.mint(o.address, 19n));
      if (predeployed) await tx(f.deploy(o.hash));
      const beforeCode = await provider.getCode(o.address);
      assert.equal(await f.isForwarder(o.address), predeployed);
      if (!predeployed) assert.equal(beforeCode, '0x');
      const before = await Promise.all([a, b].map(t => t.balanceOf(payout)));
      for (const t of [a, b]) await tx(t.setBlocked(o.address, true));
      const batch = [a, b].map(t => ({ orderIdHash: o.hash, token: t.target }));
      assert.deepEqual(Array.from(await f.collectBatch.staticCall(batch, { gasLimit: 1_000_000n })), [0n, 2n]);
      const receipt = await tx(f.collectBatch(batch, { gasLimit: 1_000_000n }));
      assert.equal(receipt.status, 1);
      assert.deepEqual(events(receipt, f).map(e => e.name), ['CollectFailed', 'CollectFailed']);
      assert.deepEqual(select(receipt, f, 'CollectFailed').map(e =>
        [e.args.orderIdHash, e.args.forwarder, e.args.token, e.args.reasonSelector]),
      [a, b].map(t => [o.hash, o.address, t.target, ethers.id('Error(string)').slice(0, 10)]));
      assert.equal(await provider.getCode(o.address), beforeCode);
      assert.equal(await f.isForwarder(o.address), predeployed);
      assert.equal(await f.predictAddress(o.hash), o.address);
      for (const [i, t] of [a, b].entries()) {
        assert.equal(await t.balanceOf(payout), before[i]);
        assert.equal(await t.balanceOf(o.address), [17n, 19n][i]);
        assert.equal(await t.balanceOf(f.target), 0n);
        await tx(t.setBlocked(o.address, false));
      }
      const retry = await tx(f.collectBatch(batch, { gasLimit: 1_000_000n }));
      assert.equal(select(retry, f, 'ForwarderDeployed').length, predeployed ? 0 : 1);
      assert.equal(select(retry, f, 'Collected').length, 2);
      assert.equal(select(retry, f, 'CollectFailed').length, 0);
      assert.equal(await f.isForwarder(o.address), true);
      for (const [i, t] of [a, b].entries()) {
        assert.equal((await t.balanceOf(payout)) - before[i], [17n, 19n][i]);
        assert.equal(await t.balanceOf(o.address), 0n);
      }
    }
  });
  await test('unsupported-only batches for fresh orders emit failures without code, registration or asset movement', async () => {
    for (const unsupported of [wrong.target, ethers.ZeroAddress, strangerAddress]) {
      const o = await order(23n);
      await tx(wrong.mint(o.address, 29n));
      await assertNoCode(o.address);
      assert.equal(await factory.isForwarder(o.address), false);
      const before = await Promise.all([token, wrong].map(t => t.balanceOf(payout)));
      const batch = [{ orderIdHash: o.hash, token: unsupported }];
      assert.deepEqual(Array.from(await factory.collectBatch.staticCall(batch, { gasLimit: 1_000_000n })), [0n, 1n]);
      const receipt = await tx(factory.connect(stranger).collectBatch(batch, { gasLimit: 1_000_000n }));
      assert.equal(receipt.status, 1);
      assert.deepEqual(events(receipt, factory).map(e => e.name), ['CollectFailed']);
      const failed = select(receipt, factory, 'CollectFailed')[0];
      assert.equal(failed.args.orderIdHash, o.hash);
      assert.equal(failed.args.forwarder, o.address);
      assert.equal(failed.args.token, unsupported);
      assert.equal(failed.args.reasonSelector, factoryInterface.getError('UnsupportedSettlementToken').selector);
      await assertNoCode(o.address);
      assert.equal(await factory.isForwarder(o.address), false);
      assert.equal(await factory.predictAddress(o.hash), o.address);
      for (const [i, t] of [token, wrong].entries()) {
        assert.equal(await t.balanceOf(payout), before[i]);
        assert.equal(await t.balanceOf(o.address), [23n, 29n][i]);
        assert.equal(await t.balanceOf(factory.target), 0n);
      }
      const valid = await tx(factory.collect(o.hash, token.target));
      assert.equal(select(valid, factory, 'ForwarderDeployed').length, 1);
      assert.equal(await factory.isForwarder(o.address), true);
      assert.equal((await token.balanceOf(payout)) - before[0], 23n);
      assert.equal(await wrong.balanceOf(o.address), 29n);
    }
  });
  console.log(`\n${count}/${count} self-hosted contract regression groups passed. Local in-memory chain only.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
