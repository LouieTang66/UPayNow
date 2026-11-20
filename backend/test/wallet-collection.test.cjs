'use strict';
const { apiKey } = require('./helpers/auth.cjs');
// Real local EVM only. Never reuse the operator's dev node or testnet state.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ethers } = require('ethers');
const { start } = require('../server.cjs');
const { localServer } = require('./fixtures/dev-chain.cjs');
const { deployLocal } = require('./fixtures/local-tools.cjs');
const { WalletCollection } = require('../wallet-collection.cjs');

test('external-wallet collection: isolated real EVM / HTTP / durable SQLite', { timeout: 180000 }, async t => {
  const local = await localServer(0);
  const provider = new ethers.JsonRpcProvider(local.url, undefined, { cacheTimeout: -1 });
  let deployed;
  const fixtures = new Set();
  try {
    assert.equal(Number((await provider.getNetwork()).chainId), 31337);
    assert.notEqual(new URL(local.url).port, '18545');
    deployed = await deployLocal(provider);
    // Wallet signing is performed by this test's provider, never Merchant.chain.signer().
    const wallet = await provider.getSigner(3), customer = await provider.getSigner(2);
    const from = await wallet.getAddress();
    let serial = 0;
    async function fixture() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upaynow-wallet-collection-'));
      const f = { dir, app: null };
      fixtures.add(f);
      f.open = async () => {
        // Deliberately invalid: external mode must not even parse a supplied private key.
        f.app = await start({ dir, port: 0, pollMs: 0, externalWallet: true, privateKey: 'MUST_NOT_LOAD_THIS_KEY' });
        assert.notEqual(new URL(f.app.url).port, '8797');
      };
      await f.open();
      const secret = apiKey(dir);
      f.api = async (route, data, expected = 200) => {
        const response = await fetch(f.app.url + '/api/' + route, {
          method: data === undefined ? 'GET' : 'POST',
          headers: { Authorization: 'Bearer ' + secret, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
          body: data === undefined ? undefined : JSON.stringify(data)
        });
        const result = await response.json();
        assert.equal(response.status, expected, route + ': ' + JSON.stringify(result));
        return result;
      };
      await f.api('config', { rpcUrl: local.url, chainId: 31337, factory: deployed.factory.target,
        payout: deployed.payout, startBlock: 0, confirmations: 1 });
      f.create = (token = deployed.a, amount = '1') => f.api('orders', {
        reference: 'WALLET-' + (++serial), token: token.target, amount, expiresInSeconds: 86400
      }, 201);
      f.prepare = (orders, extra = {}, expected = 201) => f.api('wallet/prepare', {
        from, orderIds: orders.map(o => o.id), mode: 'manual', ...extra
      }, expected);
      f.action = (job, action, body = {}, expected = 200) => f.api('wallet/jobs/' + job.id + '/' + action, body, expected);
      f.restart = async () => { await f.app.close(); f.app = null; await f.open(); };
      f.close = async () => {
        if (f.app) { await f.app.close(); f.app = null; }
        fs.rmSync(dir, { recursive: true, force: true }); fixtures.delete(f);
      };
      return f;
    }
    async function pay(order, amount, token = deployed.a) {
      const units = ethers.parseUnits(amount, Number(await token.decimals()));
      await (await token.mint(await customer.getAddress(), units)).wait();
      await (await token.connect(customer).transfer(order.address, units)).wait();
    }
    async function send(transaction, signer = wallet, overrides = {}) {
      const { gas, ...request } = transaction;
      let sent;
      try {
        sent = await signer.sendTransaction({ ...request, gasLimit: gas, ...overrides });
      } catch (error) {
        // Hardhat reports reverted sends as RPC errors even though it mined a real tx.
        // Only accept the hash returned by that RPC, and require its actual receipt.
        const hash = error.error?.data?.txHash;
        if (!hash) throw error;
        const receipt = await provider.getTransactionReceipt(hash);
        assert.ok(receipt, 'reverted RPC send must have a real mined receipt');
        assert.equal(receipt.status, 0);
        return provider.getTransaction(hash);
      }
      try { await sent.wait(); } catch (error) { if (!error.receipt) throw error; }
      return sent;
    }
    async function collect(f, prepared) {
      const begun = await f.action(prepared.job, 'begin');
      assert.equal(begun.job.state, 'UNKNOWN');
      const sent = await send(begun.transaction);
      const job = await f.action(prepared.job, 'attach', { transactionHash: sent.hash });
      assert.equal(job.state, 'MINED'); assert.equal(job.outcome, 'SUCCESS');
      assert.equal(job.txHash, sent.hash);
      return job;
    }

    await t.test('config validation, no gas wallet/key loading, legacy sends and Chain.signer fail closed', async () => {
      const f = await fixture();
      try {
        const status = await f.api('status');
        assert.equal(status.gasWallet, null); assert.equal(status.sendMode, 'CONNECTED_WALLET');
        assert.equal(f.app.merchant.options.privateKey, undefined);
        const config = await f.api('wallet/config');
        assert.equal(config.enabled, true); assert.equal(config.chainId, 31337);
        assert.equal(config.factory, deployed.factory.target); assert.equal(config.payout, deployed.payout);
        assert.equal(config.rpcUrl.replace(/\/$/, ''), local.url);
        for (const projectId of ['', 'aB'.repeat(16)]) {
          assert.equal((await f.api('wallet/config', { projectId })).projectId, projectId);
        }
        for (const projectId of ['x'.repeat(32), 'abc', 123, null]) {
          assert.equal((await f.api('wallet/config', { projectId }, 400)).error, 'INVALID_WALLETCONNECT_PROJECT_ID');
        }
        await assert.rejects(f.app.merchant.chain.signer(), { code: 'CONNECTED_WALLET_REQUIRED' });
        const order = await f.create(); await pay(order, '1');
        for (const route of ['collect', 'collect-all']) {
          assert.equal((await f.api(route, { orderIds: [order.id] }, 409)).error, 'CONNECTED_WALLET_REQUIRED');
        }
        f.app.merchant.chain.signer = () => { throw new Error('BACKEND_SIGNER_MUST_NEVER_BE_USED'); };
        const prepared = await f.prepare([order]);
        assert.equal(prepared.job.state, 'PREPARED');
        await f.action(prepared.job, 'cancel');
      } finally { await f.close(); }
    });

    await t.test('exact + overpaid two-CA batch: fixed payout, one nonce, no preview/prepare/begin broadcast, exclusions', async () => {
      const f = await fixture();
      try {
        const exact = await f.create(), over = await f.create(deployed.b, '2');
        const under = await f.create(), wrong = await f.create(), empty = await f.create();
        await pay(exact, '1'); await pay(exact, '7', deployed.b); await pay(over, '2.5', deployed.b);
        await pay(under, '0.5'); await pay(wrong, '9', deployed.b);
        const nonce = await wallet.getNonce('pending'), native = await provider.getBalance(from);
        const payoutA = await deployed.a.balanceOf(deployed.payout), payoutB = await deployed.b.balanceOf(deployed.payout);
        const preview = await f.api('collect-all/preview', {});
        assert.equal(preview.payout, deployed.payout);
        assert.deepEqual(new Set(preview.entries.map(x => x.id)), new Set([exact.id, over.id]));
        const prepared = await f.prepare([exact, over, under, wrong, empty], { mode: 'paid' });
        assert.equal(prepared.skipped, 3); assert.equal(prepared.job.state, 'PREPARED');
        assert.deepEqual(new Set(prepared.job.orderIds), new Set([exact.id, over.id]));
        assert.deepEqual(new Set(prepared.job.pairs.map(p => p.token)), new Set([deployed.a.target, deployed.b.target]));
        assert.equal(prepared.transaction, undefined); assert.equal(prepared.job.transaction, undefined); assert.equal(prepared.job.data, undefined);
        assert.equal(prepared.summary.to, deployed.factory.target); assert.equal(prepared.summary.from, from);
        const begun = await f.action(prepared.job, 'begin');
        for (const key of ['chainId', 'gas', 'value']) assert.match(begun.transaction[key], /^0x[0-9a-f]+$/i);
        assert.equal(begun.transaction.nonce, undefined);
        assert.equal(begun.job.state, 'UNKNOWN');
        assert.equal(await wallet.getNonce('pending'), nonce);
        assert.equal(await provider.getBalance(from), native);
        assert.equal(await deployed.a.balanceOf(exact.address), 1000000n);
        const sent = await send(begun.transaction);
        const mined = await f.action(prepared.job, 'attach', { transactionHash: sent.hash });
        assert.equal(mined.state, 'MINED'); assert.equal(mined.outcome, 'SUCCESS');
        assert.equal(mined.events.filter(e => e.name === 'Collected').length, 2);
        assert.equal(await wallet.getNonce('pending'), nonce + 1);
        assert.equal(await deployed.a.balanceOf(deployed.payout) - payoutA, 1000000n);
        assert.equal(await deployed.b.balanceOf(deployed.payout) - payoutB, ethers.parseUnits('2.5', 18));
        assert.equal(await deployed.a.balanceOf(exact.address), 0n); assert.equal(await deployed.b.balanceOf(over.address), 0n);
        assert.equal(await deployed.b.balanceOf(exact.address), ethers.parseUnits('7', 18));
        assert.equal(await deployed.a.balanceOf(under.address), 500000n);
        assert.equal(await deployed.b.balanceOf(wrong.address), ethers.parseUnits('9', 18));
        const repeated = await f.prepare([exact, over, under, wrong, empty], { mode: 'paid' });
        assert.equal(repeated.job, null); assert.equal(repeated.summary, null); assert.equal(repeated.skipped, 5);
        assert.equal(await wallet.getNonce('pending'), nonce + 1);
      } finally { await f.close(); }
    });

    for (const result of ['SUCCESS', 'FAILED', 'UNRESOLVED']) await t.test('manual resolution '+result+' accepts known hash offline, persists audit and ignores late responses', async () => {
      const f = await fixture();
      try {
        const order = await f.create(); await pay(order, '1');
        const prepared = await f.prepare([order]); await f.action(prepared.job, 'begin');
        const hash = ethers.id('manual-missing-'+result);
        await f.action(prepared.job, 'attach', { transactionHash: hash });
        const chain = f.app.merchant.chain, identity = chain.identity, refresh = f.app.merchant.refreshJobs;
        chain.identity = async () => { throw Error('RPC offline'); };
        f.app.merchant.refreshJobs = async () => { throw Error('RPC offline'); };
        let resolved;
        try {
          await f.action(prepared.job, 'resolve', { note: '已核对测试记录', result }, 400);
          await f.action(prepared.job, 'resolve', { acknowledge: true, note: '已核对测试记录', result: 'INVALID' }, 400);
          resolved = await f.action(prepared.job, 'resolve', { acknowledge: true, note: '已核对测试记录', result, expectedState: 'UNKNOWN' });
        } finally { chain.identity = identity; f.app.merchant.refreshJobs = refresh; }
        assert.equal(resolved.state, 'ABANDONED'); assert.equal(resolved.manualResolution.result, result);
        assert.equal(resolved.candidateHash, hash); assert.equal(resolved.manualResolution.verifiedOnChain, false);
        assert.equal(resolved.history.at(-1).type, 'ADMIN_MANUAL_RESOLUTION');
        await f.action(prepared.job, 'attach', { transactionHash: hash }, 409);
        await f.action(prepared.job, 'refresh');
        await f.restart();
        const saved = f.app.store.job(prepared.job.id);
        assert.equal(saved.manualResolution.result, result); assert.equal(saved.state, 'ABANDONED');
        const next = await f.prepare([order]); assert.equal(next.job.state, 'PREPARED');
      } finally { await f.close(); }
    });

    await t.test('per-order PREPARED/UNKNOWN lock allows unrelated orders; concurrent clicks, cancel and rejection spend no gas', async () => {
      const f = await fixture();
      try {
        const a = await f.create(), b = await f.create(); await pay(a, '1'); await pay(b, '1');
        const nonce = await wallet.getNonce('pending'), balance = await provider.getBalance(from);
        let prepared = await f.prepare([a]);
        assert.equal((await f.prepare([a], {}, 409)).error, 'TRANSACTION_RECONCILIATION_REQUIRED');
        assert.equal((await f.action(prepared.job, 'cancel')).state, 'CANCELLED');
        prepared = await f.prepare([a]); await f.action(prepared.job, 'begin');
        const available = await f.api('collect-all/preview', {});
        assert(available.entries.some(o => o.id === b.id)); assert(!available.entries.some(o => o.id === a.id));
        const unrelated = await f.prepare([b]); assert.equal(unrelated.job.state, 'PREPARED');
        await f.action(unrelated.job, 'cancel');
        assert.equal((await f.action(prepared.job, 'begin', {}, 409)).error, 'WALLET_JOB_NOT_PREPARED');
        assert.equal((await f.prepare([a], {}, 409)).error, 'TRANSACTION_RECONCILIATION_REQUIRED');
        assert.equal((await f.action(prepared.job, 'cancel', { code: -32000 }, 409)).error, 'UNCERTAIN_TRANSACTION_CANNOT_CANCEL');
        assert.equal((await f.action(prepared.job, 'cancel', { rejected: true, code: 4001 })).state, 'CANCELLED');
        assert.equal(await wallet.getNonce('pending'), nonce); assert.equal(await provider.getBalance(from), balance);
        const replies = await Promise.all([0, 1].map(async () => {
          const response = await fetch(f.app.url + '/api/wallet/prepare', { method: 'POST', headers: {
            Authorization: 'Bearer ' + apiKey(f.dir), 'Content-Type': 'application/json'
          }, body: JSON.stringify({ from, orderIds: [a.id], mode: 'manual' }) });
          return { status: response.status, body: await response.json() };
        }));
        assert.deepEqual(replies.map(r => r.status).sort(), [201, 409]);
        assert.equal(f.app.store.jobs().filter(j => j.state === 'PREPARED').length, 1);
        const winner = replies.find(r => r.status === 201).body;
        await collect(f, winner);
      } finally { await f.close(); }
    });

    await t.test('wallet chooses nonce despite transactions before/after begin, actual receipt releases the lock', async () => {
      const f = await fixture();
      try {
        const order = await f.create(); await pay(order, '1');
        const p = await f.prepare([order]);
        await (await wallet.sendTransaction({ to: from, value: 0n })).wait();
        const begun = await f.action(p.job, 'begin');
        assert.equal(begun.transaction.nonce, undefined);
        await (await wallet.sendTransaction({ to: from, value: 0n })).wait();
        const sent = await send(begun.transaction);
        const job = await f.action(p.job, 'attach', { transactionHash: sent.hash });
        assert.equal(job.state, 'MINED'); assert.equal(job.nonce, sent.nonce); assert.equal(job.outcome, 'SUCCESS');
        assert.equal((await f.prepare([await f.create()])).job.state, 'PREPARED');
      } finally { await f.close(); }
    });

    await t.test('PREPARED expires after five minutes; UNKNOWN and unseen candidate persist restart and block retries', async () => {
      const f = await fixture();
      try {
        const order = await f.create(); await pay(order, '1');
        let p = await f.prepare([order]);
        assert.equal(p.job.expiresAt - p.job.createdAt, 300000);
        let job = f.app.store.job(p.job.id); job.expiresAt = Date.now() - 1; f.app.store.saveJob(job);
        assert.equal((await f.action(job, 'begin', {}, 409)).error, 'WALLET_JOB_NOT_PREPARED');
        assert.equal(f.app.store.job(job.id).state, 'EXPIRED');
        p = await f.prepare([order]); await f.action(p.job, 'begin');
        job = f.app.store.job(p.job.id); job.expiresAt = Date.now() - 3600000; f.app.store.saveJob(job);
        const missingHash = ethers.keccak256(ethers.toUtf8Bytes('not-a-real-transaction-' + job.id));
        job = await f.action(job, 'attach', { transactionHash: missingHash });
        assert.equal(job.state, 'UNKNOWN'); assert.equal(job.candidateHash, missingHash); assert.equal(job.txHash, null);
        await f.restart(); await f.api('scan', {});
        job = f.app.store.job(job.id);
        assert.equal(job.state, 'UNKNOWN'); assert.equal(job.candidateHash, missingHash); assert.equal(job.outcome, undefined);
        assert.equal((await f.prepare([order], {}, 409)).error, 'TRANSACTION_RECONCILIATION_REQUIRED');
        assert.equal((await f.action(job, 'cancel', { rejected: true }, 409)).error, 'UNCERTAIN_TRANSACTION_CANNOT_CANCEL');
        // A subsequently supplied real hash resolves this exact durable job, rather than inventing success.
        const sent = await send(job.transaction);
        const mined = await f.action(job, 'attach', { transactionHash: sent.hash });
        assert.equal(mined.state, 'MINED'); assert.equal(mined.outcome, 'SUCCESS');
      } finally { await f.close(); }
    });

    await t.test('candidate RPC propagation delay is persisted and a later real scan recognizes the receipt', async () => {
      const f = await fixture();
      try {
        const order = await f.create(); await pay(order, '1');
        const p = await f.prepare([order]); const begun = await f.action(p.job, 'begin');
        const sent = await send(begun.transaction);
        const rpc = f.app.merchant.chain.provider, original = rpc.getTransaction.bind(rpc), originalBlock = rpc.getBlock.bind(rpc);
        rpc.getTransaction = async hash => hash === sent.hash ? null : original(hash);
        rpc.getBlock = async (height, prefetch) => {
          const block = await originalBlock(height, prefetch);
          if (!prefetch || !block) return block;
          return Object.defineProperty(Object.create(block), 'prefetchedTransactions', { value: block.prefetchedTransactions.filter(tx => tx.hash !== sent.hash) });
        };
        try {
          const unseen = await f.action(p.job, 'attach', { transactionHash: sent.hash });
          assert.equal(unseen.state, 'UNKNOWN'); assert.equal(unseen.candidateHash, sent.hash); assert.equal(unseen.txHash, null);
        } finally { rpc.getTransaction = original; rpc.getBlock = originalBlock; }
        await f.restart(); await f.api('scan', {});
        const mined = f.app.store.job(p.job.id);
        assert.equal(mined.state, 'MINED'); assert.equal(mined.txHash, sent.hash); assert.equal(mined.outcome, 'SUCCESS');
      } finally { await f.close(); }
    });

    for (const mismatch of ['from', 'to', 'data', 'value']) {
      await t.test('real unrelated transaction rejected: mismatched ' + mismatch, async () => {
        const f = await fixture();
        try {
          const order = await f.create(); await pay(order, '1');
          const p = await f.prepare([order]); const begun = await f.action(p.job, 'begin');
          assert.equal((await f.action(p.job, 'attach', { transactionHash: '0x1234' }, 400)).error, 'INVALID_TRANSACTION_HASH');
          let signer = wallet, overrides = { gasLimit: 1000000n };
          if (mismatch === 'from') {
            signer = await provider.getSigner(4);
            overrides.from = await signer.getAddress();
          }
          if (mismatch === 'to') overrides.to = await customer.getAddress();
          if (mismatch === 'data') overrides.data = '0x';
          if (mismatch === 'value') overrides.value = 1n;
          const sent = await send(begun.transaction, signer, overrides);
          const result = await f.action(p.job, 'attach', { transactionHash: sent.hash });
          assert.equal(result.state, 'UNKNOWN'); assert.equal(result.txHash, null);
          assert.equal(result.error, 'TRANSACTION_DOES_NOT_MATCH_JOB'); assert.equal(result.outcome, undefined);
          await f.api('scan', {}); assert.equal(f.app.store.job(p.job.id).state, 'UNKNOWN');
          assert.equal((await f.prepare([order], {}, 409)).error, 'TRANSACTION_RECONCILIATION_REQUIRED');
          assert.equal((await f.action(p.job, 'cancel', { rejected: true, code: 4001 }, 409)).error,
            'UNCERTAIN_TRANSACTION_CANNOT_CANCEL');
        } finally { await f.close(); }
      });
    }

    await t.test('supported-token override and wrong-token confirmation preserve invoice accounting and fixed payout', async () => {
      const f = await fixture();
      try {
        const order = await f.create(); await pay(order, '3', deployed.b);
        const before = await deployed.b.balanceOf(deployed.payout);
        assert.equal((await f.prepare([order], { mode: 'paid', token: deployed.b.target }, 400)).error, 'PAID_COLLECTION_TOKEN_OVERRIDE_FORBIDDEN');
        assert.equal((await f.prepare([order], { token: ethers.ZeroAddress }, 400)).error, 'UNSUPPORTED_COLLECTION_TOKEN');
        assert.equal((await f.prepare([order], { wrongToken: deployed.b.target }, 400)).error, 'WRONG_TOKEN_CONFIRMATION_REQUIRED');
        assert.equal((await f.prepare([order], { wrongToken: deployed.b.target, confirmWrongToken: true }, 400)).error, 'SUPPORTED_TOKEN_USE_NORMAL_COLLECTION');
        await collect(f, await f.prepare([order], { token: deployed.b.target }));
        assert.equal(await deployed.b.balanceOf(deployed.payout) - before, ethers.parseUnits('3', 18));
        await f.api('scan', {});
        const detail = await f.api('orders/' + order.id);
        assert.equal(detail.token, deployed.a.target); assert.equal(detail.paid, false); assert.equal(BigInt(detail.confirmedUnits), 0n);
        const artifact = deployed.artifacts.token;
        const wrong = await new ethers.ContractFactory(artifact.abi, artifact.evm.bytecode.object, customer).deploy('WRONG', 6);
        await wrong.waitForDeployment(); await pay(order, '4', wrong);
        assert.equal((await f.prepare([order], { wrongToken: wrong.target }, 400)).error, 'WRONG_TOKEN_CONFIRMATION_REQUIRED');
        const beforeWrong = await wrong.balanceOf(deployed.payout);
        await collect(f, await f.prepare([order], { wrongToken: wrong.target, confirmWrongToken: true }));
        assert.equal(await wrong.balanceOf(deployed.payout) - beforeWrong, 4000000n);
        assert.equal(await wrong.balanceOf(order.address), 0n);
      } finally { await f.close(); }
    });

    await t.test('custom chains are supported but RPC and signed transaction chain binding remain enforced', async () => {
      const f = await fixture();
      try {
        const order = await f.create(); await pay(order, '1');
        const chain = f.app.merchant.chain, config = { ...chain.config };
        // Changed IDs are checked against the actual local RPC; remote URLs are policy-only reads.
        try {
          for (const id of [1, 56, 137, 10, 42161, 97, 11155111, 43210]) {
            chain.config = { ...config, chainId: id };
            assert.equal(new WalletCollection(f.app.merchant).chain(), chain);
            assert.equal((await f.prepare([order], {}, 409)).error, 'CHAIN_ID_MISMATCH');
          }
          chain.config = { ...config, rpcUrl: 'https://not-loopback.invalid/' };
          assert.equal(new WalletCollection(f.app.merchant).chain(), chain);
          for (const id of [97, 11155111]) {
            chain.config = { ...config, chainId: id };
            assert.equal(new WalletCollection(f.app.merchant).chain(), chain);
          }
        } finally { chain.config = config; }
        const p = await f.prepare([order]); const begun = await f.action(p.job, 'begin');
        const sent = await send(begun.transaction), tx = await provider.getTransaction(sent.hash);
        const intent = f.app.store.job(p.job.id);
        assert.equal(f.app.merchant.matchesTransaction(intent, tx), true);
        // Other-chain signed transactions cannot be broadcast to this EVM; test the exact production matcher.
        assert.equal(f.app.merchant.matchesTransaction(intent, { ...tx, chainId: 1n }), false);
        assert.equal((await f.action(p.job, 'attach', { transactionHash: sent.hash })).state, 'MINED');
      } finally { await f.close(); }
    });
  } finally {
    for (const f of fixtures) { if (f.app) await f.app.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
    provider.destroy(); await local.server.close();
  }
});
