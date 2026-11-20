'use strict';
const { initializePassword, PASSWORD } = require('./helpers/auth.cjs');
// Standalone local-chain harness for browser acceptance. Never binds or sends to any public network.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ethers } = require('ethers');
const { localServer } = require('./fixtures/dev-chain.cjs');
const { deployLocal } = require('./fixtures/local-tools.cjs');
const { start } = require('../server.cjs');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upay-wallet-browser-'));
  const local = await localServer(0);
  const provider = new ethers.JsonRpcProvider(local.url, undefined, { cacheTimeout: -1 });
  let app;
  try {
    if (Number((await provider.getNetwork()).chainId) !== 31337) throw Error('LOCAL_CHAIN_ONLY');
    const deployed = await deployLocal(provider);
    app = await start({ dir, port: 0, pollMs: 0, externalWallet: true, handoffPort: 0 });
    await initializePassword(app, dir);
    await app.merchant.configure({ rpcUrl: local.url, chainId: 31337, factory: deployed.factory.target,
      payout: deployed.payout, startBlock: deployed.startBlock, confirmations: 2 });
    const wallet = await provider.getSigner(2), account = await wallet.getAddress();
    const fixtures = [];
    for (const [reference, amount, payment, token] of [['WALLET-EXACT', '1', '1', deployed.a], ['WALLET-EXCESS', '2', '2.1', deployed.b]]) {
      const order = await app.merchant.create({ reference, amount, token: token.target, expiresInSeconds: 1800 });
      const units = ethers.parseUnits(payment, Number(await token.decimals()));
      await (await token.mint(account, units)).wait();
      await (await token.connect(wallet).transfer(order.address, units)).wait();
      fixtures.push({ id: order.id, token: token.target, address: order.address, decimals: Number(await token.decimals()), amount: units.toString() });
    }
    await provider.send('evm_mine', []); await app.merchant.scan();
    console.log(JSON.stringify({ ready: true, url: app.url, handoffOrigin: app.handoff.origin, rpcUrl: local.url, account, payout: deployed.payout,
      factory: deployed.factory.target, fixtures, password: PASSWORD, loginEndpoint: '/api/login', dir }));
    let stopping = false;
    async function close() {
      if (stopping) return; stopping = true;
      await app.close(); provider.destroy(); await local.server.close(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(0);
    }
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, close);
    process.stdin.resume(); process.stdin.once('end', close);
  } catch (error) {
    await app?.close(); provider.destroy(); await local.server.close(); fs.rmSync(dir, { recursive: true, force: true });
    console.error('LOCAL_WALLET_HARNESS_FAILED: ' + error.message); process.exitCode = 1;
  }
})();
