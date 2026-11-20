'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Chain, ethers } = require('../chain.cjs');
const { createEngine } = require('../engine.cjs');

for (const chainId of [1, 56, 97, 11155111, 31337, 43210]) {
  test(`backend signing is forbidden on chain ${chainId}, even with legacy enabling options`, async () => {
    const chain = new Chain({ rpcUrl: 'https://127.0.0.1:1', chainId, factory: ethers.ZeroAddress },
      { externalWallet: false, externalEnabled: true, privateKey: 'NOT_A_PRIVATE_KEY' });
    chain.identity = () => { throw Error('MUST_NOT_CONTACT_RPC'); };
    try {
      await assert.rejects(chain.signer(), { code: 'CONNECTED_WALLET_REQUIRED' });
      await assert.rejects(chain.prepare([], []), { code: 'CONNECTED_WALLET_REQUIRED' });
    } finally { chain.close(); }
  });
}
test('fresh engine ignores legacy signing environment/options and contains no deployment', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upay-wallet-only-'));
  const previous = [process.env.UPAY_GAS_PRIVATE_KEY, process.env.UPAY_ENABLE_TESTNET_SEND];
  process.env.UPAY_GAS_PRIVATE_KEY = 'INVALID_KEY_MUST_NOT_BE_READ';
  process.env.UPAY_ENABLE_TESTNET_SEND = '1';
  let engine;
  try {
    engine = await createEngine(dir, { pollMs: 0, externalWallet: false, externalEnabled: true, privateKey: 'INVALID' });
    const status = engine.merchant.status();
    assert.equal(status.configured, false); assert.equal(status.gasWallet, null);
    assert.equal(status.sendMode, 'CONNECTED_WALLET'); assert.equal(status.externalTransactionsEnabled, false);
    assert.equal(engine.merchant.options.privateKey, undefined);
    assert.equal(engine.store.get('config'), null); assert.deepEqual(engine.store.orders(), []);
    for (const method of ['collect', 'collectPaid', 'submitCollection'])
      await assert.rejects(engine.merchant[method]({ orderIds: [] }), { code: 'CONNECTED_WALLET_REQUIRED' });
  } finally {
    await engine?.close(); fs.rmSync(dir, { recursive: true, force: true });
    for (const [index, key] of ['UPAY_GAS_PRIVATE_KEY', 'UPAY_ENABLE_TESTNET_SEND'].entries()) {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    }
  }
});
