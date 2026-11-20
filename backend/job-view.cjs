'use strict';
const { ethers } = require('./chain.cjs');
function publicJob(job) {
  if (!job) return null;
  const view = { ...job };
  // PREPARED is review-only, including nested jobs returned by status/detail APIs.
  if (job.externalWallet && job.state === 'PREPARED') {
    delete view.transaction; delete view.data; delete view.nonce; delete view.observedNonce;
  }
  return view;
}
function review(job) {
  return { chainId: job.chainId, from: job.from, to: job.transaction.to, value: '0x0', calldataHash: ethers.keccak256(job.data) };
}
module.exports = { publicJob, review };
