'use strict';
const { apiKey } = require('./helpers/auth.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start } = require('../server.cjs');
const { DeploymentService } = require('../deployment-service.cjs');
const { OPEN_NETWORKS } = require('../deployment-networks.cjs');
const { localArtifacts } = require('./fixtures/local-tools.cjs');
const { isolatedChain } = require('./fixtures/multichain-local.cjs');
const { historicalDeployment } = require('./fixtures/historical-deployment.cjs');

test('product admission: authenticated authority, no request overrides, RPC identity, old import/begin/phone retry', {timeout:120000}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'upay-network-policy-'));
  let app, c;
  try {
    c = await isolatedChain(31337, localArtifacts());
    app = await start({dir,port:0,multiChain:true,externalWallet:true,pollMs:0,deploymentPort:0,deploymentQuick:false,deploymentOrigin:'https://deploy.example.test'});
    const req = async (route, input, auth=true, query='') => {
      const r = await fetch(app.url+'/api/'+route+query, {method:input===undefined?'GET':'POST',headers:{...(auth?{Authorization:'Bearer '+apiKey(dir)}:{}),...(input===undefined?{}:{'Content-Type':'application/json'})},...(input===undefined?{}:{body:JSON.stringify(input)})});
      return {status:r.status,body:await r.json()};
    };
    assert.equal((await req('deployment-networks',undefined,false)).status,401);
    const list=await req('deployment-networks'); assert.equal(list.status,200); assert.deepEqual(list.body,OPEN_NETWORKS);
    assert.deepEqual(list.body.map(n=>n.chainId),[56,42161,8453,9745,196,97,11155111]);
    assert.equal(list.body[0].nativeSymbol,'BNB');
    assert.equal(list.body[0].defaultRPC,'https://bsc-rpc.publicnode.com/');
    assert.equal(list.body.find(n=>n.chainId===97).nativeSymbol,'tBNB');
    assert.equal(list.body.find(n=>n.chainId===97).name,'BSC Testnet（测试网）');
    assert.equal(list.body.find(n=>n.chainId===11155111).name,'Ethereum Sepolia（测试网）');
    const arbitrum=list.body.find(n=>n.chainId===42161);
    assert.equal(arbitrum.name,'Arbitrum One'); assert.equal(arbitrum.nativeSymbol,'ETH');
    assert.equal(arbitrum.defaultRPC,'https://arbitrum-one-rpc.publicnode.com/');
    const base=list.body.find(n=>n.chainId===8453);
    assert.equal(base.name,'Base'); assert.equal(base.nativeSymbol,'ETH');
    assert.equal(base.defaultRPC,'https://base-rpc.publicnode.com/');
    const plasma=list.body.find(n=>n.chainId===9745);
    assert.equal(plasma.name,'Plasma'); assert.equal(plasma.nativeSymbol,'XPL');
    assert.equal(plasma.defaultRPC,'https://rpc.plasma.to/');
    const xlayer=list.body.find(n=>n.chainId===196);
    assert.equal(xlayer.name,'X Layer'); assert.equal(xlayer.nativeSymbol,'OKB');
    assert.equal(xlayer.defaultRPC,'https://xlayerrpc.okx.com/');
    const input={chainId:c.chainId,name:'Historical local',nativeSymbol:'ETH',rpcUrl:c.url,payout:c.payout,tokens:[c.token.target],confirmations:1};
    for (const chainId of [1,137,31337]) for(const scheme of ['legacy-v1','deterministic-v2']) {
      for (const route of ['deployment-jobs','deterministic/preview']) {
        const r=await req(route,{...input,chainId,scheme,importMode:true,factory:c.factory.target,networks:[{chainId}],deploymentNetworks:[{chainId}],allowAnyNetwork:true},true,'?chainId=97');
        assert.equal(r.status,403); assert.equal(r.body.error,'DEPLOYMENT_NETWORK_NOT_OPEN');
      }
    }
    for (const route of ['deployment-jobs','deterministic/preview']) {
      for (const chainId of [56,42161,8453,9745,196,97]) assert.equal((await req(route,{...input,chainId,scheme:'deterministic-v2'})).body.error,'CHAIN_ID_MISMATCH');
      assert.equal((await req(route,{...input,chainId:97,rpcUrl:'http://example.test',scheme:'deterministic-v2'})).body.error,'RPC_HTTPS_REQUIRED');
    }
    for (const route of ['deployment-jobs','deterministic/preview']) {
      for (const extra of [{},{allowLegacy:true,importMode:true,factory:c.factory.target}]) {
        const denied = await req(route,{...input,chainId:97,scheme:'legacy-v1',...extra});
        assert.equal(denied.status,403);assert.equal(denied.body.error,'LEGACY_DEPLOYMENT_DISABLED');
      }
    }
    assert.deepEqual((await req('deployment-jobs')).body,[]);
    // Inspection/import must continue to accept networks outside product admission.
    const imported=await req('deployments/import',{...input,factory:c.factory.target});
    assert.equal(imported.status,201,JSON.stringify(imported)); assert.equal(imported.body.chainId,31337);
    // Simulate an existing durable legacy task via constructor-only fixture injection.
    const fixture = new DeploymentService(app.store,{register:config=>app.deployments.register(config),networks:[{chainId:31337,name:'Local',nativeSymbol:'ETH',defaultRPC:c.url}]});
    const job=await historicalDeployment(fixture,input);
    const link=await app.deploymentHandoff.create(job.id);
    const begun=await req('deployment-jobs/'+job.id+'/begin',{from:c.payout}); assert.equal(begun.status,200,JSON.stringify(begun));
    const token=new URL(link.url).hash.slice(1), phone=app.deploymentHandoff;
    const r=await fetch(phone.localOrigin+'/api/deploy/'+job.id+'/retry',{method:'POST',headers:{Authorization:'Bearer '+token,Origin:phone.origin,'Content-Type':'application/json'},body:'{}'});
    const retry=await r.json(); assert.equal(r.status,200,JSON.stringify(retry));
    assert.equal(retry.job.walletRequestRevision,1); assert.equal(retry.transaction.chainId,'0x7a69'); assert.equal(retry.transaction.data,begun.body.transaction.data);
    assert.equal((await req('deployment-jobs',input)).body.error,'DEPLOYMENT_NETWORK_NOT_OPEN');
  } finally { await app?.close(); await c?.close(); fs.rmSync(dir,{recursive:true,force:true}); }
});
