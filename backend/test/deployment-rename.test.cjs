'use strict';
const { apiKey, initializePassword, PASSWORD } = require('./helpers/auth.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Deployments } = require('../deployments.cjs');
const { start } = require('../server.cjs');
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
const config = (name, chainId, scheme = 'legacy-v1') => ({ name, chainId, scheme, factory: '0x'+'11'.repeat(20), payout: '0x'+'22'.repeat(20), rpcUrl: 'https://fixture.invalid', nativeSymbol: 'TEST', tokens: [{address:'0x'+'33'.repeat(20),symbol:'TEST',decimals:6}] });
const clone = value => JSON.parse(JSON.stringify(value));
const withoutName = ({name,...rest}) => rest;

test('registry rename preserves identities/configs and persists legacy, v2, imported, broken and duplicate names', async () => {
  const configs = [config('v2',97,'deterministic-v2'),config('imported',11155111),config('broken',1)];
  const meta = new Map([['config',config('root',56)], ['deployments',ids.map((id,i)=>({id,config:configs[i]}))]]);
  const root = {store:{dir:path.join(os.tmpdir(),'upay-rename-unit'),get:(key,fallback)=>meta.has(key)?clone(meta.get(key)):fallback,set:(key,value)=>meta.set(key,clone(value))}};
  const engineConfigs = clone(configs);
  const createEngine = async dir => {
    const i = ids.indexOf(path.basename(dir));
    if(i===2) throw Error('fixture load failure');
    return {store:{get:key=>key==='config'?engineConfigs[i]:undefined},merchant:{configure(){assert.fail('Rename must not configure a merchant');}},close:async()=>{}};
  };
  const registry = await new Deployments(root,{createEngine}).load();
  const before = registry.list().deployments.map(withoutName);
  await Promise.all([registry.rename(ids[0],{name:'  同名备注  '}),registry.rename(ids[1],{name:'同名备注'})]);
  await registry.rename(ids[2],{name:'故障部署备注'});
  await registry.rename('legacy',{name:'原有部署新名称'});
  assert.deepEqual(registry.list().deployments.map(withoutName),before);
  assert.deepEqual(engineConfigs,configs);
  assert.equal(meta.get('config').name,'root');
  const after = registry.list();
  await registry.close();
  const restored = await new Deployments(root,{createEngine}).load();
  assert.deepEqual(restored.list(),after);
  const snapshot = JSON.stringify([...meta]);
  for(const input of [null,[],{}, {name:''},{name:'   '},{name:'x'.repeat(129)},{name:123},{name:'ok',payout:'0x'+'99'.repeat(20)},{name:'ok',chainId:1}]) {
    await assert.rejects(restored.rename(ids[0],input),{code:'INVALID_DEPLOYMENT_NAME'});
    assert.equal(JSON.stringify([...meta]),snapshot);
  }
  await assert.rejects(restored.rename('missing',{name:'valid'}),{code:'DEPLOYMENT_NOT_FOUND'});
  await restored.rename(ids[0],{name:'x'.repeat(128)});
  assert.equal(restored.list().deployments.find(d=>d.id===ids[0]).name.length,128);
  await restored.close();
});

test('real authenticated rename API: scope, cookie Origin, field rejection, and restart persistence', {timeout:20000}, async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'upay-rename-http-'));
  const options={dir,port:0,multiChain:true,externalWallet:true,pollMs:0,deploymentPort:0,deploymentQuick:false};
  let app;
  try {
    app=await start(options);
    const request=async(route,input,headers={})=>{
      const r=await fetch(app.url+'/api/'+route,{method:input===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...headers},...(input===undefined?{}:{body:JSON.stringify(input)})});
      return {status:r.status,body:await r.json(),headers:r.headers};
    };
    const auth={Authorization:'Bearer '+apiKey(dir)};
    assert.equal((await request('deployments/legacy/name',{name:'blocked'})).status,401);
    await initializePassword(app, dir);
    const login=await request('login',{password:PASSWORD},{Origin:app.url});
    assert.equal(login.status,200);
    const cookie={Cookie:login.headers.get('set-cookie').split(';')[0]};
    assert.equal((await request('deployments/legacy/name',{name:'blocked'},cookie)).status,403);
    const before=(await request('deployments',undefined,auth)).body.deployments[0];
    const saved=await request('deployments/legacy/name',{name:'  自定义名称  '},{...cookie,Origin:app.url});
    assert.equal(saved.status,200);assert.equal(saved.body.name,'自定义名称');
    assert.deepEqual(withoutName(saved.body),withoutName(before));
    const child=ids[0], childConfig=config('imported',97,'deterministic-v2');
    app.store.set('deployments',[{id:child,config:childConfig}]);
    app.deployments.descriptors.set(child,{id:child,config:childConfig});
    app.deployments.entries.set(child,{id:child,error:'fixture unavailable',close:async()=>{}});
    const childSaved=await request('deployments/'+child+'/name',{name:'自定义名称'},auth);
    assert.equal(childSaved.status,200);assert.equal(childSaved.body.name,'自定义名称');
    assert.equal(childSaved.body.id,child);assert.equal(childSaved.body.factory,childConfig.factory);
    for(const body of [{name:' '},{name:'x'.repeat(129)},{name:'bad',factory:'0x'+'99'.repeat(20)}]) assert.equal((await request('deployments/legacy/name',body,auth)).status,400);
    assert.equal((await request('deployments/99999999-9999-4999-8999-999999999999/name',{name:'missing'},auth)).status,404);
    await app.close();app=await start(options);
    const restored=(await request('deployments',undefined,auth)).body.deployments;
    assert.equal(restored.find(d=>d.id==='legacy').name,'自定义名称');
    assert.equal(restored.find(d=>d.id===child).name,'自定义名称');
  } finally {await app?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
