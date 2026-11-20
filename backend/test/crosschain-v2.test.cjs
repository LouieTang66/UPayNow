'use strict';
const { apiKey, initializePassword, PASSWORD } = require('./helpers/auth.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ethers } = require('ethers');
const { start } = require('../server.cjs');
const { localArtifacts } = require('./fixtures/local-tools.cjs');
const { isolatedChain } = require('./fixtures/multichain-local.cjs');
const D = require('../deterministic.cjs');

test('deterministic v2 HTTP: two isolated HTTPS EVMs, bootstrap, strict provenance and durable recovery', {timeout:180000}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upay-crosschain-v2-'));
  const options = {dir, port:0, multiChain:true, externalWallet:true, pollMs:0, deploymentPort:0, deploymentQuick:false, deploymentOrigin:'https://deploy.example.test',
    deploymentNetworks: [31337,31338].map(chainId => ({chainId,name:'Isolated '+chainId,nativeSymbol:'ETH',defaultRPC:'https://test.invalid'}))};
  let app, a, b, sourceId, targetId, sourceOrder;
  const config = c => ({name:'Isolated '+c.chainId, rpcUrl:c.url, chainId:c.chainId, payout:c.payout, tokens:[c.token.target], confirmations:1, scheme:D.SCHEME});
  const req = async (route, input, scope, extra = {}) => {
    const r = await fetch(app.url+route, {method:input === undefined ? 'GET':'POST', headers:{Authorization:'Bearer '+apiKey(dir), ...(input === undefined ? {}:{'Content-Type':'application/json'}), ...(scope ? {'X-Upay-Deployment':scope}:{}), ...extra}, ...(input === undefined ? {}:{body:JSON.stringify(input)})});
    return {status:r.status, body:await r.json()};
  };
  const ok = r => {assert.ok(r.status >= 200 && r.status < 300, JSON.stringify(r)); return r.body;};
  const send = async (c, tx, index=1) => {
    const {gas,...rest}=tx; const s=await (await c.provider.getSigner(index)).sendTransaction({...rest,gasLimit:gas}); await s.wait(); return s;
  };
  const deploy = async (c, stage, tokens) => {
    // Historical bootstrap fixture only: product create API remains closed.
    let j;
    if (stage === 'bootstrap') {
      const ops = require('../../ops-public-deployer/service.cjs');
      const prepared = await ops.prepare({ chainId:c.chainId, rpcUrl:c.url, from:c.payout });
      if (prepared.ready) return {state:'MINED',outcome:'SUCCESS'};
      const {randomUUID}=require('node:crypto');
      const summary={...config(c),stage,deployer:prepared.deployer,predictedFactory:D.predictFactory(prepared.deployer,c.payout)};
      summary.tokens=[{address:c.token.target}];
      j=app.deploymentService.view(app.deploymentService.save({id:randomUUID(),state:'READY',summary,createdAt:new Date().toISOString(),to:prepared.transaction.to,data:prepared.transaction.data}));
      assert.equal(ok(await req('/api/deployment-jobs/'+j.id)).state,'READY');
    } else j=ok(await req('/api/deployment-jobs',{...config(c),stage,...(tokens?{tokens}: {})}));
    if(j.state === 'MINED') return j;
    const phone=app.deploymentHandoff;
    const link=stage === 'bootstrap' ? await phone.create(j.id) : null;
    const started=ok(await req('/api/deployment-jobs/'+j.id+'/begin',{from:c.payout}));
    const originalStart=app.deploymentService.record(j.id).startBlock;
    let resumed;
    if (stage === 'bootstrap') {
      const token=new URL(link.url).hash.slice(1);
      const call=async(action,body)=>{const r=await fetch(phone.localOrigin+'/api/deploy/'+j.id+'/'+action,{method:'POST',headers:{Authorization:'Bearer '+token,Origin:phone.origin,'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200);return r.json();};
      assert.equal((await call('reject',{requestRevision:0})).state,'CANCELLED');
      resumed=await call('retry',{});
      assert.equal(resumed.expiresAt,link.expiresAt);
      assert.equal(ok(await req('/api/deployment-jobs/'+j.id+'/refresh',{})).state,'UNKNOWN');
    } else resumed=await app.deploymentService.retry(j.id,{},()=>{});
    assert.equal(resumed.job.walletRequestRevision,1);
    for(const key of ['from','to','data','value','chainId']) assert.equal(resumed.transaction[key],started.transaction[key]);
    assert.equal(app.deploymentService.record(j.id).startBlock,originalStart);
    const sent=await send(c,resumed.transaction);
    return ok(await req('/api/deployment-jobs/'+j.id+'/attach',{transactionHash:sent.hash}));
  };
  try {
    const compiled=localArtifacts(); a=await isolatedChain(31337,compiled); b=await isolatedChain(31338,compiled);
    // Make target token CA differ despite same payout; do not rely on EOA CREATE nonce parity.
    const signer=await b.provider.getSigner(0);
    const token=await new ethers.ContractFactory(compiled.token.abi,compiled.token.evm.bytecode.object,signer).deploy('TARGET_USDT',6); await token.waitForDeployment(); b.token=token;
    assert.notEqual(a.token.target,b.token.target);
    app=await start(options);
    await t.test('read-only preview, absent canonical explicit refusal, official rawtx runtime and forged canonical fail closed',async()=>{
      const p=ok(await req('/api/deterministic/preview',config(a)));
      assert.equal(p.singletonReady,false); assert.equal(p.deployerReady,false); assert.ok(ethers.isAddress(p.factory));
      assert.equal(app.store.get('deployment-service.jobs.v1',[]).length,0);
      const refused=await req('/api/deployment-jobs',{...config(a),stage:'bootstrap'});
      assert.equal(refused.status,403); assert.equal(refused.body.error,'PUBLIC_BOOTSTRAP_OPS_ONLY');
      assert.equal((await req('/api/deployment-jobs',config(a))).body.error,'CANONICAL_SINGLETON_UNAVAILABLE');
      // Fixture-only injection: runtime derived independently from the OFFICIAL raw transaction.
      const raw=require('./fixtures/erc2470.cjs'), tx=ethers.Transaction.from(raw);
      assert.equal(ethers.keccak256(raw),'0x803351deb6d745e91545a6a3e1c0ea3e9a6a02a1a4193b70edfcd2f40f71a01c');
      const runtime='0x'+tx.data.slice(2+32*2);
      assert.equal(runtime,D.SINGLETON_RUNTIME);
      assert.equal(ethers.getCreateAddress({from:tx.from,nonce:tx.nonce}),D.SINGLETON);
      for(const c of [a,b]) await c.evm.request({method:'hardhat_setCode',params:[D.SINGLETON,runtime]});
      await a.evm.request({method:'hardhat_setCode',params:[D.SINGLETON,'0x00'+runtime.slice(4)]});
      assert.equal((await req('/api/deterministic/preview',config(a))).body.error,'SINGLETON_RUNTIME_MISMATCH');
      await a.evm.request({method:'hardhat_setCode',params:[D.SINGLETON,runtime]});
      assert.equal((await req('/api/deployment-jobs',config(a))).body.error,'DETERMINISTIC_DEPLOYER_NOT_READY');
      assert.equal(app.deploymentService.list().length,0);
    });
    await t.test('bootstrap does not register, authentic root reuse, merchant payout-only, cross-chain same Factory+impl',async()=>{
      const pa=ok(await req('/api/deterministic/preview',config(a)));
      const { StrictProvider } = require('../deployment-service.cjs');
      const estimate = StrictProvider.prototype.estimateGas;
      let underestimates = 0;
      try {
        // Some RPCs accept a cheap ERC-2470 outer success even though CREATE2
        // returned zero. Exercise a real successful bootstrap despite that quote.
        StrictProvider.prototype.estimateGas = function(request, ...rest) {
          if (request.to?.toLowerCase() === D.SINGLETON.toLowerCase()) { underestimates++; return Promise.resolve(21000n); }
          return estimate.call(this, request, ...rest);
        };
        for (const c of [a,b]) {
          const j=await deploy(c,'bootstrap'); assert.equal(j.outcome,'SUCCESS'); assert.equal(j.deploymentId,undefined);
          assert.equal(j.summary.tokens[0].address,c.token.target);
        }
        assert.equal(underestimates,6);
      } finally { StrictProvider.prototype.estimateGas=estimate; }
      assert.equal(app.deployments.list().deployments.length,1);
      const pb=ok(await req('/api/deterministic/preview',config(b)));
      assert.equal(pa.factory,pb.factory); assert.equal(pa.deployer,pb.deployer);
      assert.equal((await deploy(a,'bootstrap')).state,'MINED');
      const rootCode=await a.provider.getCode(pa.deployer);
      await a.evm.request({method:'hardhat_setCode',params:[pa.deployer,'0x00'+rootCode.slice(4)]});
      assert.equal((await req('/api/deterministic/preview',config(a))).body.error,'DEPLOYER_RUNTIME_MISMATCH');
      await a.evm.request({method:'hardhat_setCode',params:[pa.deployer,rootCode]});
      const j=ok(await req('/api/deployment-jobs',config(a)));
      const stale=ok(await req('/api/deployment-jobs',config(a)));
      const wrong=await (await a.provider.getSigner(0)).getAddress();
      assert.equal((await req('/api/deployment-jobs/'+j.id+'/begin',{from:wrong})).body.error,'PAYOUT_WALLET_REQUIRED');
      const begin=ok(await req('/api/deployment-jobs/'+j.id+'/begin',{from:a.payout}));
      assert.equal(begin.transaction.to,pa.deployer);
      assert.equal((await req('/api/deployment-jobs/'+j.id+'/begin',{from:a.payout})).body.error,'DEPLOYMENT_NOT_READY');
      const sent=await send(a,begin.transaction), done=ok(await req('/api/deployment-jobs/'+j.id+'/attach',{transactionHash:sent.hash})); sourceId=done.deploymentId;
      const other=await deploy(b,'merchant'); targetId=other.deploymentId;
      assert.equal((await req('/api/deployment-jobs/'+stale.id+'/begin',{from:a.payout})).body.error,'DETERMINISTIC_FACTORY_ALREADY_EXISTS');
      assert.equal(app.deploymentService.record(stale.id).state,'READY');
      assert.equal(ok(await req('/api/deployment-jobs/'+stale.id+'/cancel',{rejected:true})).state,'CANCELLED');
      assert.equal(done.factory,other.factory);
      assert.equal(app.deployments.get(sourceId).merchant.chain.config.scheme,D.SCHEME);
      assert.equal(app.deployments.get(targetId).merchant.chain.config.deployer,pb.deployer);
      assert.equal(await app.deployments.get(sourceId).merchant.chain.factory.implementation(),await app.deployments.get(targetId).merchant.chain.factory.implementation());
      assert.equal((await deploy(a,'merchant')).deploymentId,sourceId);
      assert.equal((await req('/api/deployment-jobs',{...config(a),tokens:[b.token.target]})).status,400);
      sourceOrder=ok(await req('/api/orders',{reference:'original',token:a.token.target,amount:'1',expiresInSeconds:1800},sourceId));
    });
    await t.test('v2 deployment confirmation/refresh gate, unrelated transaction and genuine-root event required',async()=>{
      const payout=await (await a.provider.getSigner(2)).getAddress();
      const j=ok(await req('/api/deployment-jobs',{...config(a),payout,confirmations:2}));
      const begun=ok(await req('/api/deployment-jobs/'+j.id+'/begin',{from:payout}));
      const sent=await send(a,begun.transaction,2);
      assert.equal(ok(await req('/api/deployment-jobs/'+j.id+'/attach',{transactionHash:sent.hash})).state,'UNKNOWN');
      await a.evm.request({method:'evm_mine',params:[]});
      assert.equal(ok(await req('/api/deployment-jobs/'+j.id+'/refresh',{})).state,'MINED');
      const payout3=await (await a.provider.getSigner(3)).getAddress();
      const bad=ok(await req('/api/deployment-jobs',{...config(a),payout:payout3}));
      const intent=ok(await req('/api/deployment-jobs/'+bad.id+'/begin',{from:payout3}));
      const transfer=await (await a.provider.getSigner(3)).sendTransaction({to:payout3,value:0n}); await transfer.wait();
      assert.equal((await req('/api/deployment-jobs/'+bad.id+'/attach',{transactionHash:transfer.hash})).body.error,'DEPLOYMENT_TRANSACTION_MISMATCH');
      assert.equal(app.deploymentService.record(bad.id).state,'UNKNOWN');
      const payout4=await (await a.provider.getSigner(4)).getAddress();
      const eventJob=ok(await req('/api/deployment-jobs',{...config(a),payout:payout4}));
      const eventIntent=ok(await req('/api/deployment-jobs/'+eventJob.id+'/begin',{from:payout4}));
      const root=new ethers.Contract(eventIntent.transaction.to,D.rootABI,await a.provider.getSigner(4));
      await (await root.deploy(payout4,[a.token.target])).wait();
      const repeat=await send(a,eventIntent.transaction,4);
      assert.equal((await req('/api/deployment-jobs/'+eventJob.id+'/attach',{transactionHash:repeat.hash})).body.error,'DEPLOYMENT_EVENT_MISMATCH');
      assert.equal(app.deploymentService.record(eventJob.id).state,'UNKNOWN');
    });
    const recovery = token => ({sourceDeploymentId:sourceId,targetDeploymentId:targetId,orderId:sourceOrder.id,token});
    await t.test('actual wrong-chain balances, original orderHash binding, unsupported/legacy/same-chain/scope rejection and auth',async()=>{
      await (await b.token.mint(sourceOrder.address,1234567n)).wait();
      const p=ok(await req('/api/crosschain-recovery/preview',recovery(b.token.target)));
      assert.equal(p.balanceUnits,'1234567'); assert.equal(p.address,sourceOrder.address); assert.equal(p.orderHash,sourceOrder.orderHash); assert.equal(p.chainId,b.chainId); assert.equal(p.supportedToken,true);
      assert.equal(app.deployments.get(targetId).store.orders().length,0);
      assert.equal((await req('/api/crosschain-recovery/preview',{...recovery(b.token.target),targetDeploymentId:sourceId})).body.error,'RECOVERY_REQUIRES_DIFFERENT_CHAIN');
      assert.equal((await req('/api/crosschain-recovery/preview',{...recovery(b.token.target),sourceDeploymentId:'missing'})).status,404);
      assert.equal((await req('/api/crosschain-recovery/preview',{...recovery(b.token.target),orderId:'missing'})).status,404);
      const legacy=ok(await req('/api/deployments/import',{...config(a),scheme:'legacy-v1',factory:a.factory.target}));
      assert.equal((await req('/api/crosschain-recovery/preview',{...recovery(b.token.target),sourceDeploymentId:legacy.id})).body.error,'DETERMINISTIC_DEPLOYMENTS_REQUIRED');
      const unauth=await fetch(app.url+'/api/crosschain-recovery/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(recovery(b.token.target))}); assert.equal(unauth.status,401);
      await initializePassword(app, dir);
      const login=await fetch(app.url+'/api/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:app.url},body:JSON.stringify({password:PASSWORD})});
      const csrf=await fetch(app.url+'/api/crosschain-recovery/prepare',{method:'POST',headers:{'Content-Type':'application/json',Cookie:login.headers.get('set-cookie').split(';')[0],Origin:'https://evil.example'},body:JSON.stringify({...recovery(b.token.target),from:b.payout})}); assert.equal(csrf.status,403);
    });
    await t.test('durable target job after restart, scoped begin/attach, collectBatch and no paid/webhook/accounting side effects',async()=>{
      const before=structuredClone(app.deployments.get(sourceId).store.order(sourceOrder.id));
      const prepared=ok(await req('/api/crosschain-recovery/prepare',{...recovery(b.token.target),from:b.payout}));
      const id=prepared.job.id; assert.equal(prepared.job.recoveryOnly,true); assert.equal(prepared.job.transaction,undefined);
      const target=app.deployments.get(targetId); assert.equal(target.store.orders().length,0); assert.ok(target.store.get('crosschain-recovery.order:'+id));
      assert.equal((await req('/api/wallet/jobs/'+id+'/begin',{},sourceId)).status,404);
      await app.close(); app=await start(options);
      const begun=ok(await req('/api/wallet/jobs/'+id+'/begin',{},targetId));
      assert.equal(Number(BigInt(begun.transaction.chainId)),b.chainId);
      assert.equal(app.deployments.get(targetId).merchant.chain.factory.interface.parseTransaction({data:begun.transaction.data}).name,'collectBatch');
      assert.equal((await req('/api/wallet/jobs/'+id+'/begin',{},targetId)).status,409);
      const unknown='0x'+'ab'.repeat(32); const attached=ok(await req('/api/wallet/jobs/'+id+'/attach',{transactionHash:unknown},targetId)); assert.equal(attached.state,'UNKNOWN');
      const sent=await send(b,begun.transaction);
      const mined=ok(await req('/api/wallet/jobs/'+id+'/attach',{transactionHash:sent.hash},targetId)); assert.equal(mined.state,'MINED'); assert.equal(mined.outcome,'SUCCESS');
      assert.equal(await b.token.balanceOf(sourceOrder.address),0n); assert.equal(await b.token.balanceOf(b.payout),1234567n);
      assert.deepEqual(app.deployments.get(sourceId).store.order(sourceOrder.id),before);
      assert.equal(app.deployments.get(targetId).store.orders().length,0); assert.equal(app.deployments.get(targetId).store.notifications().length,0);
      assert.equal(ok(await req('/api/wallet/jobs/'+id+'/refresh',{},targetId)).state,'MINED');
    });
    await t.test('native and wrong CA use collectWrongToken, fixed payout, cancellation and failure/reorg guards',async()=>{
      const wrong=a.token.target; const wrongToken=new ethers.Contract(wrong,compiled.token.abi,await b.provider.getSigner(0));
      for(const token of [wrong,ethers.ZeroAddress]) {
        if(token===ethers.ZeroAddress) await (await (await b.provider.getSigner(0)).sendTransaction({to:sourceOrder.address,value:777n})).wait();
        else await (await wrongToken.mint(sourceOrder.address,999n)).wait();
        const prepared=ok(await req('/api/crosschain-recovery/prepare',{...recovery(token),from:b.payout}));
        const id=prepared.job.id; const begun=ok(await req('/api/wallet/jobs/'+id+'/begin',{},targetId));
        const parsed=app.deployments.get(targetId).merchant.chain.factory.interface.parseTransaction({data:begun.transaction.data}); assert.equal(parsed.name,'collectWrongToken'); assert.equal(parsed.args[0],sourceOrder.orderHash); assert.equal(parsed.args[1],token);
        const sent=await send(b,begun.transaction); assert.equal(ok(await req('/api/wallet/jobs/'+id+'/attach',{transactionHash:sent.hash},targetId)).state,'MINED');
        assert.equal(ok(await req('/api/crosschain-recovery/preview',recovery(token))).balanceUnits,'0');
      }
      await (await b.token.mint(sourceOrder.address,10n)).wait();
      const prepared=ok(await req('/api/crosschain-recovery/prepare',{...recovery(b.token.target),from:b.payout}));
      assert.equal(ok(await req('/api/wallet/jobs/'+prepared.job.id+'/cancel',{},targetId)).state,'CANCELLED');
      assert.equal(app.deployments.get(targetId).store.orders().length,0);
    });
    await t.test('optional token metadata absence preserves raw balance and does not block a real wrong-token sweep',async()=>{
      const token=a.token.target, provider=b.provider;
      const c=new ethers.Contract(token,compiled.token.abi,await provider.getSigner(0));
      await (await c.mint(sourceOrder.address,37n)).wait();
      const original=await provider.getCode(token);
      const decimalsSelector=ethers.id('decimals()').slice(2,10), symbolSelector=ethers.id('symbol()').slice(2,10);
      assert.ok(original.includes(decimalsSelector) && original.includes(symbolSelector));
      // Local fixture: disable only optional metadata selectors; balances and
      // ERC-20 transfer still execute the actual token's original storage/code.
      const noMetadata=original.replace(decimalsSelector,'fefefefe').replace(symbolSelector,'fdfdfdfd');
      await b.evm.request({method:'hardhat_setCode',params:[token,noMetadata]});
      try {
        const preview=ok(await req('/api/crosschain-recovery/preview',recovery(token)));
        assert.equal(preview.metadataAvailable,false); assert.equal(preview.balanceUnits,'37'); assert.equal(preview.decimals,0);
        assert.equal(preview.symbol,'原始单位（精度未知）');
        const before=await c.balanceOf(b.payout);
        const prepared=ok(await req('/api/crosschain-recovery/prepare',{...recovery(token),from:b.payout}));
        const begun=ok(await req('/api/wallet/jobs/'+prepared.job.id+'/begin',{},targetId));
        const sent=await send(b,begun.transaction);
        const mined=ok(await req('/api/wallet/jobs/'+prepared.job.id+'/attach',{transactionHash:sent.hash},targetId));
        assert.equal(mined.outcome,'SUCCESS'); assert.equal(await c.balanceOf(b.payout),before+37n);
        assert.equal(await c.balanceOf(sourceOrder.address),0n);
      } finally { await b.evm.request({method:'hardhat_setCode',params:[token,original]}); }
    });
    await t.test('unchanged final recovery jobs do not re-fetch all immutable contract bindings each poll',async()=>{
      const service=require('../deployment-service.cjs'), inspect=service.inspectDeployment;
      let inspections=0;
      service.inspectDeployment=async(...args)=>{ inspections++; return inspect(...args); };
      try {
        const merchant=app.deployments.get(targetId).merchant;
        await merchant.refreshJobs(); await merchant.refreshJobs();
        assert.equal(inspections,0);
      } finally { service.inspectDeployment=inspect; }
    });
    await t.test('recovery confirmation gate, canonical reorg and unrelated hashes remain non-final',async()=>{
      const target=app.deployments.get(targetId), chain=target.merchant.chain;
      const p=ok(await req('/api/crosschain-recovery/prepare',{...recovery(b.token.target),from:b.payout})), id=p.job.id;
      const code=await b.provider.getCode(chain.config.factory);
      await b.evm.request({method:'hardhat_setCode',params:[chain.config.factory,'0x00'+code.slice(4)]});
      assert.equal((await req('/api/wallet/jobs/'+id+'/begin',{},targetId)).body.error,'CONTRACT_RUNTIME_MISMATCH');
      await b.evm.request({method:'hardhat_setCode',params:[chain.config.factory,code]});
      const begun=ok(await req('/api/wallet/jobs/'+id+'/begin',{},targetId));
      const unrelated=await (await b.provider.getSigner(1)).sendTransaction({to:a.payout,value:0n}); await unrelated.wait();
      const mismatch=ok(await req('/api/wallet/jobs/'+id+'/attach',{transactionHash:unrelated.hash},targetId)); assert.equal(mismatch.state,'UNKNOWN'); assert.equal(mismatch.error,'TRANSACTION_DOES_NOT_MATCH_JOB');
      const snap=await b.evm.request({method:'evm_snapshot',params:[]});
      chain.config.confirmations=2;
      const sent=await send(b,begun.transaction);
      assert.equal(ok(await req('/api/wallet/jobs/'+id+'/attach',{transactionHash:sent.hash},targetId)).state,'SUBMITTED');
      const descendants=await b.evm.request({method:'evm_snapshot',params:[]});
      await b.evm.request({method:'evm_mine',params:[]});
      assert.equal(ok(await req('/api/wallet/jobs/'+id+'/refresh',{},targetId)).state,'MINED');
      await b.evm.request({method:'evm_revert',params:[descendants]});
      const lessConfirmed=ok(await req('/api/wallet/jobs/'+id+'/refresh',{},targetId));
      assert.equal(lessConfirmed.state,'SUBMITTED'); assert.equal(lessConfirmed.outcome,null);
      assert.equal(lessConfirmed.error,'CONFIRMATIONS_REORGED');
      await b.evm.request({method:'evm_mine',params:[]});
      assert.equal(ok(await req('/api/wallet/jobs/'+id+'/refresh',{},targetId)).state,'MINED');
      await b.evm.request({method:'evm_revert',params:[snap]});
      assert.equal(ok(await req('/api/wallet/jobs/'+id+'/refresh',{},targetId)).state,'UNKNOWN');
      assert.equal((await req('/api/crosschain-recovery/prepare',{...recovery(b.token.target),from:b.payout})).body.error,'TRANSACTION_RECONCILIATION_REQUIRED');
      assert.equal((await req('/api/wallet/jobs/'+id+'/cancel',{rejected:true},targetId)).body.error,'UNCERTAIN_TRANSACTION_CANNOT_CANCEL');
      chain.config.confirmations=1;
    });
  } finally { await app?.close(); await a?.close(); await b?.close(); fs.rmSync(dir,{recursive:true,force:true}); }
});
