'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const hre = require('hardhat');
const { ethers } = require('ethers');
const { Store } = require('../store.cjs');
const { localServer } = require('./fixtures/dev-chain.cjs');
const { deployLocal } = require('./fixtures/local-tools.cjs');
const { DeploymentService, inspectDeployment } = require('../deployment-service.cjs');
const { DeploymentHandoff } = require('../deployment-handoff.cjs');
const { historicalDeployment } = require('./fixtures/historical-deployment.cjs');
const networks = [1,97,31337].map(chainId => ({chainId,name:'Isolated '+chainId,nativeSymbol:'TEST_ETH',defaultRPC:'https://test.invalid'}));

test('deployment service: v2-only admission and historical legacy SQLite lifecycle', { timeout: 180000 }, async t => {
  const local = await localServer(0);
  const provider = new ethers.JsonRpcProvider(local.url, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upay-deployment-'));
  let store = new Store(dir);
  let service;
  let registrations = [];
  const register = async config => {
    registrations.push(config);
    return { id: 'deployment-' + config.factory.toLowerCase() };
  };
  try {
    assert.notEqual(new URL(local.url).port, '18545');
    assert.notEqual(new URL(local.url).port, '8797');
    const d = await deployLocal(provider);
    const wallet = await provider.getSigner(3), from = await wallet.getAddress();
    const input = { name: 'Local merchant chain', nativeSymbol: 'TEST_ETH', chainId: 31337, rpcUrl: local.url,
      payout: d.payout, tokens: [d.a.target, d.b.target], confirmations: 1 };
    service = new DeploymentService(store, { register, networks });
    const D = require('../deterministic.cjs');
    await hre.network.provider.send('hardhat_setCode', [D.SINGLETON, D.SINGLETON_RUNTIME]);
    await hre.network.provider.send('hardhat_setCode', [D.rootAddress(), require('../deployment-service.cjs').artifacts(['DeterministicDeployer']).DeterministicDeployer.deployedBytecode]);
    const send = async transaction => {
      const { gas, ...rest } = transaction;
      const sent = await wallet.sendTransaction({ ...rest, gasLimit: gas });
      await sent.wait(); return sent;
    };
    await t.test('new creation rejects legacy and request overrides without writes; omitted scheme defaults to v2', async () => {
      const before = JSON.stringify(service.list());
      for (const scheme of ['legacy-v1', null, '', false, 'LEGACY-V1', 'unknown']) {
        const request = { ...input, scheme, importMode: true, factory: d.factory.target, allowLegacy: true };
        await assert.rejects(service.create(request), { code: 'LEGACY_DEPLOYMENT_DISABLED' });
        await assert.rejects(service.preview(request), { code: 'LEGACY_DEPLOYMENT_DISABLED' });
      }
      assert.equal(JSON.stringify(service.list()), before);
      const current = await service.create(input);
      assert.equal(current.summary.scheme, 'deterministic-v2');
      assert.equal(service.record(current.id).to, D.rootAddress());
      await service.cancel(current.id, { rejected: true });
    });
    await t.test('strict input checks and readback of canonical existing deployment', async () => {
      for (const [override, code] of [
        [{ rpcUrl: 'http://127.0.0.1:1' }, 'RPC_HTTPS_REQUIRED'],
        [{ rpcUrl: 'https://user:pass@127.0.0.1:1' }, 'RPC_CREDENTIALS_NOT_ALLOWED'],
        [{ chainId: 1 }, 'CHAIN_ID_MISMATCH'],
        [{ chainId: 97 }, 'CHAIN_ID_MISMATCH'],
        [{ tokens: [d.a.target, d.a.target] }, 'DUPLICATE_TOKEN'],
        [{ tokens: [from] }, 'TOKEN_NOT_CONTRACT'],
        [{ payout: ethers.ZeroAddress }, 'INVALID_PAYOUT'],
        [{ payout: d.a.target }, 'INVALID_PAYOUT'],
        [{ confirmations: 0 }, 'INVALID_CONFIRMATIONS']
      ]) await assert.rejects(service.create({ ...input, scheme: 'deterministic-v2', ...override }), { code });
      const cfg = await inspectDeployment({ ...input, factory: d.factory.target });
      assert.equal(cfg.name, input.name); assert.equal(cfg.nativeSymbol, input.nativeSymbol);
      assert.deepEqual(cfg.tokens.map(x => x.decimals), [6, 18]);
      assert.deepEqual(cfg.tokens.map(x => x.symbol), ['TEST_USDT', 'TEST_USDC']);
      await assert.rejects(inspectDeployment({ ...input, factory: d.factory.target, tokens: [d.b.target, d.a.target] }), { code: 'TOKEN_REGISTRY_CHANGED' });
      await assert.rejects(inspectDeployment({ ...input, factory: d.factory.target, payout: from }), { code: 'FACTORY_IDENTITY_MISMATCH' });
      await assert.rejects(inspectDeployment({ ...input, factory: d.a.target }), { code: 'CONTRACT_RUNTIME_MISMATCH' });
    });
    await t.test('same-length runtime forgery and implementation/hub immutable tampering rejected', async () => {
      const factoryCode = await provider.getCode(d.factory.target);
      // Preserve length, change the very first opcode: length-only validators would accept it.
      await hre.network.provider.send('hardhat_setCode', [d.factory.target, '0x00' + factoryCode.slice(4)]);
      await assert.rejects(inspectDeployment({ ...input, factory: d.factory.target }), { code: 'CONTRACT_RUNTIME_MISMATCH' });
      await hre.network.provider.send('hardhat_setCode', [d.factory.target, factoryCode]);
      const impl = await d.factory.implementation(), code = await provider.getCode(impl);
      await hre.network.provider.send('hardhat_setCode', [impl, '0x00' + code.slice(4)]);
      await assert.rejects(inspectDeployment({ ...input, factory: d.factory.target }), { code: 'CONTRACT_RUNTIME_MISMATCH' });
      await hre.network.provider.send('hardhat_setCode', [impl, code]);
      const dbg = require('../../artifacts/src/ForwarderImpl.sol/ForwarderImpl.dbg.json');
      const build = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../artifacts/src/ForwarderImpl.sol', dbg.buildInfo)));
      const ast = build.output.sources['src/ForwarderImpl.sol'].ast;
      const contract = ast.nodes.find(n => n.nodeType === 'ContractDefinition' && n.name === 'ForwarderImpl');
      const hubId = contract.nodes.find(n => n.nodeType === 'VariableDeclaration' && n.name === 'hub').id;
      const refs = build.output.contracts['src/ForwarderImpl.sol'].ForwarderImpl.evm.deployedBytecode.immutableReferences[hubId];
      const forged = Buffer.from(code.slice(2), 'hex');
      for (const ref of refs) Buffer.from(ethers.zeroPadValue(from, ref.length).slice(2), 'hex').copy(forged, ref.start);
      await hre.network.provider.send('hardhat_setCode', [impl, '0x' + forged.toString('hex')]);
      await assert.rejects(inspectDeployment({ ...input, factory: d.factory.target }), { code: 'IMPLEMENTATION_IDENTITY_MISMATCH' });
      await hre.network.provider.send('hardhat_setCode', [impl, code]);
      // Change only an internal hub occurrence, retaining the authentic getter value.
      const partial = Buffer.from(code.slice(2), 'hex');
      Buffer.from(ethers.zeroPadValue(from, refs[refs.length - 1].length).slice(2), 'hex').copy(partial, refs[refs.length - 1].start);
      await hre.network.provider.send('hardhat_setCode', [impl, '0x' + partial.toString('hex')]);
      await assert.rejects(inspectDeployment({ ...input, factory: d.factory.target }), error => ['IMPLEMENTATION_IDENTITY_MISMATCH', 'IMMUTABLE_VALUE_MISMATCH'].includes(error.code));
      await hre.network.provider.send('hardhat_setCode', [impl, code]);
    });
    await t.test('READY is read-only; begin durable UNKNOWN, no nonce/to, lock prevents duplicate sends', async () => {
      const ready = await historicalDeployment(service, input);
      assert.equal(ready.state, 'READY'); assert.equal(ready.data, undefined);
      assert.equal(JSON.stringify(service.list()).includes(service.record(ready.id).data), false);
      assert.equal(store.jobs().length, 0);
      await assert.rejects(service.begin(ready.id, { from, data: '0x' }), { code: 'INVALID_TRANSACTION_FIELDS' });
      const promise = service.begin(ready.id, { from });
      await assert.rejects(service.begin(ready.id, { from }), { code: 'DEPLOYMENT_BUSY' });
      const begun = await promise;
      assert.equal(store.get('deployment-service.jobs.v1').find(j => j.id === ready.id).state, 'UNKNOWN');
      assert.equal(begun.transaction.to, undefined); assert.equal(begun.transaction.nonce, undefined);
      assert.equal(begun.transaction.value, '0x0');
      await assert.rejects(service.begin(ready.id, { from }), { code: 'DEPLOYMENT_NOT_READY' });
      const sent = await send(begun.transaction);
      const pending = service.attach(ready.id, { transactionHash: sent.hash });
      await assert.rejects(service.attach(ready.id, { transactionHash: sent.hash }), { code: 'DEPLOYMENT_BUSY' });
      const result = await pending;
      assert.equal(result.state, 'MINED'); assert.equal(result.outcome, 'SUCCESS');
      assert.equal(registrations.length, 1);
      assert.equal(registrations[0].factory, result.factory);
      assert.equal(registrations[0].name, input.name);
      assert.equal(registrations[0].startBlock, (await sent.wait()).blockNumber);
      await service.attach(ready.id, { transactionHash: sent.hash });
      assert.equal(registrations.length, 1);
      const other = await historicalDeployment(service, input); await service.begin(other.id, { from });
      await assert.rejects(service.attach(other.id, { transactionHash: sent.hash }), { code: 'TRANSACTION_HASH_IN_USE' });
    });
    await t.test('unknown hash persists over restart; candidate is saved before chain validation', async () => {
      const job = await historicalDeployment(service, input); await service.begin(job.id, { from });
      const hash = '0x' + 'ab'.repeat(32);
      assert.equal((await service.attach(job.id, { transactionHash: hash })).state, 'UNKNOWN');
      store.close(); store = new Store(dir); service = new DeploymentService(store, { register, networks });
      assert.equal((await service.get(job.id)).candidateHash, hash);
      await assert.rejects(service.begin(job.id, { from }), { code: 'DEPLOYMENT_NOT_READY' });
      await assert.rejects(service.cancel(job.id, { rejected: true }), { code: 'DEPLOYMENT_NOT_CANCELLABLE' });
      const bad = await historicalDeployment(service, input); await service.begin(bad.id, { from });
      const transfer = await wallet.sendTransaction({ to: d.payout, value: 0n }); await transfer.wait();
      await assert.rejects(service.attach(bad.id, { transactionHash: transfer.hash }), { code: 'DEPLOYMENT_TRANSACTION_MISMATCH' });
      assert.equal(service.record(bad.id).candidateHash, transfer.hash);
      assert.equal(service.record(bad.id).state, 'UNKNOWN');
    });
    await t.test('explicit rejection preserves late original hash recovery; READY cancellation retained', async () => {
      const ready = await historicalDeployment(service, input);
      await assert.rejects(service.cancel(ready.id, {}), { code: 'EXPLICIT_REJECTION_REQUIRED' });
      assert.equal((await service.cancel(ready.id, { rejected: true })).state, 'CANCELLED');
      assert.ok(service.record(ready.id));
      const late = await historicalDeployment(service, input), begun = await service.begin(late.id, { from });
      assert.equal((await service.refresh(late.id)).state, 'UNKNOWN');
      await service.cancel(late.id, { rejected: true });
      const sent = await send(begun.transaction);
      assert.equal((await service.attach(late.id, { transactionHash: sent.hash })).outcome, 'SUCCESS');
    });
    await t.test('mined reverted creation is FAILED, never registered as success', async () => {
      const job = await historicalDeployment(service, input), begun = await service.begin(job.id, { from });
      const { gas, ...transaction } = begun.transaction;
      let hash;
      try { const sent = await wallet.sendTransaction({ ...transaction, gasLimit: 220000n }); hash = sent.hash; try { await sent.wait(); } catch {} }
      catch (error) { hash = error.error?.data?.txHash; if (!hash) throw error; }
      const receipt = await provider.getTransactionReceipt(hash);
      assert.equal(receipt.status, 0);
      const count = registrations.length;
      const result = await service.attach(job.id, { transactionHash: hash });
      assert.equal(result.state, 'MINED'); assert.equal(result.outcome, 'FAILED');
      assert.equal(registrations.length, count);
    });
    await t.test('registration failure remains recoverable UNKNOWN and never reports success', async () => {
      const job = await historicalDeployment(service, input), begun = await service.begin(job.id, { from });
      const sent = await send(begun.transaction);
      const failing = new DeploymentService(store, { register: async () => { throw new Error('REGISTER_UNAVAILABLE'); } });
      const result = await failing.attach(job.id, { transactionHash: sent.hash });
      assert.equal(result.state, 'UNKNOWN'); assert.notEqual(result.outcome, 'SUCCESS');
      assert.equal((await service.refresh(job.id)).outcome, 'SUCCESS');
    });
    await t.test('phone retry preserves task/deadline, isolates rejection revisions, accepts late original hash after restart', async () => {
      let phone = new DeploymentHandoff(service, store, { origin: 'https://retry.example.test' }); await phone.listen(0);
      try {
        const job = await historicalDeployment(service, input), link = await phone.create(job.id), token = new URL(link.url).hash.slice(1);
        const request = async (action, body = {}, auth = token, origin = phone.origin) => {
          const res = await fetch(phone.localOrigin+'/api/deploy/'+job.id+'/'+action, { method:'POST', headers:{ Authorization:'Bearer '+auth, Origin:origin, 'Content-Type':'application/json' }, body:JSON.stringify(body) });
          return {status:res.status, body:await res.json()};
        };
        const nonce = await wallet.getNonce('pending'), count = service.list().length;
        assert.equal((await request('retry',{},'wrong')).status,401);
        assert.equal((await request('retry',{},token,'https://wrong.example')).status,403);
        assert.equal((await request('retry',{from})).status,403);
        const first = await request('begin',{from}); assert.equal(first.status,200);
        const originalBlock=service.record(job.id).startBlock;
        const retried=await request('retry'); assert.equal(retried.status,200); assert.equal(retried.body.job.walletRequestRevision,1);
        for(const k of ['from','to','data','value','chainId']) assert.equal(retried.body.transaction[k],first.body.transaction[k]);
        assert.equal(retried.body.expiresAt,link.expiresAt); assert.equal(service.record(job.id).startBlock,originalBlock);
        assert.equal(service.list().length,count); assert.equal(await wallet.getNonce('pending'),nonce);
        assert.equal((await request('reject',{requestRevision:0})).body.error,'STALE_WALLET_REQUEST');
        assert.equal((await request('attach',{transactionHash:ethers.id('future'),requestRevision:2})).status,400);
        assert.equal((await request('reject',{requestRevision:1})).body.state,'CANCELLED');
        assert.equal((await request('retry')).body.job.walletRequestRevision,2);
        await phone.close(); store.close(); store=new Store(dir); service=new DeploymentService(store,{register,networks});
        phone=new DeploymentHandoff(service,store,{origin:'https://retry.example.test'}); await phone.listen(0);
        assert.equal(service.record(job.id).walletRequestRevision,2);
        assert.equal(phone.store.handoff(job.id).expiresAt,link.expiresAt);
        const sent=await send(first.body.transaction);
        const attached=await request('attach',{transactionHash:sent.hash,requestRevision:0});
        assert.equal(attached.status,200); assert.equal(attached.body.outcome,'SUCCESS');
        const blocked=await request('retry'); assert.equal(blocked.status,200); assert.equal(blocked.body.transaction,null);
        assert.equal((await request('reject',{requestRevision:1})).body.error,'STALE_WALLET_REQUEST');
        assert.equal(service.record(job.id).state,'MINED');
      } finally {await phone.close();}
    });
    await t.test('phone retry rechecks original expiry after slow RPC and never extends or advances expired intent', async () => {
      const phone=new DeploymentHandoff(service,store,{origin:'https://expiry.example.test'}); await phone.listen(0);
      const original=service.walletTransaction;
      try {
        const job=await historicalDeployment(service, input),link=await phone.create(job.id),token=new URL(link.url).hash.slice(1);
        const request=async action=>{const r=await fetch(phone.localOrigin+'/api/deploy/'+job.id+'/'+action,{method:'POST',headers:{Authorization:'Bearer '+token,Origin:phone.origin,'Content-Type':'application/json'},body:JSON.stringify(action==='begin'?{from}:{})});return {status:r.status,body:await r.json()};};
        assert.equal((await request('begin')).status,200);
        let release,entered;const gate=new Promise(r=>entered=r);
        service.walletTransaction=async function(...args){const value=await original.apply(this,args);entered();await new Promise(r=>release=r);return value;};
        const pending=request('retry');await gate;
        const ticket=phone.store.handoff(job.id);ticket.expiresAt=Date.now()-1;phone.store.saveHandoff(ticket);release();
        assert.equal((await pending).status,410);assert.equal(service.record(job.id).walletRequestRevision,0);
        assert.equal((await request('retry')).status,410);assert.equal(phone.store.handoff(job.id).expiresAt,ticket.expiresAt);
      } finally {service.walletTransaction=original;await phone.close();}
    });
    await t.test('confirmation gate; GET reconciles stored hash without resubmission', async () => {
      const job = await historicalDeployment(service, { ...input, confirmations: 3 });
      const begun = await service.begin(job.id, { from });
      const sent = await send(begun.transaction);
      assert.equal((await service.attach(job.id, { transactionHash: sent.hash })).state, 'UNKNOWN');
      await hre.network.provider.send('hardhat_mine', ['0x2']);
      assert.equal((await service.get(job.id)).outcome, 'SUCCESS');
    });
  } finally {
    store.close(); provider.destroy(); await local.server.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
