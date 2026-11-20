'use strict';
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AppError, requireValue, address } = require('./chain.cjs');
const REGISTRY_KEY = 'deployments';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const copy = value => JSON.parse(JSON.stringify(value));
const identity = c => c?.factory && `${Number(c.chainId)}:${c.factory.toLowerCase()}`;
const nativeSymbol = c => c.nativeSymbol || (Number(c.chainId) === 56 ? 'BNB' : 'ETH');

class Deployments {
  constructor(rootEngine, { createEngine } = {}) {
    requireValue(rootEngine?.store?.dir && typeof createEngine === 'function', 'INVALID_DEPLOYMENTS_OPTIONS');
    this.rootEngine = rootEngine;
    this.createEngine = createEngine;
    rootEngine.id = 'legacy';
    this.entries = new Map([['legacy', rootEngine]]);
    this.descriptors = new Map();
    this.queue = Promise.resolve();
    this.closed = false;
  }
  _exclusive(fn) {
    const next = this.queue.then(() => {
      requireValue(!this.closed, 'DEPLOYMENTS_CLOSED', 503);
      return fn();
    });
    this.queue = next.catch(() => {});
    return next;
  }
  _config(engine) { return engine?.merchant?.chain?.config || engine?.store?.get('config'); }
  _normalize(input) {
    requireValue(input && typeof input === 'object', 'INVALID_DEPLOYMENT');
    let rpc;
    try { rpc = new URL(input.rpcUrl); } catch { throw new AppError('INVALID_RPC_URL'); }
    requireValue(rpc.protocol === 'https:', 'RPC_HTTPS_REQUIRED');
    requireValue(!rpc.username && !rpc.password && !rpc.hash, 'RPC_CREDENTIALS_NOT_ALLOWED');
    const config = { chainId: Number(input.chainId), factory: address(input.factory), payout: address(input.payout),
      rpcUrl: rpc.href, startBlock: Number(input.startBlock ?? 0), confirmations: Number(input.confirmations ?? 2) };
    requireValue(Number.isSafeInteger(config.chainId) && config.chainId > 0, 'INVALID_CHAIN_ID');
    requireValue(Number.isSafeInteger(config.startBlock) && config.startBlock >= 0, 'INVALID_START_BLOCK');
    requireValue(Number.isSafeInteger(config.confirmations) && config.confirmations >= 1 && config.confirmations <= 256, 'INVALID_CONFIRMATIONS');
    if (input.tokens !== undefined) {
      requireValue(Array.isArray(input.tokens) && input.tokens.length > 0, 'INVALID_TOKENS');
      config.tokens = input.tokens.map(t => typeof t === 'string' ? address(t) : { address: address(t.address), decimals: t.decimals, symbol: t.symbol });
    }
    config.scheme = input.scheme ?? 'legacy-v1';
    requireValue(['legacy-v1', 'deterministic-v2'].includes(config.scheme), 'INVALID_DEPLOYMENT_SCHEME');
    if (config.scheme === 'deterministic-v2' && input.deployer) config.deployer = address(input.deployer);
    config.name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 128) : `Chain ${config.chainId}`;
    config.nativeSymbol = typeof input.nativeSymbol === 'string' && input.nativeSymbol.trim() ? input.nativeSymbol.trim().slice(0, 32) : nativeSymbol(config);
    return config;
  }
  _existing(config) {
    const key = identity(config);
    for (const [id, engine] of this.entries) {
      if (identity(this.descriptors.get(id)?.config || this._config(engine)) === key) return engine;
    }
    return null;
  }
  async load() {
    return this._exclusive(async () => {
      const descriptors = this.rootEngine.store.get(REGISTRY_KEY, []);
      requireValue(Array.isArray(descriptors), 'INVALID_DEPLOYMENT_REGISTRY', 500);
      // No configure()/RPC call on recovery: each Merchant restores its own persisted config.
      await Promise.all(descriptors.map(async descriptor => {
        const id = descriptor?.id;
        if (typeof id !== 'string' || id === 'legacy' || this.entries.has(id)) return;
        this.descriptors.set(id, copy(descriptor));
        let engine;
        try {
          requireValue(UUID.test(id), 'INVALID_DEPLOYMENT_ID');
          const config = this._normalize(descriptor.config);
          engine = await this.createEngine(path.join(this.rootEngine.store.dir, 'deployments', id));
          requireValue(identity(this._config(engine)) === identity(config), 'DEPLOYMENT_CONFIG_MISMATCH', 409);
          engine.id = id;
          this.entries.set(id, engine);
        } catch (error) {
          if (engine) await engine.close().catch(() => {});
          // A broken entry remains visible; never delete or rewrite its historical database.
          this.entries.set(id, { id, error: error.code || error.message || 'DEPLOYMENT_LOAD_FAILED',
            merchant: null, store: null, wallet: null, handoff: null, hooks: null, close: async () => {} });
        }
      }));
      return this;
    });
  }
  get(id = 'legacy') {
    const entry = this.entries.get(id);
    requireValue(entry, 'DEPLOYMENT_NOT_FOUND', 404);
    return entry;
  }
  list() {
    return { deployments: Array.from(this.entries, ([id, engine]) => {
      const c = this.descriptors.get(id)?.config || this._config(engine) || {};
      return { id, name: (id === 'legacy' && this.rootEngine.store.get('deployments.legacy-name')) || c.name || (c.chainId ? `Chain ${c.chainId}` : '未配置'), chainId: c.chainId ?? null,
        factory: c.factory ?? null, payout: c.payout ?? null, tokens: copy(c.tokens || []),
        scheme: c.scheme || 'legacy-v1', deployer: c.deployer || null,
        nativeSymbol: c.chainId ? nativeSymbol(c) : null, ...(engine.error ? { error: engine.error } : {}) };
    }), defaultId: 'legacy' };
  }
  async rename(id, input) {
    return this._exclusive(() => {
      this.get(id);
      requireValue(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 1 && typeof input.name === 'string', 'INVALID_DEPLOYMENT_NAME');
      const name = input.name.trim();
      requireValue(name.length > 0 && name.length <= 128, 'INVALID_DEPLOYMENT_NAME');
      // Display metadata only: never reconfigure a merchant or touch its chain/database.
      if (id === 'legacy') this.rootEngine.store.set('deployments.legacy-name', name);
      else {
        const previous = this.descriptors.get(id);
        requireValue(previous, 'DEPLOYMENT_NOT_FOUND', 404);
        const descriptor = { ...previous, config: { ...previous.config, name } };
        this.rootEngine.store.set(REGISTRY_KEY, [...this.descriptors].map(([key, value]) => key === id ? descriptor : value));
        this.descriptors.set(id, descriptor);
      }
      return this.list().deployments.find(d => d.id === id);
    });
  }
  async import(input) {
    return this._exclusive(async () => {
      const config = this._normalize(input);
      const existing = this._existing(config);
      if (existing) return existing;
      // Lazy loading permits the independently implemented deployment service to be installed later.
      const { inspectDeployment } = require('./deployment-service.cjs');
      const verified = await inspectDeployment(config);
      return this._register(this._normalize({ ...config, ...verified }));
    });
  }
  // Trusted internal callback: DeploymentService must have already verified the receipt/deployment.
  async register(config) {
    return this._exclusive(() => this._register(this._normalize(config)));
  }
  async _register(config) {
    const existing = this._existing(config);
    if (existing) return existing;
    const id = randomUUID();
    let engine;
    try {
      engine = await this.createEngine(path.join(this.rootEngine.store.dir, 'deployments', id));
      await engine.merchant.configure(config);
      const actual = this._config(engine);
      requireValue(identity(actual) === identity(config), 'DEPLOYMENT_CONFIG_MISMATCH', 409);
      const descriptor = { id, config: copy({ ...config, ...actual, name: config.name, nativeSymbol: config.nativeSymbol }) };
      // Persist only descriptors of new deployments; never save legacy config here.
      this.rootEngine.store.set(REGISTRY_KEY, [...this.descriptors.values(), descriptor]);
      engine.id = id;
      this.descriptors.set(id, descriptor);
      this.entries.set(id, engine);
      return engine;
    } catch (error) {
      if (engine) await engine.close().catch(() => {});
      // Even failed UUID directories are retained, never recursively removed.
      throw error;
    }
  }
  findPublic(token) {
    for (const engine of this.entries.values()) {
      const order = engine.store?.publicOrder(token);
      if (order) return { engine, order };
    }
    throw new AppError('NOT_FOUND', 404);
  }
  findHandoff(id) {
    for (const engine of this.entries.values()) if (engine.handoff && engine.store?.handoff(id)) return engine.handoff;
    throw new AppError('HANDOFF_NOT_FOUND', 404);
  }
  async close() {
    await this.queue;
    if (this.closed) return;
    this.closed = true;
    const results = await Promise.allSettled(Array.from(this.entries, ([id, engine]) => id === 'legacy' ? undefined : engine.close()));
    const failed = results.find(r => r.status === 'rejected');
    if (failed) throw failed.reason;
  }
}
module.exports = { Deployments };
