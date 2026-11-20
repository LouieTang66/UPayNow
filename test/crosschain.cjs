'use strict';
// Entirely local, two independent EDR providers (not reset snapshots or RPC forks).
// Real official ERC-2470 raw transaction, not hardhat_setCode/recompiled imitation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const hre = require('hardhat');
const { ethers } = require('ethers');
const { createProvider } = require('hardhat/internal/core/providers/construction');
const { buildInput } = require('../scripts/build-input.cjs');
const { compileInput } = require('../scripts/compile.cjs');
const fixture = require('./fixtures/erc2470.json');

const ROOT_SALT = ethers.id('upaynow:deterministic-deployer:v2');
const FACTORY_VERSION = ethers.id('upaynow.factory.create3.v1');
const ORDER = ethers.id('same-merchant-original-v3-order');
const tx = async p => (await p).wait();
let count = 0;
async function test(name, fn) { await fn(); console.log(`PASS crosschain ${++count}: ${name}`); }

async function main() {
  const input = buildInput();
  const production = compileInput(input);
  for (const file of ['MockToken.sol', 'Adversarial.sol', 'fixtures/CrosschainPayout.sol']) {
    input.sources[`test/${file}`] = { content: fs.readFileSync(path.join(__dirname, file), 'utf8') };
  }
  const output = compileInput(input);
  const artifact = name => {
    for (const contracts of Object.values(output.contracts)) if (contracts[name]) return contracts[name];
    throw Error(`Missing ${name}`);
  };
  const code = name => `0x${artifact(name).evm.bytecode.object}`;
  const rootCode = code('DeterministicDeployer');
  const rootAddress = ethers.getCreate2Address(fixture.address, ROOT_SALT, ethers.keccak256(rootCode));
  const raw = ethers.Transaction.from(fixture.rawTransaction);
  // Official initcode copies exactly 0x134 bytes starting at 0x20 into runtime.
  assert.ok(raw.data.startsWith('0x608060405234801561001057600080fd5b50610134806100206000396000f3fe'));
  const officialRuntime = ethers.dataSlice(raw.data, 0x20, 0x20 + 0x134);
  assert.equal(raw.hash, fixture.transactionHash);
  assert.equal(raw.from, fixture.sender);
  assert.equal(raw.chainId, 0n);
  assert.equal(ethers.getCreateAddress({ from: raw.from, nonce: raw.nonce }), fixture.address);

  await test('canonical artifacts and legacy creation/runtime bytecode remain baseline f041097', async () => {
    const hashes = {
      ForwarderFactory: ['0x5db7a081ad58f41add470430007bc4853ba97573537983a0268bfed5dccd83b4', '0x2b5c9892bef6cb3eaa85896e70fda44df3e44a406c504eb1533b2ff0bf051334'],
      ForwarderImpl: ['0xc25e76424e601db89587ff11312dc4b01ea727a49c4ccf0250d0865942fc4375', '0xd3625c7129cdef73098341559ef9f890e9c44d7fedf0fad28bfd9d3013ff8fe4'],
    };
    for (const name of ['ForwarderFactory', 'ForwarderImpl', 'DeterministicDeployer', 'FactoryCreationProxy']) {
      const source = name === 'FactoryCreationProxy' ? 'DeterministicDeployer' : name;
      const a = await hre.artifacts.readArtifact(`src/${source}.sol:${name}`);
      const canonical = production.contracts[`src/${source}.sol`][name];
      assert.deepEqual(a.abi, canonical.abi);
      for (const [i, k] of ['bytecode', 'deployedBytecode'].entries()) {
        assert.equal(a[k], `0x${canonical.evm[k].object}`);
        assert.equal(a[k], `0x${artifact(name).evm[k].object}`);
        if (hashes[name]) assert.equal(ethers.keccak256(a[k]), hashes[name][i]);
      }
    }
    const abi = artifact('DeterministicDeployer').abi;
    assert.deepEqual(abi.filter(x => x.type === 'function').map(x => x.name).sort(), ['deploy', 'predictFactory']);
    assert.ok(!abi.some(x => x.type === 'constructor' && x.inputs.length));
    assert.ok((rootCode.length - 2) / 2 <= 49152);
    assert.ok(artifact('DeterministicDeployer').evm.deployedBytecode.object.length / 2 <= 24576);
  });

  async function chain(chainId, nonceSkew) {
    const config = { ...hre.config, networks: { hardhat: { ...hre.config.networks.hardhat, chainId } } };
    const rpc = await createProvider(config, 'hardhat', hre.artifacts);
    const p = new ethers.BrowserProvider(rpc, undefined, { cacheTimeout: -1 });
    p.pollingInterval = 10;
    const admin = await p.getSigner(0), merchant = await p.getSigner(1), stranger = await p.getSigner(2);
    const payout = await merchant.getAddress();
    assert.equal(BigInt(await p.send('eth_chainId', [])), BigInt(chainId));
    const deploy = async (name, args = []) => {
      const c = await new ethers.ContractFactory(artifact(name).abi, code(name), admin).deploy(...args);
      await c.waitForDeployment();
      return c;
    };
    for (let i = 0; i < nonceSkew; ++i) {
      await tx(admin.sendTransaction({ to: await admin.getAddress(), value: 0n }));
      await tx(merchant.sendTransaction({ to: payout, value: 0n }));
    }
    const token = await deploy('TransferTestToken');
    const second = await deploy('MockToken');
    const wrong = await deploy('MockToken');
    await tx(admin.sendTransaction({ to: raw.from, value: ethers.parseEther('0.0247') }));
    await p.broadcastTransaction(fixture.rawTransaction).then(t => t.wait());
    assert.equal(await p.getCode(fixture.address), officialRuntime);
    const singleton = new ethers.Contract(fixture.address, ['function deploy(bytes,bytes32) returns(address)'], admin);
    assert.equal(await singleton.deploy.staticCall(rootCode, ROOT_SALT), rootAddress);
    // ERC-2470 returns zero instead of reverting on failed CREATE2. Automatic
    // gas estimation can accept an inner out-of-gas failure; use an explicit
    // bounded local gas limit and ALWAYS verify code after the receipt.
    await tx(singleton.deploy(rootCode, ROOT_SALT, { gasLimit: 12_000_000 }));
    assert.notEqual(await p.getCode(rootAddress), '0x');
    assert.equal(await singleton.deploy.staticCall(rootCode, ROOT_SALT), ethers.ZeroAddress);
    const root = new ethers.Contract(rootAddress, artifact('DeterministicDeployer').abi, merchant);
    const factoryAddress = await root.predictFactory(payout);
    const proxySalt = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'address'], [FACTORY_VERSION, payout]));
    const proxyAddress = ethers.getCreate2Address(rootAddress, proxySalt, ethers.keccak256(code('FactoryCreationProxy')));
    assert.equal(factoryAddress, ethers.getCreateAddress({ from: proxyAddress, nonce: 1 }));
    return { chainId, rpc, p, admin, merchant, stranger, payout, token, second, wrong, deploy, root, factoryAddress, proxyAddress, tokens: [token.target, second.target] };
  }
  const A = await chain(31337, 0);
  const B = await chain(31338, 7);
  await test('two isolated chainIds execute official rawtx then singleton.deploy(rootInitCode,fixedSalt)', async () => {
    assert.notEqual(A.rpc, B.rpc);
    assert.equal(A.root.target, B.root.target);
    assert.equal(A.payout, B.payout);
    assert.notEqual(A.token.target, B.token.target);
    assert.notEqual(await A.p.getTransactionCount(A.payout), await B.p.getTransactionCount(B.payout));
    assert.equal(A.factoryAddress, B.factoryAddress);
    assert.equal(await A.p.getCode(A.factoryAddress), '0x');
    assert.equal(await B.p.getCode(B.factoryAddress), '0x');
    console.log(`  chains=${A.chainId}/${B.chainId} singleton=${fixture.address} officialRuntimeHash=${ethers.keccak256(officialRuntime)}`);
    console.log(`  root=${rootAddress} salt=${ROOT_SALT}`);
    console.log(`  token A=${A.token.target} B=${B.token.target}`);
  });
  async function reverts(promise, iface, error) {
    await assert.rejects(promise, e => {
      const data = e.data || e.info?.error?.data;
      try { return iface.parseError(data)?.name === error; } catch { return false; }
    }, error);
  }
  await test('front-running payout fails on both chains before proxy or factory exists', async () => {
    for (const c of [A, B]) {
      await reverts(c.root.connect(c.stranger).deploy.staticCall(c.payout, c.tokens), c.root.interface, 'OnlyPayout');
      await assert.rejects(tx(c.root.connect(c.stranger).deploy(c.payout, c.tokens, { gasLimit: 10_000_000 })));
      assert.equal(await c.p.getCode(c.proxyAddress), '0x');
      assert.equal(await c.p.getCode(c.factoryAddress), '0x');
    }
  });
  await test('invalid token configurations roll back CREATE2 proxy and first CREATE; corrected retry succeeds', async () => {
    for (const tokens of [[], [await A.stranger.getAddress()], [A.token.target, A.token.target], [A.payout]]) {
      await assert.rejects(tx(A.root.deploy(A.payout, tokens, { gasLimit: 10_000_000 })));
      assert.equal(await A.p.getCode(A.proxyAddress), '0x');
      assert.equal(await A.p.getCode(A.factoryAddress), '0x');
    }
    const receipt = await tx(A.root.deploy(A.payout, A.tokens));
    const event = receipt.logs.map(l => { try { return A.root.interface.parseLog(l); } catch { return null; } }).find(e => e?.name === 'FactoryDeployed');
    assert.equal(event.args.payout, A.payout);
    assert.equal(event.args.factory, A.factoryAddress);
    A.factory = new ethers.Contract(A.factoryAddress, artifact('ForwarderFactory').abi, A.admin);
    assert.equal(await A.factory.payout(), A.payout);
    assert.deepEqual(Array.from(await A.factory.getSettlementTokens()), A.tokens);
    assert.equal(await A.factory.SALT_VERSION(), 3n);
  });
  const orderAddress = await A.factory.predictAddress(ORDER);
  await test('B receives real ERC20 transfers at still-undeployed v3 order BEFORE B factory exists', async () => {
    assert.equal(await B.p.getCode(B.factoryAddress), '0x');
    assert.equal(await B.p.getCode(orderAddress), '0x');
    await tx(B.token.mint(await B.admin.getAddress(), 230n));
    await tx(B.token.transfer(orderAddress, 230n));
    await tx(B.wrong.mint(await B.admin.getAddress(), 19n));
    await tx(B.wrong.transfer(orderAddress, 19n));
    assert.equal(await B.token.balanceOf(orderAddress), 230n);
    assert.equal(await B.wrong.balanceOf(orderAddress), 19n);
    assert.equal(await A.token.balanceOf(orderAddress), 0n);
  });
  await test('different local token initcode yields identical Factory, impl and original v3 order', async () => {
    await tx(B.root.deploy(B.payout, B.tokens));
    B.factory = new ethers.Contract(B.factoryAddress, artifact('ForwarderFactory').abi, B.admin);
    assert.deepEqual(Array.from(await B.factory.getSettlementTokens()), B.tokens);
    assert.equal(await B.factory.implementation(), await A.factory.implementation());
    assert.equal(await B.factory.predictAddress(ORDER), orderAddress);
    assert.equal(await B.factory.computeSalt(ORDER), await A.factory.computeSalt(ORDER));
    assert.equal(await B.p.getCode(B.factoryAddress), await A.p.getCode(A.factoryAddress));
    console.log(`  factory=${A.factoryAddress} impl=${await A.factory.implementation()} order=${orderAddress}`);
  });
  await test('B late deployment collect and collectWrongToken settle to fixed payout; no A balance/payment mixing', async () => {
    await tx(A.token.mint(await A.admin.getAddress(), 101n));
    await tx(A.token.transfer(orderAddress, 101n));
    await tx(B.factory.collect(ORDER, B.token.target));
    await tx(B.factory.collectWrongToken(ORDER, B.wrong.target));
    assert.equal(await B.token.balanceOf(B.payout), 230n);
    assert.equal(await B.wrong.balanceOf(B.payout), 19n);
    assert.equal(await B.token.balanceOf(orderAddress), 0n);
    assert.equal(await B.wrong.balanceOf(orderAddress), 0n);
    assert.equal(await A.token.balanceOf(A.payout), 0n);
    assert.equal(await A.token.balanceOf(orderAddress), 101n);
    assert.equal(await A.p.getCode(orderAddress), '0x');
    await tx(A.factory.collect(ORDER, A.token.target));
    assert.equal(await A.token.balanceOf(A.payout), 101n);
    assert.equal(await B.token.balanceOf(B.payout), 230n);
    assert.equal(await A.p.getCode(orderAddress), await B.p.getCode(orderAddress));
    console.log('  independently settled: A=101; B=230 normal + 19 wrong-token (not a payment verdict)');
  });
  await test('idempotent deployment requires exact ordered full token list and payout authentication', async () => {
    for (const c of [A, B]) {
      assert.equal(await c.root.deploy.staticCall(c.payout, c.tokens), c.factoryAddress);
      const receipt = await tx(c.root.deploy(c.payout, c.tokens));
      assert.equal(receipt.logs.length, 0);
      for (const tokens of [[c.token.target], [...c.tokens].reverse(), [...c.tokens, c.wrong.target], []]) {
        await reverts(c.root.deploy.staticCall(c.payout, tokens), c.root.interface, 'ConfigurationMismatch');
      }
      await reverts(c.root.connect(c.stranger).deploy.staticCall(c.payout, c.tokens), c.root.interface, 'OnlyPayout');
      const other = await c.stranger.getAddress();
      assert.notEqual(await c.root.predictFactory(other), c.factoryAddress);
    }
  });
  await test('persisting CREATE3 proxy rejects outsiders; even root cannot CREATE twice (local impersonation probe)', async () => {
    for (const c of [A, B]) {
      const proxy = new ethers.Contract(c.proxyAddress, artifact('FactoryCreationProxy').abi, c.stranger);
      assert.notEqual(await c.p.getCode(proxy.target), '0x');
      await reverts(proxy.deploy.staticCall('0x60006000f3'), proxy.interface, 'OnlyDeployer');
      await c.p.send('hardhat_impersonateAccount', [rootAddress]);
      try {
        const rootSigner = new ethers.JsonRpcSigner(c.p, rootAddress);
        await reverts(proxy.connect(rootSigner).deploy.staticCall('0x60006000f3'), proxy.interface, 'AlreadyUsed');
      } finally { await c.p.send('hardhat_stopImpersonatingAccount', [rootAddress]); }
      assert.equal(await c.p.getTransactionCount(proxy.target), 2);
    }
  });
  await test('wrong/foreign chain CA rejected; correct token remains collectable and protected from manual sweep', async () => {
    for (const [c, foreign] of [[A, B.token.target], [B, A.token.target]]) {
      await reverts(c.factory.collect.staticCall(ORDER, foreign), c.factory.interface, 'UnsupportedSettlementToken');
      await reverts(c.factory.collectWrongToken.staticCall(ORDER, c.token.target), c.factory.interface, 'SettlementTokenProtected');
      await tx(c.second.mint(orderAddress, 3n));
      await tx(c.factory.collect(ORDER, c.second.target));
      assert.equal(await c.second.balanceOf(c.payout), 3n);
    }
  });
  await test('reentrant token cannot reenter collection or root deployment; no double collection', async () => {
    for (const c of [A, B]) {
      const hash = ethers.id('callback-order');
      const address = await c.factory.predictAddress(hash);
      await tx(c.token.mint(address, 41n));
      await tx(c.token.setCallback(address, c.factory.target, c.factory.interface.encodeFunctionData('collect', [hash, c.token.target])));
      const before = await c.token.balanceOf(c.payout);
      await tx(c.factory.collect(hash, c.token.target));
      assert.equal(await c.token.lastCallbackSucceeded(), false);
      assert.equal(await c.token.balanceOf(c.payout), before + 41n);
      await tx(c.token.mint(address, 11n));
      await tx(c.token.setCallback(address, rootAddress, c.root.interface.encodeFunctionData('deploy', [c.payout, c.tokens])));
      await tx(c.factory.collect(hash, c.token.target));
      assert.equal(await c.token.lastCallbackSucceeded(), false);
      assert.equal(await c.token.balanceOf(c.payout), before + 52n);
      await tx(c.factory.collect(hash, c.token.target));
      await tx(c.factory.deploy(hash));
      assert.equal(await c.token.balanceOf(c.payout), before + 52n);
    }
  });
  await test('contract payout can self-deploy and safely reuse same configuration twice in one transaction', async () => {
    for (const c of [A, B]) {
      const wallet = await c.deploy('CrosschainPayout');
      await tx(wallet.deployTwice(rootAddress, c.tokens));
      const address = await c.root.predictFactory(wallet.target);
      const factory = new ethers.Contract(address, artifact('ForwarderFactory').abi, c.admin);
      assert.equal(await factory.payout(), wallet.target);
      await tx(wallet.deployTwice(rootAddress, c.tokens));
    }
  });
  console.log(`All ${count} crosschain checks passed. Local-only independent Cancun EVMs; no live chain/RPC, no setCode fixture.`);
  A.p.destroy(); B.p.destroy();
}
main().catch(e => { console.error(e); process.exitCode = 1; });
