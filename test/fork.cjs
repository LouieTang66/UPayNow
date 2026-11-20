'use strict';
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { readOnlyForkRpc } = require('./fork-rpc.cjs');

const TARGETS = {
  ethereum: {
    chainId: 1n, confirmations: 64, rpc: 'https://ethereum-rpc.publicnode.com',
    tokens: [
      { symbol: 'USDT', address: '0xdac17f958d2ee523a2206206994597c13d831ec7', decimals: 6,
        holder: '0xf977814e90da44bfa03b6295a0616a897441acec', controls: 'tether',
        identity: 'Tether USD on Ethereum', source: 'https://tether.to/en/supported-protocols/' },
      { symbol: 'USDC', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6,
        holder: '0xf977814e90da44bfa03b6295a0616a897441acec', controls: 'circle',
        identity: 'Circle-issued USDC on Ethereum', source: 'https://developers.circle.com/stablecoins/usdc-contract-addresses' },
    ],
  },
  bsc: {
    chainId: 56n, confirmations: 128, rpc: 'https://bsc-rpc.publicnode.com',
    tokens: [
      { symbol: 'USDT', address: '0x55d398326f99059ff775485246999027b3197955', decimals: 18,
        holder: '0xf977814e90da44bfa03b6295a0616a897441acec', controls: null,
        identity: 'Binance-Peg BSC-USD (USDT); not native Tether-issued Ethereum USDT',
        source: 'https://www.binance.com/en/collateral-btokens' },
    ],
  },
};
const ABI = [
  'function name() view returns (string)', 'function symbol() view returns (string)',
  'function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
  'function owner() view returns (address)', 'function paused() view returns (bool)',
  'function pause()', 'function unpause()',
  'function isBlackListed(address) view returns (bool)', 'function addBlackList(address)', 'function removeBlackList(address)',
  'function basisPointsRate() view returns (uint256)', 'function maximumFee() view returns (uint256)',
  'function setParams(uint256,uint256)',
  'function blacklister() view returns (address)', 'function pauser() view returns (address)',
  'function isBlacklisted(address) view returns (bool)', 'function blacklist(address)', 'function unBlacklist(address)',
];

