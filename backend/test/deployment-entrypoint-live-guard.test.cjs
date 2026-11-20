'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const root = require('node:path').resolve(__dirname, '../..');
const { localArtifacts } = require(root + '/backend/test/fixtures/local-tools.cjs');
const { isolatedChain } = require(root + '/backend/test/fixtures/multichain-local.cjs');
const D = require(root + '/backend/deterministic.cjs');
const ops = require(root + '/ops-public-deployer/service.cjs');
const { DeploymentService } = require(root + '/backend/deployment-service.cjs');
test('merchant wallet request refuses an entrypoint that disappears after preview', { timeout: 60000 }, async () => {
  const c = await isolatedChain(31349, localArtifacts());
  try {
    await c.evm.request({ method:'hardhat_setCode', params:[D.SINGLETON,D.SINGLETON_RUNTIME] });
    const prepared = await ops.prepare({chainId:c.chainId,rpcUrl:c.url,from:c.payout});
    const signer = await c.provider.getSigner(1);
    const { gas, ...tx } = prepared.transaction;
    await (await signer.sendTransaction({...tx,gasLimit:gas})).wait();
    const values = new Map();
    const store = { get:(key,fallback) => values.has(key) ? values.get(key) : fallback, set:(key,value) => values.set(key,value) };
    const service = new DeploymentService(store, { register:async()=>{throw new Error('Unexpected registration');}, networks:[{chainId:c.chainId,name:'Isolated test',defaultRPC:c.url,nativeSymbol:'ETH'}] });
    const job = await service.create({name:'Isolated guard test',scheme:'deterministic-v2',chainId:c.chainId,rpcUrl:c.url,payout:c.payout,tokens:[c.token.target],confirmations:1});
    assert.equal(job.state,'READY');
    const nonce = await signer.getNonce();
    await c.evm.request({method:'hardhat_setCode',params:[prepared.deployer,'0x']});
    await assert.rejects(service.begin(job.id,{from:c.payout}), {message:'DETERMINISTIC_DEPLOYER_NOT_READY'});
    assert.equal(await signer.getNonce(),nonce);
    assert.equal(service.record(job.id).candidateHash,undefined);
  } finally { await c.close(); }
});
