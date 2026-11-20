'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ethers, requireValue: check, address } = require('./chain.cjs');
const SCHEME = 'deterministic-v2';
const SINGLETON = '0xce0042B868300000d44A59004Da54A005ffdcf9f';
const SALT = ethers.id('upaynow:deterministic-deployer:v2');
// ERC-2470 official signed raw transaction's creation code returns 0x134 bytes at offset 0x20.
// Source: erc-2470.md Deployment Transaction (0x803351de...71a01c); no funding/broadcast path exists here.
const SINGLETON_RUNTIME = '0x6080604052348015600f57600080fd5b506004361060285760003560e01c80634af63f0214602d575b600080fd5b60cf60048036036040811015604157600080fd5b810190602081018135640100000000811115605b57600080fd5b820183602082011115606c57600080fd5b80359060200191846001830284011164010000000083111715608d57600080fd5b91908080601f016020809104026020016040519081016040528093929190818152602001838380828437600092019190915250929550509135925060eb915050565b604080516001600160a01b039092168252519081900360200190f35b6000818351602085016000f5939250505056fea26469706673582212206b44f8a82cb6b156bfcc3dc6aadd6df4eefd204bc928a4397fd15dacf6d5320564736f6c63430006020033';
const rootABI = ['function predictFactory(address payout) view returns(address)', 'function deploy(address payout,address[] tokens) returns(address factory)', 'event FactoryDeployed(address indexed payout,address indexed factory)'];
const singletonABI = ['function deploy(bytes initCode,bytes32 salt) returns(address)'];
const same = (a,b) => String(a).toLowerCase() === String(b).toLowerCase();
function rootArtifact() {
  const { artifacts } = require('./deployment-service.cjs');
  const a = artifacts(['DeterministicDeployer']).DeterministicDeployer;
  const pin = require('../contracts/deterministic-v2-manifest.json');
  // Never silently issue a different address under the same scheme after rebuilding.
  check(pin.scheme === SCHEME && same(pin.singleton, SINGLETON) && same(pin.salt, SALT)
    && same(pin.singletonRuntimeHash, ethers.keccak256(SINGLETON_RUNTIME))
    && same(pin.creationCodeHash, ethers.keccak256(a.bytecode))
    && same(pin.runtimeCodeHash, ethers.keccak256(a.deployedBytecode))
    && same(pin.deployer, ethers.getCreate2Address(SINGLETON, SALT, pin.creationCodeHash)), 'DETERMINISTIC_RELEASE_MISMATCH', 409);
  return a;
}
function rootAddress(a = rootArtifact()) { return ethers.getCreate2Address(SINGLETON, SALT, ethers.keccak256(a.bytecode)); }
async function inspectRoot(provider, config, { requireSingleton = true } = {}) {
  check(BigInt(await provider.send('eth_chainId', [])) === BigInt(config.chainId), 'CHAIN_ID_MISMATCH', 409);
  const singletonCode = await provider.getCode(SINGLETON);
  const singletonReady = singletonCode !== '0x';
  if (singletonReady) check(same(singletonCode, SINGLETON_RUNTIME), 'SINGLETON_RUNTIME_MISMATCH', 409);
  if (requireSingleton) check(singletonReady, 'CANONICAL_SINGLETON_UNAVAILABLE', 409);
  const a = rootArtifact(), deployer = rootAddress(a), code = await provider.getCode(deployer);
  const deployerReady = code !== '0x';
  if (deployerReady) check(same(code, a.deployedBytecode), 'DEPLOYER_RUNTIME_MISMATCH', 409);
  const root = new ethers.Contract(deployer, rootABI, provider);
  return { singleton: SINGLETON, deployer, singletonReady, deployerReady, root, artifact: a };
}
async function previewWith(provider, config) {
  const r = await inspectRoot(provider, config, { requireSingleton: false });
  const payout = address(config.payout);
  // CREATE3 prediction is supplied by the audited compiler output even before bootstrap.
  const factory = r.deployerReady ? await r.root.predictFactory(payout) : predictFactory(r.deployer, payout);
  const factoryReady = await provider.getCode(factory) !== '0x';
  if (factoryReady) await require('./deployment-service.cjs').inspectWith(provider, { ...config, scheme: SCHEME, deployer: r.deployer, factory });
  return { scheme: SCHEME, singleton: r.singleton, deployer: r.deployer, factory, singletonReady: r.singletonReady, deployerReady: r.deployerReady, factoryReady, payout };
}
function predictFactory(deployer, payout) {
  const salt = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'address'], [ethers.id('upaynow.factory.create3.v1'), payout]));
  const dir = path.resolve(__dirname, '../artifacts/src/DeterministicDeployer.sol');
  const dbg = JSON.parse(fs.readFileSync(path.join(dir, 'DeterministicDeployer.dbg.json')));
  const build = JSON.parse(fs.readFileSync(path.resolve(dir, dbg.buildInfo)));
  const creation = '0x' + build.output.contracts['src/DeterministicDeployer.sol'].FactoryCreationProxy.evm.bytecode.object;
  const proxy = ethers.getCreate2Address(deployer, salt, ethers.keccak256(creation));
  return ethers.getCreateAddress({ from: proxy, nonce: 1 });
}
async function preview(input) {
  const { normalized, StrictProvider } = require('./deployment-service.cjs');
  const config = normalized({ name: 'Deterministic preview', ...input, scheme: SCHEME }), p = new StrictProvider(config.rpcUrl);
  try { return await previewWith(p, config); } finally { p.destroy(); }
}
module.exports = { SCHEME, SINGLETON, SINGLETON_RUNTIME, SALT, rootABI, singletonABI, rootAddress, inspectRoot, previewWith, preview, predictFactory };
