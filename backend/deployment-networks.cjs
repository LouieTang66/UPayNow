'use strict';
const { requireValue: check } = require('./chain.cjs');
// Product admission policy only. Never apply to RPC/inspection helpers or ops.
const OPEN_NETWORKS = Object.freeze([
  Object.freeze({ chainId: 56, name: 'BNB Smart Chain', defaultRPC: 'https://bsc-rpc.publicnode.com/', nativeSymbol: 'BNB' }),
  Object.freeze({ chainId: 42161, name: 'Arbitrum One', defaultRPC: 'https://arbitrum-one-rpc.publicnode.com/', nativeSymbol: 'ETH' }),
  Object.freeze({ chainId: 8453, name: 'Base', defaultRPC: 'https://base-rpc.publicnode.com/', nativeSymbol: 'ETH' }),
  Object.freeze({ chainId: 9745, name: 'Plasma', defaultRPC: 'https://rpc.plasma.to/', nativeSymbol: 'XPL' }),
  Object.freeze({ chainId: 196, name: 'X Layer', defaultRPC: 'https://xlayerrpc.okx.com/', nativeSymbol: 'OKB' }),
  Object.freeze({ chainId: 97, name: 'BSC Testnet（测试网）', defaultRPC: 'https://bsc-testnet-rpc.publicnode.com', nativeSymbol: 'tBNB' }),
  Object.freeze({ chainId: 11155111, name: 'Ethereum Sepolia（测试网）', defaultRPC: 'https://ethereum-sepolia-rpc.publicnode.com', nativeSymbol: 'ETH' })
]);
function requireOpenNetwork(input, networks = OPEN_NETWORKS) {
  const network = networks.find(n => n.chainId === Number(input?.chainId));
  check(network, 'DEPLOYMENT_NETWORK_NOT_OPEN', 403);
  return network;
}
module.exports = { OPEN_NETWORKS, requireOpenNetwork };
