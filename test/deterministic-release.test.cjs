'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('../backend/chain.cjs');
const { artifacts } = require('../backend/deployment-service.cjs');
const D = require('../backend/deterministic.cjs');
const manifest = require('../contracts/deterministic-v2-manifest.json');

test('deterministic-v2 release pins canonical bootstrap, creation/runtime hashes and root address', () => {
  const a = artifacts(['DeterministicDeployer']).DeterministicDeployer;
  assert.equal(manifest.scheme, D.SCHEME);
  assert.equal(manifest.singleton, D.SINGLETON);
  assert.equal(manifest.singletonRuntimeHash, ethers.keccak256(D.SINGLETON_RUNTIME));
  assert.equal(manifest.salt, D.SALT);
  assert.equal(manifest.creationCodeHash, ethers.keccak256(a.bytecode));
  assert.equal(manifest.runtimeCodeHash, ethers.keccak256(a.deployedBytecode));
  assert.equal(manifest.deployer, ethers.getCreate2Address(D.SINGLETON, D.SALT, manifest.creationCodeHash));
  assert.equal(D.rootAddress(), manifest.deployer);
  const dir = path.resolve(__dirname, '../artifacts/src/DeterministicDeployer.sol');
  const dbg = JSON.parse(fs.readFileSync(path.join(dir, 'DeterministicDeployer.dbg.json')));
  const build = JSON.parse(fs.readFileSync(path.resolve(dir, dbg.buildInfo)));
  assert.equal(build.solcLongVersion, manifest.compiler);
  assert.deepEqual(build.input.settings.optimizer, manifest.settings.optimizer);
  assert.equal(build.input.settings.viaIR, manifest.settings.viaIR);
  assert.equal(build.input.settings.evmVersion, manifest.settings.evmVersion);
});

test('runtime refuses drifted creation/runtime artifacts or a different pin before issuing addresses', () => {
  const service = require('../backend/deployment-service.cjs');
  const original = service.artifacts;
  const a = original(['DeterministicDeployer']).DeterministicDeployer;
  const rejects = fn => assert.throws(fn, e => e.code === 'DETERMINISTIC_RELEASE_MISMATCH');
  try {
    service.artifacts = () => ({ DeterministicDeployer: { ...a, bytecode: a.bytecode + '00' } });
    rejects(() => D.rootAddress());
    service.artifacts = () => ({ DeterministicDeployer: { ...a, deployedBytecode: a.deployedBytecode + '00' } });
    rejects(() => D.rootAddress());
  } finally { service.artifacts = original; }
  const salt = manifest.salt;
  try {
    manifest.salt = ethers.ZeroHash;
    rejects(() => D.rootAddress());
  } finally { manifest.salt = salt; }
  assert.equal(D.rootAddress(), manifest.deployer);
});
