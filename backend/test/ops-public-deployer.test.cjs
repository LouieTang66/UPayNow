'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {localArtifacts}=require('./fixtures/local-tools.cjs');
const {isolatedChain}=require('./fixtures/multichain-local.cjs');
const D=require('../deterministic.cjs'), ops=require('../../ops-public-deployer/service.cjs');
const {ethers}=require('ethers');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
test('isolated ops HTTP preview/prepare, fixed release, chain/code checks and reuse', {timeout:180000}, async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'upay-ops-browser-'));
 const c=await isolatedChain(31339,localArtifacts()); const app=await require('../../ops-public-deployer/server.cjs').start(0,{phone:{dir}});
 const input={chainId:c.chainId,rpcUrl:c.url};
 const req=async(action,body,origin=app.url)=>{const r=await fetch(app.url+'/api/'+action,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 try {
  assert.equal((await fetch(app.url)).status,200); assert.equal((await fetch(app.url+'/app.js')).status,200);
  assert.equal((await req('prepare',input,'https://evil.test')).status,403);
  assert.equal((await req('deployment-jobs',input)).status,404);
  for(const extra of [{payout:c.payout},{tokens:[]},{deployer:ethers.ZeroAddress},{bytecode:'0x00'}]) assert.equal((await req('preview',{...input,...extra})).body.error,'OPS_SCOPE_OVERRIDE');
  assert.equal((await req('preview',{...input,rpcUrl:'http://127.0.0.1'})).body.error,'RPC_HTTPS_REQUIRED');
  assert.equal((await req('preview',{...input,rpcUrl:'https://user:pass@example.test'})).body.error,'RPC_CREDENTIALS_NOT_ALLOWED');
  assert.equal((await req('preview',{...input,chainId:0})).body.error,'INVALID_CHAIN_ID');
  assert.equal((await req('preview',{...input,chainId:1})).body.error,'CHAIN_ID_MISMATCH');
  assert.equal((await req('preview',input)).body.error,'CANONICAL_SINGLETON_UNAVAILABLE');
  await c.evm.request({method:'hardhat_setCode',params:[D.SINGLETON,D.SINGLETON_RUNTIME]});
  const p=(await req('preview',input)).body; assert.equal(p.ready,false); assert.equal(p.deployer,'0x17F45EFf0a2cB4805180B62034F49c18d66e35EE');
  const {StrictProvider}=require('../deployment-service.cjs'), provider=new StrictProvider(c.url);
  const root=await D.inspectRoot(provider,input); provider.destroy();
  assert.equal((await req('prepare',{...input,from:c.payout})).status,200);
  const prepared=await ops.prepare({...input,from:c.payout}), tx=prepared.transaction;
  assert.equal(tx.to,D.SINGLETON);assert.equal(tx.chainId,ethers.toQuantity(c.chainId));assert.equal(tx.value,'0x0');
  const [code,salt]=new ethers.Interface(D.singletonABI).decodeFunctionData('deploy',tx.data);assert.equal(code,root.artifact.bytecode);assert.equal(salt,D.SALT);
  const signer=await c.provider.getSigner(1),nonce=await signer.getNonce();
  const {gas,...rest}=tx;await (await signer.sendTransaction({...rest,gasLimit:gas})).wait();
  const verified=(await req('verify',input)).body; assert.equal(verified.ready,true);assert.equal(verified.runtimeCodeHash,ethers.keccak256(root.artifact.deployedBytecode));
  assert.equal((await ops.prepare({...input,from:c.payout})).transaction,null);assert.equal(await signer.getNonce(),nonce+1);
  await c.evm.request({method:'hardhat_setCode',params:[p.deployer,'0x6000']});assert.equal((await req('verify',input)).body.error,'DEPLOYER_RUNTIME_MISMATCH');
  await c.evm.request({method:'hardhat_setCode',params:[D.SINGLETON,'0x6000']});assert.equal((await req('verify',input)).body.error,'SINGLETON_RUNTIME_MISMATCH');
 } finally {await app.close();await c.close();fs.rmSync(dir,{recursive:true,force:true});}
});