async function main() {
  const name = process.argv[2];
  const target = TARGETS[name];
  assert.ok(target, 'Choose ethereum or bsc');
  const prefix = `UPAY_${name.toUpperCase()}`;
  const upstream = await readOnlyForkRpc(process.env[`${prefix}_RPC_URL`] || target.rpc);
  let provider;
  let rpc;
  try {
    assert.equal(BigInt(await upstream.read('eth_chainId')), target.chainId, 'Wrong public chain');
    const head = Number(BigInt(await upstream.read('eth_blockNumber')));
    const block = process.env[`${prefix}_FORK_BLOCK`] ? Number(process.env[`${prefix}_FORK_BLOCK`]) : head - target.confirmations;
    assert.ok(Number.isSafeInteger(block) && block > 0 && block <= head);
    const blockTag = ethers.toQuantity(block);
    const remoteBlock = await upstream.read('eth_getBlockByNumber', [blockTag, false]);
    assert.ok(remoteBlock?.hash, 'Pinned source block unavailable');
    console.log(`FORK ${JSON.stringify({ sourceChainId: target.chainId.toString(), rpc: upstream.label, block, blockHash: remoteBlock.hash, sourceTimestamp: Number(BigInt(remoteBlock.timestamp)) })}`);

    // This process is a local in-memory VM only. Never use --network <public>.
    const hre = require('hardhat');
    assert.equal(hre.network.name, 'hardhat');
    for (const config of [hre.config.networks.hardhat, hre.network.config]) {
      config.hardfork = 'cancun';
      config.throwOnTransactionFailures = false;
      if (!config.chains.has(Number(target.chainId))) {
        // Simulation rule at this one pinned block, NOT a claim about the
        // source chain's historical activation schedule or consensus rules.
        config.chains.set(Number(target.chainId), {
          hardforkHistory: new Map([['cancun', block]]),
        });
      }
    }
    rpc = hre.network.provider;
    assert.equal(await rpc.send('eth_chainId'), '0x7a69');
    await rpc.send('hardhat_reset', [{ forking: { jsonRpcUrl: upstream.url, blockNumber: block } }]);
    assert.equal(await rpc.send('eth_chainId'), '0x7a69', 'All signing must remain on chain 31337');
    const localFork = await rpc.send('hardhat_metadata');
    assert.equal(BigInt(localFork.forkedNetwork.chainId), target.chainId);
    assert.equal(Number(localFork.forkedNetwork.forkBlockNumber), block);
    assert.equal(localFork.forkedNetwork.forkBlockHash.toLowerCase(), remoteBlock.hash.toLowerCase());
    provider = new ethers.BrowserProvider(rpc, undefined, { cacheTimeout: -1 });
    provider.pollingInterval = 10;
    const deployer = await provider.getSigner(0);
    const merchant = await provider.getSigner(1);
    const stranger = await provider.getSigner(2);
    const payout = await merchant.getAddress();
    const strangerAddress = await stranger.getAddress();
    const fa = await hre.artifacts.readArtifact('src/ForwarderFactory.sol:ForwarderFactory');
    const factoryInterface = new ethers.Interface(fa.abi);
    const erc20Interface = new ethers.Interface(ABI);
    let count = 0;
    let nextOrder = 0;
    async function impersonate(address) {
      assert.equal(await rpc.send('eth_chainId'), '0x7a69');
      await rpc.send('hardhat_impersonateAccount', [address]);
      await rpc.send('hardhat_setBalance', [address, ethers.toQuantity(ethers.parseEther('100'))]);
      // Impersonated accounts are unlocked locally but are not included in
      // eth_accounts; BrowserProvider.getSigner would request browser access.
      return new ethers.JsonRpcSigner(provider, ethers.getAddress(address));
    }
    const tx = async pending => {
      const receipt = await (await pending).wait();
      assert.equal(receipt.status, 1);
      return receipt;
    };
    function parsed(receipt, address, iface, eventName) {
      return receipt.logs.filter(l => l.address.toLowerCase() === address.toLowerCase())
        .map(l => { try { return iface.parseLog(l); } catch { return null; } })
        .filter(e => e?.name === eventName);
    }
    async function test(symbol, title, fn) {
      const snapshot = await rpc.send('evm_snapshot');
      try { await fn(); console.log(`PASS fork ${name} ${symbol} ${++count}: ${title}`); }
      finally { assert.equal(await rpc.send('evm_revert', [snapshot]), true); }
    }
    // A single immutable CA set serves every order; the selected collection CA
    // never participates in address prediction. Per-test snapshots restore this baseline.
    const settlementTokens = target.tokens.map(spec => ethers.getAddress(spec.address));
    const factory = await new ethers.ContractFactory(fa.abi, fa.bytecode, deployer).deploy(payout, settlementTokens);
    await factory.waitForDeployment();
    assert.equal(await factory.payout(), payout);
    assert.equal(await factory.SALT_VERSION(), 3n);
    assert.deepEqual(Array.from(await factory.getSettlementTokens()), settlementTokens);
    for (const address of settlementTokens) assert.equal(await factory.isSupportedToken(address), true);
    // Empty revert bytes are valid EVM revert data (e.g. an absent selector).
    // Network/transport failures, or CALL_EXCEPTION without revert bytes, must fail the test.
    function isEvmRevert(error) {
      return error?.code === 'CALL_EXCEPTION' && typeof error.data === 'string'
        && /^0x(?:[0-9a-fA-F]{2})*$/.test(error.data);
    }
    const finalSourceBalances = [];
    for (const spec of target.tokens) {
      const address = ethers.getAddress(spec.address);
      const holder = ethers.getAddress(process.env[`${prefix}_${spec.symbol}_HOLDER`] || spec.holder);
      const publicCode = await upstream.read('eth_getCode', [address, blockTag]);
      assert.notEqual(publicCode, '0x');
      const sourceBalanceRaw = await upstream.read('eth_call', [
        { to: address, data: erc20Interface.encodeFunctionData('balanceOf', [holder]) }, blockTag,
      ]);
      finalSourceBalances.push({ address, holder, sourceBalanceRaw });
      const donor = await impersonate(holder);
      const token = new ethers.Contract(address, ABI, donor);
      const unit = 10n ** BigInt(spec.decimals);
      assert.equal(await token.symbol(), spec.symbol);
      assert.equal(Number(await token.decimals()), spec.decimals);
      assert.equal(await token.balanceOf(holder), BigInt(sourceBalanceRaw));
      assert.ok(BigInt(sourceBalanceRaw) >= 100n * unit, 'Select a source holder covering the largest isolated case (100 tokens)');
      assert.equal(ethers.keccak256(await provider.getCode(address)), ethers.keccak256(publicCode));
      const metadata = {
        token: spec.symbol, ca: address, identity: spec.identity, source: spec.source,
        decimals: spec.decimals, holder, sourceBalance: BigInt(sourceBalanceRaw).toString(),
        tokenCodeHash: ethers.keccak256(publicCode),
      };
      if (spec.controls) {
        metadata.paused = await token.paused();
        assert.equal(metadata.paused, false);
      }
      if (spec.controls === 'tether') {
        metadata.holderBlacklisted = await token.isBlackListed(holder);
        assert.equal(metadata.holderBlacklisted, false, 'Choose an unblocked source holder; do not modify issuer state to fund baseline tests');
        metadata.owner = await token.owner();
        metadata.basisPointsRate = (await token.basisPointsRate()).toString();
        metadata.maximumFee = (await token.maximumFee()).toString();
        assert.equal(metadata.basisPointsRate, '0');
        assert.equal(metadata.maximumFee, '0');
      }
      if (spec.controls === 'circle') {
        metadata.holderBlacklisted = await token.isBlacklisted(holder);
        assert.equal(metadata.holderBlacklisted, false, 'Choose an unblocked source holder');
        metadata.blacklister = await token.blacklister();
        metadata.pauser = await token.pauser();
        const slot = ethers.id('org.zeppelinos.proxy.implementation');
        const value = await upstream.read('eth_getStorageAt', [address, slot, blockTag]);
        const implementation = ethers.getAddress(`0x${value.slice(-40)}`);
        const code = await upstream.read('eth_getCode', [implementation, blockTag]);
        assert.notEqual(code, '0x');
        metadata.implementation = implementation;
        metadata.implementationCodeHash = ethers.keccak256(code);
      }
      console.log(`TOKEN ${JSON.stringify(metadata)}`);
      const makeOrder = async (amount = 0n) => {
        const hash = ethers.id(`fork-${name}-${spec.symbol}-${++nextOrder}`);
        const predicted = await factory.predictAddress(hash);
        assert.equal(await provider.getCode(predicted), '0x');
        if (amount) await tx(token.transfer(predicted, amount));
        return { hash, address: predicted };
      };
      async function assertSettled(order, amount, action) {
        const before = await token.balanceOf(payout);
        const receipt = await tx(action());
        assert.equal((await token.balanceOf(payout)) - before, amount);
        assert.equal(await token.balanceOf(order.address), 0n);
        assert.equal(await token.balanceOf(factory.target), 0n);
        const collected = parsed(receipt, factory.target, factoryInterface, 'Collected');
        assert.equal(collected.length, 1);
        assert.equal(collected[0].args.orderIdHash, order.hash);
        assert.equal(collected[0].args.forwarder, order.address);
        assert.equal(collected[0].args.token, address);
        assert.equal(collected[0].args.amount, amount);
        const transfers = parsed(receipt, address, erc20Interface, 'Transfer');
        assert.ok(transfers.some(e => e.args.from === order.address && e.args.to === payout && e.args.value === amount));
        assert.equal(transfers.some(e => e.args.from === factory.target || e.args.to === factory.target), false);
        return receipt;
      }
      async function assertFailed(order) {
        const amount = await token.balanceOf(order.address);
        const before = await token.balanceOf(payout);
        const sent = await factory.connect(stranger).collect(order.hash, address, { gasLimit: 1_000_000n });
        const receipt = await provider.send('eth_getTransactionReceipt', [sent.hash]);
        assert.equal(BigInt(receipt.status), 0n, 'Real transfer must fail on-chain in local fork');
        assert.equal(await token.balanceOf(order.address), amount);
        assert.equal(await token.balanceOf(payout), before);
        assert.equal(await provider.getCode(order.address), '0x');
        assert.equal(await factory.isForwarder(order.address), false);
      }
      await test(spec.symbol, 'counterfactual prefunding; stranger collects order -> fixed payout directly', async () => {
        const amount = ethers.parseUnits('12.345', spec.decimals);
        const order = await makeOrder(amount);
        const strangerBefore = await token.balanceOf(strangerAddress);
        await assertSettled(order, amount, () => factory.connect(stranger).collect(order.hash, address));
        assert.equal(await token.balanceOf(strangerAddress), strangerBefore);
      });
      await test(spec.symbol, 'predeployed clone accumulates multiple real transfers and sweeps total', async () => {
        const order = await makeOrder();
        await tx(factory.connect(stranger).deploy(order.hash));
        await tx(token.transfer(order.address, 7n * unit));
        await tx(token.transfer(order.address, 3n * unit));
        await assertSettled(order, 10n * unit, () => factory.collect(order.hash, address));
      });
      await test(spec.symbol, 'real-token batch incl. duplicate IDs; exact counts, events, receipts and zero residue', async () => {
        const amounts = [2n * unit, 3n * unit, 5n * unit];
        const orders = [];
        for (const amount of amounts) orders.push(await makeOrder(amount));
        const ids = [orders[0].hash, orders[1].hash, orders[0].hash, orders[2].hash]
          .map(orderIdHash => ({ orderIdHash, token: address }));
        const before = await token.balanceOf(payout);
        assert.deepEqual(Array.from(await factory.collectBatch.staticCall(ids, { gasLimit: 3_000_000n })), [4n, 0n]);
        const receipt = await tx(factory.connect(stranger).collectBatch(ids, { gasLimit: 3_000_000n }));
        assert.equal((await token.balanceOf(payout)) - before, 10n * unit);
        const collected = parsed(receipt, factory.target, factoryInterface, 'Collected');
        assert.deepEqual(collected.map(e => [e.args.orderIdHash, e.args.forwarder, e.args.token, e.args.amount]),
          orders.map((order, i) => [order.hash, order.address, address, amounts[i]]));
        assert.equal(parsed(receipt, factory.target, factoryInterface, 'CollectFailed').length, 0);
        for (const order of orders) assert.equal(await token.balanceOf(order.address), 0n);
        assert.equal(await token.balanceOf(factory.target), 0n);
      });
      await test(spec.symbol, 'empty/repeated sweep emits no payment; late payment remains collectable', async () => {
        const order = await makeOrder();
        let receipt = await tx(factory.collect(order.hash, address));
        assert.equal(parsed(receipt, factory.target, factoryInterface, 'Collected').length, 0);
        await tx(token.transfer(order.address, unit));
        await assertSettled(order, unit, () => factory.collect(order.hash, address));
        receipt = await tx(factory.collect(order.hash, address));
        assert.equal(parsed(receipt, factory.target, factoryInterface, 'Collected').length, 0);
        assert.equal(parsed(receipt, address, erc20Interface, 'Transfer').length, 0);
      });
      if (spec.controls) {
        const role = spec.controls === 'tether' ? await token.owner() : await token.blacklister();
        const admin = token.connect(await impersonate(role));
        const setBlocked = (account, blocked) => spec.controls === 'tether'
          ? (blocked ? admin.addBlackList(account) : admin.removeBlackList(account))
          : (blocked ? admin.blacklist(account) : admin.unBlacklist(account));
        const isBlocked = account => spec.controls === 'tether' ? token.isBlackListed(account) : token.isBlacklisted(account);
        await test(spec.symbol, 'real issuer sender blacklist rolls back deployment; unblocking permits retry', async () => {
          const order = await makeOrder(10n * unit);
          await tx(setBlocked(order.address, true));
          assert.equal(await isBlocked(order.address), true);
          await assertFailed(order);
          await tx(setBlocked(order.address, false));
          await assertSettled(order, 10n * unit, () => factory.collect(order.hash, address));
        });
        await test(spec.symbol, 'real blacklist isolates middle batch item; healthy siblings settle; failed item retries', async () => {
          const orders = [];
          for (let i = 0; i < 3; i++) orders.push(await makeOrder(10n * unit));
          await tx(setBlocked(orders[1].address, true));
          const ids = orders.map(o => ({ orderIdHash: o.hash, token: address }));
          assert.deepEqual(Array.from(await factory.collectBatch.staticCall(ids, { gasLimit: 3_000_000n })), [2n, 1n]);
          const before = await token.balanceOf(payout);
          const receipt = await tx(factory.collectBatch(ids, { gasLimit: 3_000_000n }));
          assert.equal((await token.balanceOf(payout)) - before, 20n * unit);
          assert.equal(parsed(receipt, factory.target, factoryInterface, 'Collected').length, 2);
          const failures = parsed(receipt, factory.target, factoryInterface, 'CollectFailed');
          assert.equal(failures.length, 1);
          assert.equal(failures[0].args.orderIdHash, orders[1].hash);
          assert.equal(failures[0].args.forwarder, orders[1].address);
          assert.equal(failures[0].args.token, address);
          assert.equal(await token.balanceOf(orders[0].address), 0n);
          assert.equal(await token.balanceOf(orders[2].address), 0n);
          assert.equal(await token.balanceOf(orders[1].address), 10n * unit);
          assert.equal(await provider.getCode(orders[1].address), '0x');
          assert.equal(await factory.isForwarder(orders[1].address), false);
          await tx(setBlocked(orders[1].address, false));
          await assertSettled(orders[1], 10n * unit, () => factory.collect(orders[1].hash, address));
        });
        await test(spec.symbol, 'real issuer pause preserves order balance; unpause permits retry', async () => {
          const order = await makeOrder(10n * unit);
          const pauser = await impersonate(spec.controls === 'tether' ? await token.owner() : await token.pauser());
          const controlled = token.connect(pauser);
          await tx(controlled.pause());
          assert.equal(await token.paused(), true);
          await assertFailed(order);
          await tx(controlled.unpause());
          assert.equal(await token.paused(), false);
          await assertSettled(order, 10n * unit, () => factory.collect(order.hash, address));
        });
        await test(spec.symbol, spec.controls === 'circle'
          ? 'USDC blocked payout prevents receipt; unblocking permits retry'
          : 'legacy USDT blocked payout can receive but cannot spend: document recipient-blacklist semantics', async () => {
          const order = await makeOrder(10n * unit);
          await tx(setBlocked(payout, true));
          assert.equal(await isBlocked(payout), true);
          if (spec.controls === 'circle') {
            await assertFailed(order);
            await tx(setBlocked(payout, false));
            await assertSettled(order, 10n * unit, () => factory.collect(order.hash, address));
          } else {
            await assertSettled(order, 10n * unit, () => factory.collect(order.hash, address));
            await assert.rejects(token.connect(merchant).transfer.staticCall(holder, unit), isEvmRevert);
          }
        });
        if (spec.controls === 'tether') {
          await test(spec.symbol, 'real legacy USDT transfer returns no bytes; SafeERC20 collection succeeds', async () => {
            const order = await makeOrder(unit);
            const raw = await provider.call({
              from: holder, to: address,
              data: erc20Interface.encodeFunctionData('transfer', [order.address, unit]),
            });
            assert.equal(raw, '0x', 'This real USDT transfer has no bool return value');
            assert.equal(await token.balanceOf(order.address), unit, 'eth_call must not persist its simulated transfer');
            await assertSettled(order, unit, () => factory.collect(order.hash, address));
          });
          await test(spec.symbol, 'real USDT fee switch demonstrates unsupported taxed-token/net-receipt boundary', async () => {
            const amount = 100n * unit;
            const order = await makeOrder(amount);
            await tx(admin.setParams(10n, 1n));
            assert.equal(await token.basisPointsRate(), 10n);
            assert.equal(await token.maximumFee(), unit);
            const before = await token.balanceOf(payout);
            const receipt = await tx(factory.collect(order.hash, address));
            const expectedFee = amount * 10n / 10_000n;
            assert.equal((await token.balanceOf(payout)) - before, amount - expectedFee);
            assert.equal(await token.balanceOf(order.address), 0n);
            assert.equal(parsed(receipt, factory.target, factoryInterface, 'Collected')[0].args.amount, amount);
          });
        }
      } else {
        // This BEP-20 wrapper has no issuer pause/blacklist API. Do not substitute
        // a mock or manufacture storage to claim those scenarios were tested.
        for (const getter of ['paused', 'isBlackListed', 'isBlacklisted']) {
          const data = erc20Interface.encodeFunctionData(getter, getter === 'paused' ? [] : [payout]);
          await assert.rejects(provider.call({ to: address, data }), isEvmRevert);
        }
        console.log('CAPABILITY BSC Binance-Peg USDT: pause/blacklist getters unavailable; no mock replacement or token storage/code edits');
      }
    }
    if (name === 'ethereum') {
      // These cases prove token custody/transfer capabilities only. Coexisting
      // assets are NOT an invoice mixed-payment policy or a pricing/conversion rule.
      const handles = [];
      for (const spec of target.tokens) {
        const address = ethers.getAddress(spec.address);
        const holder = ethers.getAddress(process.env[`${prefix}_${spec.symbol}_HOLDER`] || spec.holder);
        const token = new ethers.Contract(address, ABI, await impersonate(holder));
        handles.push({ spec, address, token, amount: 7n * 10n ** BigInt(spec.decimals) });
      }
      assert.deepEqual(handles.map(h => h.spec.symbol), ['USDT', 'USDC']);
      const [usdt, usdc] = handles;
      async function fundBoth() {
        const hash = ethers.id(`fork-${name}-two-ca-${++nextOrder}`);
        const address = await factory.predictAddress(hash);
        assert.equal(await provider.getCode(address), '0x');
        for (const h of handles) await tx(h.token.transfer(address, h.amount));
        assert.equal(await factory.predictAddress(hash), address);
        for (const h of handles) assert.equal(await h.token.balanceOf(address), h.amount);
        return { hash, address };
      }
      const eventItems = (receipt, eventName) => parsed(receipt, factory.target, factoryInterface, eventName)
        .map(e => [e.args.orderIdHash, e.args.forwarder, e.args.token, ...(eventName === 'Collected' ? [e.args.amount] : [])]);
      const request = (order, h) => ({ orderIdHash: order.hash, token: h.address });
      async function assertNoFactoryResidue() {
        for (const h of handles) assert.equal(await h.token.balanceOf(factory.target), 0n);
      }
      await test('USDT+USDC', 'same Factory/address holds both CAs; either sweep order moves only selected CA', async () => {
        for (const sequence of [[usdt, usdc], [usdc, usdt]]) {
          const order = await fundBoth();
          const before = await Promise.all(handles.map(h => h.token.balanceOf(payout)));
          // Neither supported CA may be routed through the wrong-token escape hatch.
          for (const h of handles) {
            await assert.rejects(factory.collectWrongToken.staticCall(order.hash, h.address), isEvmRevert);
            assert.equal(await h.token.balanceOf(order.address), h.amount);
          }
          const swept = new Set();
          for (const h of sequence) {
            assert.equal(await factory.collect.staticCall(order.hash, h.address), h.amount);
            const receipt = await tx(factory.connect(stranger).collect(order.hash, h.address));
            swept.add(h.address);
            assert.deepEqual(eventItems(receipt, 'Collected'), [[order.hash, order.address, h.address, h.amount]]);
            assert.deepEqual(eventItems(receipt, 'CollectFailed'), []);
            for (const [i, other] of handles.entries()) {
              assert.equal(await other.token.balanceOf(order.address), swept.has(other.address) ? 0n : other.amount);
              assert.equal(await other.token.balanceOf(payout), before[i] + (swept.has(other.address) ? other.amount : 0n));
              const transfers = parsed(receipt, other.address, erc20Interface, 'Transfer');
              if (other === h) {
                assert.ok(transfers.some(e => e.args.from === order.address && e.args.to === payout && e.args.value === h.amount));
              } else assert.equal(transfers.length, 0, 'Unselected token must not be touched');
            }
            assert.equal(await factory.predictAddress(order.hash), order.address);
            assert.equal(await factory.isForwarder(order.address), true);
            await assertNoFactoryResidue();
          }
        }
      });
      await test('USDT+USDC', 'same-order mixed-CA batch isolates unsupported CA and counts duplicate zero-balance items', async () => {
        const order = await fundBoth();
        assert.equal(await factory.isSupportedToken(strangerAddress), false);
        const requests = [request(order, usdt), { orderIdHash: order.hash, token: strangerAddress },
          request(order, usdc), request(order, usdt), request(order, usdc)];
        const before = await Promise.all(handles.map(h => h.token.balanceOf(payout)));
        assert.deepEqual(Array.from(await factory.collectBatch.staticCall(requests, { gasLimit: 4_000_000n })), [4n, 1n]);
        const receipt = await tx(factory.connect(stranger).collectBatch(requests, { gasLimit: 4_000_000n }));
        assert.deepEqual(eventItems(receipt, 'Collected'), handles.map(h => [order.hash, order.address, h.address, h.amount]));
        assert.deepEqual(eventItems(receipt, 'CollectFailed'), [[order.hash, order.address, strangerAddress]]);
        for (const [i, h] of handles.entries()) {
          assert.equal(await h.token.balanceOf(order.address), 0n);
          assert.equal(await h.token.balanceOf(payout), before[i] + h.amount);
          const transfers = parsed(receipt, h.address, erc20Interface, 'Transfer');
          assert.equal(transfers.length, 1, 'Duplicate empty item emits neither payment nor token transfer');
          assert.equal(transfers[0].args.from, order.address);
          assert.equal(transfers[0].args.to, payout);
          assert.equal(transfers[0].args.value, h.amount);
        }
        await assertNoFactoryResidue();
      });
      await test('USDT+USDC', 'same-order USDT blacklist fails per CA while USDC settles; unblocked USDT retries at same address', async () => {
        const order = await fundBoth();
        const admin = usdt.token.connect(await impersonate(await usdt.token.owner()));
        await tx(admin.addBlackList(order.address));
        assert.equal(await usdt.token.isBlackListed(order.address), true);
        const requests = [request(order, usdt), request(order, usdc), request(order, usdt), request(order, usdc)];
        const before = await Promise.all(handles.map(h => h.token.balanceOf(payout)));
        assert.deepEqual(Array.from(await factory.collectBatch.staticCall(requests, { gasLimit: 4_000_000n })), [2n, 2n]);
        const receipt = await tx(factory.collectBatch(requests, { gasLimit: 4_000_000n }));
        assert.deepEqual(eventItems(receipt, 'Collected'), [[order.hash, order.address, usdc.address, usdc.amount]]);
        assert.deepEqual(eventItems(receipt, 'CollectFailed'), [
          [order.hash, order.address, usdt.address], [order.hash, order.address, usdt.address],
        ]);
        assert.equal(await factory.isForwarder(order.address), true, 'Successful sibling deploy survives failed token items');
        assert.equal(await usdt.token.balanceOf(order.address), usdt.amount);
        assert.equal(await usdc.token.balanceOf(order.address), 0n);
        assert.equal(await usdt.token.balanceOf(payout), before[0]);
        assert.equal(await usdc.token.balanceOf(payout), before[1] + usdc.amount);
        assert.equal(parsed(receipt, usdt.address, erc20Interface, 'Transfer').length, 0);
        await tx(admin.removeBlackList(order.address));
        assert.equal(await factory.collect.staticCall(order.hash, usdt.address), usdt.amount);
        const retry = await tx(factory.collect(order.hash, usdt.address));
        assert.deepEqual(eventItems(retry, 'Collected'), [[order.hash, order.address, usdt.address, usdt.amount]]);
        assert.equal(await usdt.token.balanceOf(order.address), 0n);
        assert.equal(await usdt.token.balanceOf(payout), before[0] + usdt.amount);
        assert.equal(await usdc.token.balanceOf(payout), before[1] + usdc.amount);
        assert.equal(parsed(retry, usdc.address, erc20Interface, 'Transfer').length, 0);
        assert.equal(await factory.predictAddress(order.hash), order.address);
        await assertNoFactoryResidue();
      });
    }
    // A pinned historical eth_call is immutable by definition: equality here
    // checks historical-read consistency, NOT evidence that public state was not written.
    // The read-only RPC method allowlist/proxy and local chain checks are the write boundary.
    for (const item of finalSourceBalances) {
      const after = await upstream.read('eth_call', [
        { to: item.address, data: erc20Interface.encodeFunctionData('balanceOf', [item.holder]) }, blockTag,
      ]);
      assert.equal(after, item.sourceBalanceRaw);
    }
    console.log(`HISTORICAL_READ_CONSISTENCY ${finalSourceBalances.length} pinned holder balances unchanged; not a public-write proof`);
    assert.deepEqual(upstream.stats.deniedMethods, []);
    assert.equal(Object.keys(upstream.stats.methods).some(m => /send|sign|personal|wallet/i.test(m)), false);
    console.log(`PUBLIC_RPC_READ_ONLY ${JSON.stringify(upstream.stats)}`);
    console.log(`${count}/${count} real-token fork groups passed on ${name}; block ${block} ${remoteBlock.hash}; all state changes local to chain 31337.`);
  } finally {
    provider?.destroy();
    await upstream.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
