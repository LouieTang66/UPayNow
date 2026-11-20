'use strict';
const { ethers } = require('ethers');
const abi = require('../docs/multi-ca-abi.json').contracts.ForwarderFactory.abi;
const ERC20 = ['function decimals() view returns(uint8)', 'function symbol() view returns(string)',
  'function balanceOf(address) view returns(uint256)', 'event Transfer(address indexed from,address indexed to,uint256 value)'];
const transfer = new ethers.Interface(ERC20);
class AppError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
function requireValue(ok, code, status) { if (!ok) throw new AppError(code, status); }
function address(value) {
  try { return ethers.getAddress(value); } catch { throw new AppError('INVALID_ADDRESS'); }
}
class Chain {
  constructor(config) {
    let rpc;
    try { rpc = new URL(config?.rpcUrl); } catch { throw new AppError('INVALID_RPC_URL'); }
    requireValue(rpc.protocol === 'https:', 'RPC_HTTPS_REQUIRED');
    requireValue(!rpc.username && !rpc.password, 'RPC_CREDENTIALS_NOT_ALLOWED');
    this.config = config;
    const request = new ethers.FetchRequest(config.rpcUrl);
    request.timeout = 10000;
    this.provider = new ethers.JsonRpcProvider(request, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
    this.factory = new ethers.Contract(config.factory, abi, this.provider);
  }
  async identity() {
    const id = Number(BigInt(await this.provider.send('eth_chainId', [])));
    requireValue(id === this.config.chainId, 'CHAIN_ID_MISMATCH', 409);
    const [payout, tokens, version, implementation] = await Promise.all([
      this.factory.payout(), this.factory.getSettlementTokens(), this.factory.SALT_VERSION(), this.factory.implementation()]);
    requireValue(payout === this.config.payout && version === 3n, 'FACTORY_IDENTITY_MISMATCH', 409);
    requireValue(await this.provider.getCode(implementation) !== '0x', 'MISSING_IMPLEMENTATION', 409);
    if (this.config.tokens) requireValue(JSON.stringify(Array.from(tokens)) === JSON.stringify(this.config.tokens.map(t => t.address)), 'TOKEN_REGISTRY_CHANGED', 409);
    return tokens;
  }
  async metadata() {
    const tokens = await this.identity();
    return Promise.all(tokens.map(async token => {
      const c = new ethers.Contract(token, ERC20, this.provider);
      const decimals = Number(await c.decimals());
      requireValue(decimals >= 0 && decimals <= 36, 'UNSUPPORTED_DECIMALS');
      let symbol = 'TOKEN';
      try { symbol = String(await c.symbol()).slice(0, 32); } catch {}
      return { address: token, decimals, symbol };
    }));
  }
  async head() { return Number(BigInt(await this.provider.send('eth_blockNumber', []))); }
  async block(number) { return this.provider.getBlock(number); }
  async signer() {
    throw new AppError('CONNECTED_WALLET_REQUIRED', 409);
  }
  async logs(from, to, orders) {
    const found = [];
    for (let i = 0; i < orders.length; i += 100) {
      found.push(...await this.provider.getLogs({ fromBlock: from, toBlock: to,
        address: this.config.tokens.map(t => t.address),
        topics: [transfer.getEvent('Transfer').topicHash, null,
          orders.slice(i, i + 100).map(o => ethers.zeroPadValue(o.address, 32))] }));
    }
    return found;
  }
  async balance(token, owner, blockTag) {
    return new ethers.Contract(token, ERC20, this.provider).balanceOf(owner, { blockTag });
  }
  async encodeCollection(orderIds, orders, wrongToken, normalToken) {
    requireValue(wrongToken === undefined || normalToken === undefined, "AMBIGUOUS_COLLECTION_TOKEN");
    const override = normalToken === undefined ? undefined : address(normalToken);
    requireValue(override === undefined || this.config.tokens.some(t => t.address === override), "UNSUPPORTED_COLLECTION_TOKEN");
    const factory = this.factory;
    const selected = orderIds.map(id => {
      const o = orders.find(o => o.id === id);
      requireValue(o, 'ORDER_NOT_FOUND', 404);
      return o;
    });
    const pairs = selected.map(o => ({ orderIdHash: o.orderHash, token: wrongToken === undefined ? override || o.token : address(wrongToken) }));
    let request;
    if (wrongToken !== undefined) {
      requireValue(selected.length === 1, 'WRONG_TOKEN_REQUIRES_ONE_ORDER');
      const token = address(wrongToken);
      requireValue(!this.config.tokens.some(t => t.address === token), 'SUPPORTED_TOKEN_USE_NORMAL_COLLECTION');
      request = await factory.collectWrongToken.populateTransaction(selected[0].orderHash, token);
    } else request = await factory.collectBatch.populateTransaction(pairs);
    return { request, pairs };
  }
  async prepare() {
    throw new AppError('CONNECTED_WALLET_REQUIRED', 409);
  }
  parse(receipt) {
    return receipt.logs.filter(l => l.address.toLowerCase() === this.config.factory.toLowerCase())
      .map(l => { try { return this.factory.interface.parseLog(l); } catch { return null; } }).filter(Boolean)
      .map(e => ({ name: e.name, orderHash: e.args.orderIdHash, forwarder: e.args.forwarder,
        token: e.args.token || null, amount: (e.args.amount ?? e.args.amountSent)?.toString() || null,
        reasonSelector: e.args.reasonSelector || null }));
  }
  close() { this.provider.destroy(); }
}
module.exports = { Chain, AppError, requireValue, address, ethers, transfer };
