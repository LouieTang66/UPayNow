'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { randomUUID } = require('node:crypto');
const { ethers, AppError, requireValue: check, address } = require('./chain.cjs');
const { OPEN_NETWORKS, requireOpenNetwork } = require('./deployment-networks.cjs');
const ROOT = path.resolve(__dirname, '..');
const META = 'deployment-service.jobs.v1';
const copy = x => structuredClone(x);
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
function admitNewDeployment(input, networks) {
  const network = requireOpenNetwork(input, networks);
  check(input?.scheme === undefined || input.scheme === 'deterministic-v2', 'LEGACY_DEPLOYMENT_DISABLED', 403);
  return network;
}

// Load the exact compiler output, including immutable locations (not present in HH artifacts).
function artifacts(names = ['ForwarderFactory', 'ForwarderImpl']) {
  const result = {};
  for (const name of names) {
    const dir = path.join(ROOT, 'artifacts/src', name + '.sol');
    const artifact = JSON.parse(fs.readFileSync(path.join(dir, name + '.json')));
    const dbg = JSON.parse(fs.readFileSync(path.join(dir, name + '.dbg.json')));
    const build = JSON.parse(fs.readFileSync(path.resolve(dir, dbg.buildInfo)));
    for (const [source, entry] of Object.entries(build.input.sources)) {
      check(fs.readFileSync(path.join(ROOT, 'contracts', source), 'utf8') === entry.content, 'STALE_CONTRACT_ARTIFACT', 409);
    }
    const compiled = build.output.contracts['src/' + name + '.sol'][name];
    check(artifact.bytecode === '0x' + compiled.evm.bytecode.object && artifact.deployedBytecode === '0x' + compiled.evm.deployedBytecode.object, 'ARTIFACT_MISMATCH', 409);
    const definition = build.output.sources['src/' + name + '.sol'].ast.nodes.find(n => n.nodeType === 'ContractDefinition' && n.name === name);
    const immutableNames = Object.fromEntries(definition.nodes.filter(n => n.nodeType === 'VariableDeclaration' && n.mutability === 'immutable').map(n => [n.id, n.name]));
    result[name] = { ...artifact, refs: compiled.evm.deployedBytecode.immutableReferences, immutableNames };
  }
  return result;
}
function rpcConfig(input) {
  check(input && typeof input === 'object', 'INVALID_DEPLOYMENT');
  let url;
  try { url = new URL(input.rpcUrl); } catch { throw new AppError('INVALID_RPC_URL'); }
  check(url.protocol === 'https:', 'RPC_HTTPS_REQUIRED');
  check(!url.username && !url.password && !url.hash, 'RPC_CREDENTIALS_NOT_ALLOWED');
  const chainId = Number(input.chainId);
  check(Number.isSafeInteger(chainId) && chainId > 0, 'INVALID_CHAIN_ID');
  return { chainId, rpcUrl: url.href };
}
function normalized(input) {
  const { chainId, rpcUrl } = rpcConfig(input);
  const confirmations = Number(input.confirmations ?? 2);
  check(Number.isSafeInteger(confirmations) && confirmations >= 1 && confirmations <= 256, 'INVALID_CONFIRMATIONS');
  const payout = address(input.payout);
  check(payout !== ethers.ZeroAddress, 'INVALID_PAYOUT');
  check(typeof input.name === 'string' && input.name.trim().length > 0 && input.name.length <= 100, 'INVALID_CHAIN_NAME');
  const nativeSymbol = input.nativeSymbol ?? (chainId === 56 ? 'BNB' : 'ETH');
  check(typeof nativeSymbol === 'string' && nativeSymbol.length > 0 && nativeSymbol.length <= 32, 'INVALID_NATIVE_SYMBOL');
  const startBlock = Number(input.startBlock ?? 0);
  check(Number.isSafeInteger(startBlock) && startBlock >= 0, 'INVALID_START_BLOCK');
  const scheme = input.scheme ?? 'legacy-v1', stage = input.stage ?? 'merchant';
  check(['legacy-v1', 'deterministic-v2'].includes(scheme), 'INVALID_DEPLOYMENT_SCHEME');
  check(['bootstrap', 'merchant'].includes(stage) && (scheme === 'deterministic-v2' || stage === 'merchant'), 'INVALID_DEPLOYMENT_STAGE');
  return { name: input.name.trim(), nativeSymbol, chainId, rpcUrl, payout, confirmations, startBlock, scheme, stage };
}
// Direct HTTPS transport never follows redirects, including HTTPS -> HTTP downgrades.
class StrictProvider extends ethers.JsonRpcProvider {
  constructor(url) { super(url, undefined, { cacheTimeout: -1, batchMaxCount: 1 }); this.rpcUrl = url; }
  async _send(payload) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const req = https.request(this.rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
        const chunks = []; let size = 0;
        if (res.statusCode !== 200) { res.resume(); reject(new AppError('RPC_HTTP_ERROR', 502)); return; }
        res.on('data', chunk => { size += chunk.length; if (size > 8 * 1024 * 1024) req.destroy(new Error('RPC_RESPONSE_TOO_LARGE')); else chunks.push(chunk); });
        res.on('error', reject);
        res.on('end', () => { try { const data = JSON.parse(Buffer.concat(chunks)); resolve(Array.isArray(data) ? data : [data]); } catch (error) { reject(error); } });
      });
      req.setTimeout(10000, () => req.destroy(new Error('RPC_TIMEOUT')));
      req.on('error', reject); req.end(body);
    });
  }
}
async function identity(provider, config) {
  check(BigInt(await provider.send('eth_chainId', [])) === BigInt(config.chainId), 'CHAIN_ID_MISMATCH', 409);
}
async function metadata(provider, values, payout) {
  check(Array.isArray(values) && values.length > 0, 'TOKENS_REQUIRED');
  const addresses = values.map(t => address(typeof t === 'string' ? t : t?.address));
  check(new Set(addresses.map(x => x.toLowerCase())).size === addresses.length, 'DUPLICATE_TOKEN');
  return Promise.all(addresses.map(async token => {
    check(token !== payout, 'INVALID_PAYOUT');
    check(await provider.getCode(token) !== '0x', 'TOKEN_NOT_CONTRACT');
    const c = new ethers.Contract(token, ['function decimals() view returns(uint8)', 'function symbol() view returns(string)'], provider);
    const decimals = Number(await c.decimals());
    check(Number.isInteger(decimals) && decimals >= 0 && decimals <= 36, 'UNSUPPORTED_DECIMALS');
    let symbol = 'TOKEN';
    try { symbol = String(await c.symbol()).slice(0, 32); } catch {}
    return { address: token, decimals, symbol };
  }));
}
function runtimeMatches(actual, artifact) {
  check(/^0x[0-9a-f]+$/i.test(actual), 'CONTRACT_RUNTIME_MISMATCH', 409);
  const a = Buffer.from(actual.slice(2), 'hex'), b = Buffer.from(artifact.deployedBytecode.slice(2), 'hex');
  check(a.length === b.length, 'CONTRACT_RUNTIME_MISMATCH', 409);
  for (const refs of Object.values(artifact.refs)) for (const { start, length } of refs) {
    check(start >= 0 && start + length <= b.length, 'INVALID_IMMUTABLE_REFERENCES', 409);
    a.fill(0, start, start + length); b.fill(0, start, start + length);
  }
  check(a.equals(b), 'CONTRACT_RUNTIME_MISMATCH', 409);
}
function immutableValues(actual, artifact, values) {
  for (const [id, refs] of Object.entries(artifact.refs)) {
    const value = values[artifact.immutableNames[id]];
    check(value, 'UNKNOWN_IMMUTABLE', 409);
    for (const { start, length } of refs) check(same('0x' + actual.slice(2 + start * 2, 2 + (start + length) * 2), ethers.zeroPadValue(value, length)), 'IMMUTABLE_VALUE_MISMATCH', 409);
  }
}
async function inspectWith(provider, input) {
  const config = normalized(input), compiled = artifacts();
  config.factory = address(input.factory);
  await identity(provider, config);
  if (config.scheme === 'deterministic-v2') {
    const root = await require('./deterministic.cjs').inspectRoot(provider, config);
    check(root.deployerReady, 'DETERMINISTIC_DEPLOYER_NOT_READY', 409);
    check(!input.deployer || same(input.deployer, root.deployer), 'DEPLOYER_ADDRESS_MISMATCH', 409);
    check(same(await root.root.predictFactory(config.payout), config.factory), 'DETERMINISTIC_FACTORY_MISMATCH', 409);
    config.deployer = root.deployer;
  }
  runtimeMatches(await provider.getCode(config.factory), compiled.ForwarderFactory);
  const factory = new ethers.Contract(config.factory, compiled.ForwarderFactory.abi, provider);
  const [payout, implementation, version, tokens, codehash] = await Promise.all([
    factory.payout(), factory.implementation(), factory.SALT_VERSION(), factory.getSettlementTokens(), factory.forwarderCodehash()
  ]);
  check(same(payout, config.payout) && version === 3n, 'FACTORY_IDENTITY_MISMATCH', 409);
  runtimeMatches(await provider.getCode(implementation), compiled.ForwarderImpl);
  const impl = new ethers.Contract(implementation, compiled.ForwarderImpl.abi, provider);
  check(same(await impl.hub(), config.factory) && same(await impl.payout(), config.payout), 'IMPLEMENTATION_IDENTITY_MISMATCH', 409);
  const clone = '0x363d3d373d3d3d363d73' + implementation.slice(2).toLowerCase() + '5af43d82803e903d91602b57fd5bf3';
  check(same(codehash, ethers.keccak256(clone)), 'FORWARDER_CODEHASH_MISMATCH', 409);
  // Masking alone is insufficient: a forged non-getter immutable could redirect sweeps.
  immutableValues(await provider.getCode(config.factory), compiled.ForwarderFactory, { payout: config.payout, implementation, forwarderCodehash: codehash });
  immutableValues(await provider.getCode(implementation), compiled.ForwarderImpl, { hub: config.factory, payout: config.payout });
  if (input.tokens) check(JSON.stringify(Array.from(tokens).map(x => x.toLowerCase())) === JSON.stringify(input.tokens.map(t => address(typeof t === 'string' ? t : t.address).toLowerCase())), 'TOKEN_REGISTRY_CHANGED', 409);
  for (const token of tokens) check(await factory.isSupportedToken(token), 'TOKEN_REGISTRY_CHANGED', 409);
  config.tokens = await metadata(provider, Array.from(tokens), config.payout);
  return config;
}
async function inspectDeployment(config) {
  const c = normalized(config), provider = new StrictProvider(c.rpcUrl);
  try { return await inspectWith(provider, config, false); } finally { provider.destroy(); }
}
const locks = new WeakMap();
class DeploymentService {
  constructor(store, { register, networks = OPEN_NETWORKS } = {}) {
    check(store && typeof store.get === 'function' && typeof store.set === 'function', 'INVALID_STORE');
    check(typeof register === 'function', 'REGISTER_REQUIRED');
    this.store = store; this.register = register;
    // Constructor-only test injection; request bodies/env cannot change admission.
    this.networks = Object.freeze(networks.map(n => Object.freeze({ ...n })));
    if (!locks.has(store)) locks.set(store, false);
  }
  async exclusive(fn) {
    check(!locks.get(this.store), 'DEPLOYMENT_BUSY', 409); locks.set(this.store, true);
    try { return await fn(); } finally { locks.set(this.store, false); }
  }
  record(id) { const r = this.store.get(META, []).find(j => j.id === id); check(r, 'DEPLOYMENT_NOT_FOUND', 404); return copy(r); }
  save(record) {
    const all = this.store.get(META, []), index = all.findIndex(j => j.id === record.id);
    const value = copy({ ...record, updatedAt: new Date().toISOString() });
    if (index < 0) all.push(value); else all[index] = value;
    this.store.set(META, all); return value;
  }
  view(r) {
    const { id, state, summary, createdAt, updatedAt, outcome, txHash, candidateHash, deploymentId, factory, error, from, startBlock, walletRequestRevision } = r;
    return copy({ id, state, summary, scheme: summary.scheme || 'legacy-v1', stage: summary.stage || 'merchant', createdAt, updatedAt, outcome, txHash, candidateHash, deploymentId, factory, error, from, startBlock, walletRequestRevision });
  }
  list() { return this.store.get(META, []).map(r => this.view(r)); }
  async preview(input) {
    admitNewDeployment(input, this.networks);
    return require('./deterministic.cjs').preview(input);
  }
  async get(id) { const r = this.record(id); return r.candidateHash && r.state !== 'MINED' ? this.refresh(id) : this.view(r); }
  async create(input) {
    check(input?.stage !== 'bootstrap', 'PUBLIC_BOOTSTRAP_OPS_ONLY', 403);
    const network = admitNewDeployment(input, this.networks);
    return this.exclusive(async () => {
      const config = normalized({ ...input, scheme: 'deterministic-v2', nativeSymbol: network.nativeSymbol }), provider = new StrictProvider(config.rpcUrl);
      try {
        await identity(provider, config);
        const d = require('./deterministic.cjs'), root = await d.inspectRoot(provider, config);
        const prediction = await d.previewWith(provider, config);
        Object.assign(config, { deployer: root.deployer, predictedFactory: prediction.factory });
        const r = { id: randomUUID(), state: 'READY', summary: config, createdAt: new Date().toISOString() };
        check(root.deployerReady, 'DETERMINISTIC_DEPLOYER_NOT_READY', 409);
        config.tokens = await metadata(provider, input.tokens, config.payout);
        r.to = root.deployer;
        r.data = root.root.interface.encodeFunctionData('deploy', [config.payout, config.tokens.map(t => t.address)]);
        if (prediction.factoryReady) {
          const verified = await inspectWith(provider, { ...config, factory: prediction.factory });
          const entry = await this.register(verified);
          Object.assign(r, { state: 'MINED', outcome: 'SUCCESS', factory: verified.factory, deploymentId: entry.id || entry.deploymentId });
        }
        return this.view(this.save(r));
      } finally { provider.destroy(); }
    });
  }
  async walletTransaction(r, from) {
      const provider = new StrictProvider(r.summary.rpcUrl);
      try {
        await identity(provider, r.summary);
        let root;
        if (r.summary.scheme === 'deterministic-v2') {
          root = await require('./deterministic.cjs').inspectRoot(provider, r.summary);
          if (r.summary.stage === 'merchant') {
            check(root.deployerReady, 'DETERMINISTIC_DEPLOYER_NOT_READY', 409);
            check(same(from, r.summary.payout), 'PAYOUT_WALLET_REQUIRED', 409);
            check(await provider.getCode(r.summary.predictedFactory) === '0x', 'DETERMINISTIC_FACTORY_ALREADY_EXISTS', 409);
          }
        }
        const destination = r.to ? { to: r.to } : {};
        let gas = await provider.estimateGas({ from, ...destination, data: r.data, value: 0n });
        if (root && r.summary.stage === 'bootstrap') {
          // ERC-2470 returns zero on failed CREATE2 instead of reverting: a cheap
          // successful outer call is not a successful root creation estimate.
          const creationGas = await provider.estimateGas({ from, data: root.artifact.bytecode, value: 0n });
          if (creationGas > gas) gas = creationGas;
          const result = await provider.call({ from, ...destination, data: r.data, value: 0n, gasLimit: gas * 120n / 100n });
          const [created] = new ethers.Interface(require('./deterministic.cjs').singletonABI).decodeFunctionResult('deploy', result);
          check(same(created, root.deployer), 'BOOTSTRAP_SIMULATION_FAILED', 409);
        }
        const startBlock = Number(BigInt(await provider.send('eth_blockNumber', [])));
        const transaction = { from, ...destination, data: r.data, value: '0x0', chainId: ethers.toQuantity(r.summary.chainId), gas: ethers.toQuantity(gas * 120n / 100n) };
        return { transaction, startBlock };
      } finally { provider.destroy(); }
  }
  async begin(id, input = {}, beforeSend) {
    check(Object.keys(input).every(k => k === 'from'), 'INVALID_TRANSACTION_FIELDS');
    return this.exclusive(async () => {
      const r = this.record(id); check(r.state === 'READY', 'DEPLOYMENT_NOT_READY', 409);
      const from = address(input.from); check(from !== ethers.ZeroAddress, 'INVALID_SENDER');
      if (beforeSend) beforeSend();
      const { transaction, startBlock } = await this.walletTransaction(r, from);
      if (beforeSend) beforeSend();
      Object.assign(r, { state: 'UNKNOWN', from, startBlock, intent: copy(transaction), walletRequestRevision: 0 });
      this.save(r); // durable before the wallet ever receives sendable data
      return { job: this.view(r), transaction };
    });
  }
  async retry(id, input = {}, beforeRetry) {
    check(Object.keys(input).length === 0, 'INVALID_TRANSACTION_FIELDS');
    check(typeof beforeRetry === 'function', 'DEPLOYMENT_PHONE_REQUIRED', 409);
    return this.exclusive(async () => {
      beforeRetry();
      const r = this.record(id);
      if (r.txHash || r.candidateHash || r.state === 'MINED') return { job: this.view(r), transaction: null };
      check(r.intent && r.from && (r.state === 'UNKNOWN' || r.state === 'CANCELLED' && r.outcome === 'REJECTED'), 'DEPLOYMENT_RETRY_UNAVAILABLE', 409);
      const { transaction } = await this.walletTransaction(r, r.from);
      beforeRetry(); // same capability and original deadline, checked after slow RPC work
      check(same(transaction.from, r.intent.from) && same(transaction.data, r.intent.data)
        && transaction.to === r.intent.to && transaction.chainId === r.intent.chainId && transaction.value === r.intent.value,
        'DEPLOYMENT_RETRY_SCOPE_CHANGED', 409);
      r.walletRequestRevision = (r.walletRequestRevision || 0) + 1;
      Object.assign(r, { state: 'UNKNOWN', outcome: null, error: null, intent: copy(transaction) });
      r.history ||= []; r.history.push({ type: 'CLIENT_REQUESTED_WALLET_RETRY', at: Date.now(), revision: r.walletRequestRevision });
      this.save(r); // preserve original startBlock and approved configuration
      return { job: this.view(r), transaction };
    });
  }
  async attach(id, input = {}) {
    check(Object.keys(input).every(k => ['transactionHash', 'requestRevision'].includes(k)), 'INVALID_TRANSACTION_FIELDS');
    check(/^0x[0-9a-f]{64}$/i.test(input.transactionHash || ''), 'INVALID_TRANSACTION_HASH');
    return this.exclusive(async () => {
      const r = this.record(id), hash = input.transactionHash.toLowerCase();
      check(r.intent, 'DEPLOYMENT_NOT_STARTED', 409);
      if (input.requestRevision !== undefined) check(Number.isSafeInteger(input.requestRevision) && input.requestRevision >= 0 && input.requestRevision <= (r.walletRequestRevision || 0), 'INVALID_WALLET_REQUEST_REVISION');
      check(!r.candidateHash || same(r.candidateHash, hash), 'TRANSACTION_HASH_ALREADY_ATTACHED', 409);
      check(!this.store.get(META, []).some(j => j.id !== id && same(j.candidateHash, hash)), 'TRANSACTION_HASH_IN_USE', 409);
      if (r.state === 'MINED') return this.view(r);
      Object.assign(r, { candidateHash: hash, state: 'UNKNOWN' }); this.save(r);
      return this.reconcile(r);
    });
  }
  async refresh(id) {
    return this.exclusive(async () => {
      const r = this.record(id);
      if (!r.candidateHash || r.state === 'MINED') return this.view(r);
      return this.reconcile(r);
    });
  }
  async reconcile(r) {
    const provider = new StrictProvider(r.summary.rpcUrl);
    try {
      await identity(provider, r.summary);
      const tx = await provider.getTransaction(r.candidateHash);
      if (!tx) return this.view(r);
      check(same(tx.hash, r.candidateHash) && same(tx.from, r.from) && (r.to ? same(tx.to, r.to) : tx.to === null) && tx.chainId === BigInt(r.summary.chainId) && tx.value === 0n && same(tx.data, r.data), 'DEPLOYMENT_TRANSACTION_MISMATCH', 409);
      if (r.summary.scheme === 'deterministic-v2' && tx.blockNumber !== null) check(tx.blockNumber > r.startBlock, 'DEPLOYMENT_TRANSACTION_PREDATES_INTENT', 409);
      r.txHash = r.candidateHash; this.save(r);
      const receipt = await provider.getTransactionReceipt(r.txHash);
      if (!receipt) return this.view(r);
      check(same(receipt.hash, r.txHash) && same(receipt.from, r.from) && (r.to ? same(receipt.to, r.to) : receipt.to === null), 'DEPLOYMENT_RECEIPT_MISMATCH', 409);
      const head = Number(BigInt(await provider.send('eth_blockNumber', [])));
      const block = await provider.getBlock(receipt.blockNumber);
      check(block && same(block.hash, receipt.blockHash), 'DEPLOYMENT_RECEIPT_REORG', 409);
      if (head - receipt.blockNumber + 1 < r.summary.confirmations) return this.view(r);
      if (receipt.status !== 1) {
        Object.assign(r, { state: 'MINED', outcome: 'FAILED', error: 'DEPLOYMENT_REVERTED' }); this.save(r); return this.view(r);
      }
      let factoryAddress = receipt.contractAddress;
      if (r.summary.scheme === 'deterministic-v2') {
        const root = await require('./deterministic.cjs').inspectRoot(provider, r.summary);
        check(root.deployerReady, 'DETERMINISTIC_DEPLOYER_NOT_READY', 409);
        if (r.summary.stage === 'bootstrap') {
          Object.assign(r, { state: 'MINED', outcome: 'SUCCESS', error: null, startBlock: receipt.blockNumber });
          this.save(r); return this.view(r);
        }
        check(same(tx.from, r.summary.payout), 'PAYOUT_WALLET_REQUIRED', 409);
        const events = receipt.logs.filter(l => same(l.address, root.deployer)).map(l => {
          try { return root.root.interface.parseLog(l); } catch { return null; }
        }).filter(e => e?.name === 'FactoryDeployed');
        check(events.length === 1 && same(events[0].args.payout, r.summary.payout)
          && same(events[0].args.factory, r.summary.predictedFactory), 'DEPLOYMENT_EVENT_MISMATCH', 409);
        factoryAddress = r.summary.predictedFactory;
      } else check(receipt.contractAddress && same(receipt.contractAddress, ethers.getCreateAddress({ from: tx.from, nonce: tx.nonce })), 'DEPLOYMENT_ADDRESS_MISMATCH', 409);
      const config = await inspectWith(provider, { ...r.summary, factory: factoryAddress, startBlock: receipt.blockNumber });
      const entry = await this.register(config);
      check(entry && (entry.id || entry.deploymentId), 'INVALID_REGISTRATION_RESULT', 502);
      Object.assign(r, { state: 'MINED', outcome: 'SUCCESS', deploymentId: entry.id || entry.deploymentId, factory: config.factory, startBlock: config.startBlock, error: null });
      this.save(r); return this.view(r);
    } catch (error) {
      r.error = error instanceof AppError ? error.code : 'DEPLOYMENT_RPC_ERROR'; this.save(r);
      // RPC propagation/errors are uncertainty, never evidence of success or permission to resend.
      if (error instanceof AppError) throw error;
      return this.view(r);
    } finally { provider.destroy(); }
  }
  async cancel(id, input = {}, beforeCancel) {
    check(input.rejected === true && Object.keys(input).every(k => ['rejected', 'requestRevision'].includes(k)), 'EXPLICIT_REJECTION_REQUIRED');
    return this.exclusive(async () => {
      if (beforeCancel) beforeCancel();
      const r = this.record(id);
      if ((r.walletRequestRevision || 0) > 0 || input.requestRevision !== undefined)
        check(input.requestRevision === (r.walletRequestRevision || 0), 'STALE_WALLET_REQUEST', 409);
      if (r.state === 'CANCELLED' && r.outcome === 'REJECTED') return this.view(r);
      check(r.state === 'READY' || (r.state === 'UNKNOWN' && !r.candidateHash), 'DEPLOYMENT_NOT_CANCELLABLE', 409);
      r.state = 'CANCELLED'; r.outcome = 'REJECTED'; this.save(r); return this.view(r);
    });
  }
}
module.exports = { DeploymentService, inspectDeployment, inspectWith, normalized, rpcConfig, StrictProvider, artifacts };
