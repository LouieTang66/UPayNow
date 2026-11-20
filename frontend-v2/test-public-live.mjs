// Isolated source/VM simulation: no server, network, real wallet, credentials or artifacts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { build } from 'esbuild';
const guardBundle = await build({ entryPoints: [new URL('./src/shared/deployment-guard.js', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'node' });
const deploymentGuards = await import('data:text/javascript;base64,' + Buffer.from(guardBundle.outputFiles[0].text).toString('base64'));
const dir = new URL('./src/public/', import.meta.url);
const source = name => fs.readFileSync(new URL(name + '.js', dir), 'utf8').replace(/^import .*;\n/gm, '');
const storage = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k,v) => m.set(k,v), removeItem: k => m.delete(k) }; };
class ApiError extends Error { constructor(code, status=0) { super(code); this.code=code; this.status=status; } }
let passed = 0;
async function test(name, fn) { await fn(); console.log('PASS ' + name); passed++; }
const id = '11111111-1111-4111-8111-111111111111', from = '0x' + '1'.repeat(40), factory = '0x' + '2'.repeat(40), hash = '0x' + 'a'.repeat(64);
function harness(page, path = '/' + (page === 'deploy' ? 'd' : 'c') + '/' + id) {
  const frames=[], calls=[], paints=[];
  const h = (tag, props, ...children) => ({ tag, props: props || {}, classList: { toggle() {} }, children: children.flat(Infinity).filter(x => x != null) });
  const root = { querySelector: () => null };
  const c = vm.createContext({ ...deploymentGuards, console, URL, Date, BigInt, Number, JSON, Error, ApiError,
    location: { pathname: path, search: '', hash: '#' + 'a'.repeat(43) }, history: { replaceState() { c.location.hash=''; } },
    sessionStorage: storage(), localStorage: storage(),
    installLanguageSupport() {}, languageButton: () => h('button', { type: 'button' }, 'EN'),
    h, trustedSvg: svg => h('svg', {}, svg), brandLogo: fs.readFileSync(new URL('./brand/upaynow-b-coin.svg', import.meta.url), 'utf8'),
    replace: (_root,...nodes) => { root.nodes=nodes; paints.push(nodes); }, notice: (...v) => h('notice',{},...v), field: (...v) => h('field',{},...v), copyable: x=>x,
    amount: x=>String(x), countdown: x=>String(x), shortAddr: x=>x, errorText:x=>x,
    document: { getElementById: () => root, activeElement: null }, window: {},
    requestAnimationFrame: fn=>frames.push(fn), setTimeout,
    fetch: async(path, opts)=>{ calls.push({path,opts}); throw Error('Unexpected mocked network call'); }
  });
  vm.runInContext(source('common').replace(/^export \{.*\};\n/gm,'').replace(/export /g,''), c);
  const s = source(page).split('\n(async () => {')[0];
  vm.runInContext(s + '\nglobalThis.test = { read, render, record, ' + (page === 'deploy' ? 'deploy, retry, canRetry, applyResult, acknowledge, statusBlock,' : 'send, retry, canRetry, prepareReview, attach, applyJob, status,') + ` set(v) { ${page === 'deploy' ? 'job=v; expiresAt=v.expiresAt;' : 'view=v;'} token='test'; account='${from}'; }, state() { return { ${page === 'deploy' ? 'job' : 'view'}, failure, closed }; } };`, c);
  c.frames=frames; c.calls=calls; c.root=root; c.paints=paints;
  c.providerCalls=[];
  c.window.ethereum={ request: async ({method})=>{ c.providerCalls.push(method); if(method==='eth_accounts') return [from]; if(method==='eth_chainId') return '0x38'; if(method==='eth_sendTransaction') return hash; } };
  return c;
}
const expiry=()=>Date.now()+60000;
const deployment=()=>({ id, state:'READY', summary:{name:'Fixture chain',chainId:56,nativeSymbol:'BNB',payout:from,confirmations:2,tokens:[{symbol:'TOKEN',address:factory}]}, expiresAt:expiry() });
const collection=()=>({id,state:'READY',chainId:56,chainName:'Fixture chain',nativeSymbol:'BNB',factory,payout:from,expiresAt:expiry(),entries:[{reference:'fixture',address:from,token:factory,symbol:'TOKEN',expectedAmount:'1',balance:'2'}],job:null});
const text = c => JSON.stringify(c.root.nodes);
await test('capability strips fragment; same-tab reload; invalid replacement never restores old token',()=>{
 const c=harness('deploy'); assert.equal(vm.runInContext(`capability('deploy','${id}')`,c),'a'.repeat(43)); assert.equal(c.location.hash,'');
 assert.equal(vm.runInContext(`capability('deploy','${id}')`,c),'a'.repeat(43)); c.location.hash='#bad'; assert.equal(vm.runInContext(`capability('deploy','${id}')`,c),''); assert.equal(c.location.hash,'');
});
await test('local persistence memory retains newer hash when storage starts failing',()=>{
 const c=harness('deploy'); c.test.record.set({state:'BEGIN_SENT'},true); c.localStorage.setItem=()=>{throw Error('quota');}; c.test.record.set({state:'UNKNOWN',hash}); assert.equal(c.test.record.get().hash,hash);
});
for (const page of ['deploy','collect']) {
 await test(page+' original and /v2 alias identify same real API route',async()=>{
  for(const prefix of ['', '/v2']) { const c=harness(page,prefix+'/'+(page==='deploy'?'d':'c')+'/'+id); c.fetch=async(path,opts)=>{assert.equal(path,(page==='deploy'?'/api/deploy/':'/api/handoffs/')+id);assert.equal(opts.credentials,'omit');assert.equal(opts.headers.Authorization,'Bearer test');return {ok:true,json:async()=>page==='deploy'?deployment():collection()};}; c.test.set(page==='deploy'?deployment():collection());await c.test.read(); }
 });
 await test(page+' single-flight GET and terminal attach defeats old GET / closed transport',async()=>{
  const c=harness(page);c.test.set(page==='deploy'?deployment():collection()); let resolve; let gets=0;
  c.capFetch=()=>{gets++;return new Promise(r=>resolve=r);};const pending=c.test.read(); await c.test.read();assert.equal(gets,1);
  const terminal={state:'MINED',outcome:'SUCCESS',txHash:hash}; if(page==='deploy')c.test.applyResult(terminal);else c.test.applyJob(terminal);
  resolve(page==='deploy'?deployment():collection());await pending;
  c.capFetch=async()=>{throw new ApiError('TUNNEL_CLOSED',410);}; await c.test.read();
  assert.equal(c.test.state()[page==='deploy'?'job':'view']?.[page==='deploy'?'state':'job']?.state ?? c.test.state().job?.state,'MINED'); assert.equal(c.test.state().failure,null);assert.match(text(c),page==='deploy'?/部署成功/:/归集完成/);
 });
 await test(page+' lost/502 begin retains uncertainty; explicit BUSY + readback permits manual retry only',async()=>{
  for(const code of ['NETWORK_ERROR','UPSTREAM_OR_STORAGE_ERROR',page==='deploy'?'DEPLOYMENT_BUSY':'BUSY_RETRY_LATER']) {
   const c=harness(page); const base=page==='deploy'?deployment():{...collection(),job:{id:'job',state:'PREPARED',from}};c.test.set(base);
   if(page==='collect')vm.runInContext(`review={from:'${from}',rev:0}`,c);
   let begins=0;c.capFetch=async(path)=>{ if(path.endsWith('/begin')){begins++;throw new ApiError(code,code==='NETWORK_ERROR'?0:code==='UPSTREAM_OR_STORAGE_ERROR'?502:409);} return base; };
   await assert.rejects(page==='deploy'?c.test.deploy():c.test.send()); assert.equal(begins,1);assert.ok(!c.providerCalls.includes('eth_sendTransaction'));
   if(code.includes('BUSY'))assert.equal(c.test.record.get(),null);else{assert.ok(c.test.record.get());await c.test.read();assert.ok(c.test.record.get());}
  }
 });
}
await test('deployment ACK only after terminal DOM and two render frames; ACK failure preserves result',async()=>{
 const c=harness('deploy');c.test.set({...deployment(),state:'MINED',outcome:'SUCCESS'});let acks=0;
 c.capFetch=async path=>{assert.ok(path.endsWith('/ack'));assert.match(text(c),/部署成功/);acks++;throw new ApiError('NETWORK_ERROR');};c.test.render();assert.equal(acks,0);c.frames.shift()();assert.equal(acks,0);await c.frames.shift()();assert.equal(acks,1);assert.match(text(c),/部署成功/);
});
await test('collection PREPARED reload reconnects/reviews without new transaction; EMPTY cannot prepare',async()=>{
 const c=harness('collect');const v={...collection(),job:{id:'j',state:'PREPARED',from}};c.test.set(v);c.test.render();assert.match(text(c),/核对交易/);
 c.capFetch=async path=>{assert.ok(path.endsWith('/prepare'));return {job:v.job,summary:{chainId:56,from,to:factory,value:'0x0',calldataHash:hash}};};await c.test.prepareReview();assert.match(text(c),/确认归集并支付 gas/);assert.ok(!c.providerCalls.includes('eth_sendTransaction'));
 c.test.set({...collection(),state:'EMPTY'});c.test.render();assert.match(text(c),/没有可归集余额/);assert.doesNotMatch(text(c),/核对交易/);await assert.rejects(c.test.prepareReview());
});
await test('collection real attach return MINED survives closed subsequent GET and rejection recovery is API-only',async()=>{
 const c=harness('collect');c.test.set({...collection(),job:{state:'UNKNOWN',from}});c.capFetch=async()=>({state:'MINED',outcome:'PARTIAL_FAILURE',events:[{name:'CollectFailed',forwarder:from,token:factory}]});await c.test.attach(hash);assert.match(text(c),/归集部分失败/);
 c.capFetch=async()=>{throw new ApiError('TUNNEL_CLOSED',410);};await c.test.read();assert.match(text(c),/归集部分失败/);assert.equal(c.providerCalls.length,0);
 const d=harness('collect');d.test.set({...collection(),job:{state:'UNKNOWN',from}});d.test.record.set({state:'UNKNOWN',rejected:true});d.test.render();assert.match(text(d),/重试登记明确拒签/);
});
await test('checkout uses real public fields and precise PARTIAL shortfall; no demo fallback',()=>{
 const c=harness('deploy');const code=source('checkout').split('\nlet latest =')[0].replace("const root = document.getElementById('app');",'').replace("const token = location.pathname.split('/').pop();",'');
 const isolated=vm.createContext({amount:x=>String(x),units:(x,d)=>{const [a,b='']=x.split('.');return BigInt(a+b.padEnd(d,'0'));},fromUnits:(x,d)=>`${x/(10n**BigInt(d))}.${(x%(10n**BigInt(d))).toString().padStart(d,'0')}`});vm.runInContext(code,isolated);
 assert.match(vm.runInContext("customerStatus({status:'PARTIAL',expectedAmount:'1.000001',receivedAmount:'0.999999',decimals:6,symbol:'TOKEN'})[1]",isolated),/0.000002/);
 const checkout=source('checkout');assert.match(checkout,/\/api\/pay\//);assert.ok(!/catch[^]*demoView/.test(checkout));
});
for (const page of ['deploy','collect']) {
 await test(page+' real begin response shape sends once, attaches once and never re-sends MINED',async()=>{
  const c=harness(page);c.test.set(page==='deploy'?deployment():{...collection(),job:{id:'j',state:'PREPARED',from}});
  if(page==='collect')vm.runInContext(`review={from:'${from}',rev:0}`,c);
  let begins=0,attaches=0;
  c.capFetch=async(path,token,body)=>{
   if(path.endsWith('/begin')){begins++;assert.ok(c.test.record.get());return {job:{state:'UNKNOWN',from},transaction:{from,chainId:'0x38',value:'0x0',gas:'0x10000',data:'0x1234',...(page==='collect'?{to:factory}:{})}};}
   if(path.endsWith('/attach')){attaches++;assert.equal(body.transactionHash,hash);return {state:'MINED',outcome:'SUCCESS',txHash:hash};}
   throw Error('unexpected '+path);
  };
  await (page==='deploy'?c.test.deploy():c.test.send());
  assert.equal(begins,1);assert.equal(attaches,1);assert.equal(c.providerCalls.filter(x=>x==='eth_sendTransaction').length,1);
  await assert.rejects(page==='deploy'?c.test.deploy():c.test.send());assert.equal(begins,1);assert.match(text(c),page==='deploy'?/部署成功/:/归集完成/);
 });
 await test(page+' blocked persistence stops before begin or wallet send',async()=>{
  const c=harness(page);c.test.set(page==='deploy'?deployment():{...collection(),job:{id:'j',state:'PREPARED',from}});
  if(page==='collect')vm.runInContext(`review={from:'${from}',rev:0}`,c);
  c.localStorage.setItem=()=>{throw Error('quota');};c.capFetch=async()=>{assert.fail('begin must not run');};
  await assert.rejects(page==='deploy'?c.test.deploy():c.test.send());assert.ok(!c.providerCalls.includes('eth_sendTransaction'));
 });
}
const flushDeploy = () => new Promise(setImmediate);
const begunDeploy = rev => ({job:{state:'UNKNOWN',from,walletRequestRevision:rev},transaction:{from,chainId:'0x38',value:'0x0',gas:'0x10000',data:'0x1234'}});
await test('deployment hidden pending dialog permits manual retry and retains both late hashes without terminal regression',async()=>{
 const c=harness('deploy');c.test.set(deployment());const pending=[],calls=[];
 const orig=c.window.ethereum.request;c.window.ethereum.request=async r=>r.method==='eth_sendTransaction'?new Promise((resolve,reject)=>pending.push({resolve,reject})):orig(r);
 c.capFetch=async(path,_token,body)=>{calls.push({path,body});if(path.endsWith('/begin'))return begunDeploy(0);if(path.endsWith('/retry'))return begunDeploy(1);if(path.endsWith('/attach'))return {state:'MINED',outcome:'SUCCESS',txHash:hash,walletRequestRevision:1};throw Error(path);};
 const first=c.test.deploy();await flushDeploy();assert.equal(pending.length,1);assert.equal(c.test.canRetry(),true);assert.match(text(c),/重新请求钱包确认/);
 const next=c.test.retry();await flushDeploy();assert.equal(pending.length,2);pending[1].resolve(hash);await next;
 const old='0x'+'b'.repeat(64);pending[0].resolve(old);await first;
 assert.deepEqual(Array.from(c.test.record.get().hashes),[hash,old]);assert.deepEqual(calls.filter(x=>x.path.endsWith('/attach')).map(x=>x.body.requestRevision),[1,0]);
 c.test.applyResult({state:'UNKNOWN',walletRequestRevision:1});assert.equal(c.test.state().job.state,'MINED');assert.equal(c.test.canRetry(),false);
});
await test('deployment late rejection never cancels newer wallet request',async()=>{
 const c=harness('deploy');c.test.set(deployment());const pending=[],paths=[];const orig=c.window.ethereum.request;
 c.window.ethereum.request=async r=>r.method==='eth_sendTransaction'?new Promise((resolve,reject)=>pending.push({resolve,reject})):orig(r);
 c.capFetch=async path=>{paths.push(path);if(path.endsWith('/begin'))return begunDeploy(0);if(path.endsWith('/retry'))return begunDeploy(1);if(path.endsWith('/attach'))return {state:'MINED',outcome:'SUCCESS',txHash:hash,walletRequestRevision:1};throw Error(path);};
 const first=c.test.deploy();await flushDeploy();const next=c.test.retry();await flushDeploy();pending[0].reject(Object.assign(Error('old rejection'),{code:4001}));await first;
 assert.equal(paths.filter(p=>p.endsWith('/reject')).length,0);assert.equal(c.test.state().job.state,'UNKNOWN');pending[1].resolve(hash);await next;
});
await test('deployment rejection keeps phone open and retries same job without ACK or new begin',async()=>{
 const c=harness('deploy');c.test.set(deployment());let sends=0;const paths=[],orig=c.window.ethereum.request;
 c.window.ethereum.request=async r=>{if(r.method==='eth_sendTransaction'){if(++sends===1)throw Object.assign(Error('reject'),{code:4001});return hash;}return orig(r);};
 c.capFetch=async(path,_token,body)=>{paths.push(path);if(path.endsWith('/begin'))return begunDeploy(0);if(path.endsWith('/reject')){assert.equal(body.requestRevision,0);return {state:'CANCELLED',outcome:'REJECTED',from,walletRequestRevision:0};}if(path.endsWith('/retry'))return begunDeploy(1);if(path.endsWith('/attach'))return {state:'MINED',outcome:'SUCCESS',txHash:hash,walletRequestRevision:1};throw Error(path);};
 await c.test.deploy();assert.equal(c.test.canRetry(),true);assert.match(text(c),/重新请求钱包确认/);assert.equal(c.frames.length,0);
 await c.test.retry();assert.equal(sends,2);assert.equal(paths.filter(p=>p.endsWith('/begin')).length,1);
});
await test('deployment known hash, expiry and different original sender prevent retry; RPC failure never auto-retries',async()=>{
 for(const mode of ['txHash','candidateHash','expired','wrongSender','localHash']){
  const c=harness('deploy'),v={...deployment(),...begunDeploy(0).job};if(['txHash','candidateHash'].includes(mode))v[mode]=hash;if(mode==='expired')v.expiresAt=Date.now()-1;if(mode==='wrongSender')v.from=factory;c.test.set(v);
  if(mode==='localHash')c.test.record.set({state:'UNKNOWN',hash});let calls=0;c.capFetch=async()=>{calls++;throw Error('unexpected');};await c.test.retry();assert.equal(calls,0);assert.ok(!c.providerCalls.includes('eth_sendTransaction'));
 }
 const c=harness('deploy');c.test.set({...deployment(),...begunDeploy(0).job});let calls=0;c.capFetch=async()=>{calls++;throw new ApiError('NETWORK_ERROR');};await c.test.retry();assert.equal(calls,1);assert.ok(!c.providerCalls.includes('eth_sendTransaction'));
});
await test('deployment hash arriving during retry preflight suppresses dispatch; repeated clicks remain single flight',async()=>{
 const c=harness('deploy');c.test.set({...deployment(),...begunDeploy(0).job});let release,calls=0;
 c.capFetch=async()=>{calls++;return new Promise(r=>release=r);};const next=c.test.retry();await flushDeploy();await c.test.retry();assert.equal(calls,1);
 c.test.record.set({state:'UNKNOWN',hash});release(begunDeploy(1));await next;assert.ok(!c.providerCalls.includes('eth_sendTransaction'));
});
await test('deployment delayed original wallet preflight cannot dispatch after newer retry succeeds',async()=>{
 const c=harness('deploy');c.test.set(deployment());let accounts=0,release,sends=0;const orig=c.window.ethereum.request;
 c.window.ethereum.request=async r=>{if(r.method==='eth_accounts'&&++accounts===2)return new Promise(resolve=>release=resolve);if(r.method==='eth_sendTransaction')sends++;return orig(r);};
 c.capFetch=async path=>path.endsWith('/begin')?begunDeploy(0):path.endsWith('/retry')?begunDeploy(1):{state:'MINED',outcome:'SUCCESS',txHash:hash,walletRequestRevision:1};
 const first=c.test.deploy();await flushDeploy();assert.equal(sends,0);await c.test.retry();assert.equal(sends,1);release([from]);await first;assert.equal(sends,1);
});
const collectTx = () => ({from,to:factory,chainId:'0x38',value:'0x0',data:'0x1234'});
const begunCollect = revision => ({job:{id:'j',state:'UNKNOWN',error:'WALLET_CONFIRMATION_PENDING',from,walletRequestRevision:revision},transaction:collectTx()});
const settle = () => new Promise(setImmediate);
await test('collection hidden pending dialog permits explicit retry; both late hashes retained with request revisions',async()=>{
 const c=harness('collect');c.test.set({...collection(),job:{id:'j',state:'PREPARED',from}});vm.runInContext(`review={from:'${from}',rev:0}`,c);
 const resolvers=[],apiCalls=[];c.window.confirm=()=>assert.fail('no extra confirmation dialog');
 const original=c.window.ethereum.request;c.window.ethereum.request=async req=>req.method==='eth_sendTransaction'?new Promise(resolve=>resolvers.push(resolve)):original(req);
 c.capFetch=async(path,_token,body)=>{apiCalls.push({path,body});if(path.endsWith('/begin'))return begunCollect(0);if(path.endsWith('/retry'))return begunCollect(1);if(path.endsWith('/attach'))return {state:'MINED',outcome:'SUCCESS',from,txHash:hash,walletRequestRevision:1};throw Error(path);};
 const first=c.test.send();await settle();assert.equal(resolvers.length,1);assert.equal(c.test.canRetry(),true);assert.match(text(c),/重新请求钱包确认/);
 const retry=c.test.retry();await settle();assert.equal(resolvers.length,2);assert.equal(apiCalls.filter(x=>x.path.endsWith('/retry')).length,1);
 resolvers[1](hash);await retry;const oldHash='0x'+'b'.repeat(64);resolvers[0](oldHash);await first;
 assert.deepEqual(Array.from(c.test.record.get().hashes),[hash,oldHash]);
 assert.deepEqual(apiCalls.filter(x=>x.path.endsWith('/attach')).map(x=>x.body.requestRevision),[1,0]);assert.equal(c.test.canRetry(),false);
});
await test('collection explicit rejection exposes retry and never creates a new prepare/begin job',async()=>{
 const c=harness('collect');c.test.set({...collection(),job:{id:'j',state:'PREPARED',from}});vm.runInContext(`review={from:'${from}',rev:0}`,c);
 let sends=0;const original=c.window.ethereum.request;c.window.ethereum.request=async req=>{if(req.method==='eth_sendTransaction'){sends++;if(sends===1)throw Object.assign(Error('rejected'),{code:4001});return hash;}return original(req);};
 const paths=[];c.capFetch=async(path,_token,body)=>{paths.push(path);if(path.endsWith('/begin'))return begunCollect(0);if(path.endsWith('/reject')){assert.equal(body.requestRevision,0);return {id:'j',state:'CANCELLED',error:'USER_REJECTED',from};}if(path.endsWith('/retry'))return begunCollect(1);if(path.endsWith('/attach'))return {state:'MINED',outcome:'SUCCESS',txHash:hash};throw Error(path);};
 await c.test.send();assert.equal(c.test.canRetry(),true);assert.match(text(c),/重新请求钱包确认/);await c.test.retry();assert.equal(sends,2);assert.equal(paths.filter(p=>p.endsWith('/begin')).length,1);assert.equal(paths.filter(p=>p.endsWith('/prepare')).length,0);
});
await test('collection repeat clicks during retry preflight dispatch only once',async()=>{
 const c=harness('collect');c.test.set({...collection(),job:begunCollect(0).job});let resolve,begins=0;
 c.capFetch=async path=>{if(path.endsWith('/retry')){begins++;return new Promise(r=>resolve=r);}return {state:'MINED',outcome:'SUCCESS',txHash:hash};};
 const pending=c.test.retry();await settle();await c.test.retry();assert.equal(begins,1);assert.ok(!c.providerCalls.includes('eth_sendTransaction'));resolve(begunCollect(1));await pending;assert.equal(c.providerCalls.filter(x=>x==='eth_sendTransaction').length,1);
});
await test('collection late old rejection cannot cancel newer pending request',async()=>{
 const c=harness('collect');c.test.set({...collection(),job:{id:'j',state:'PREPARED',from}});vm.runInContext(`review={from:'${from}',rev:0}`,c);
 const pending=[],paths=[];const original=c.window.ethereum.request;c.window.ethereum.request=async req=>req.method==='eth_sendTransaction'?new Promise((resolve,reject)=>pending.push({resolve,reject})):original(req);
 c.capFetch=async path=>{paths.push(path);if(path.endsWith('/begin'))return begunCollect(0);if(path.endsWith('/retry'))return begunCollect(1);if(path.endsWith('/attach'))return {state:'MINED',outcome:'SUCCESS',txHash:hash};throw Error(path);};
 const first=c.test.send();await settle();const second=c.test.retry();await settle();pending[0].reject(Object.assign(Error('old reject'),{code:4001}));await first;
 assert.equal(paths.filter(x=>x.endsWith('/reject')).length,0);assert.equal(c.test.state().view.job.state,'UNKNOWN');pending[1].resolve(hash);await second;
});
await test('collection retry with authoritative known result never calls wallet again',async()=>{
 const c=harness('collect');c.test.set({...collection(),job:begunCollect(0).job});c.capFetch=async()=>({job:{state:'MINED',outcome:'SUCCESS',txHash:hash},transaction:null});await c.test.retry();assert.ok(!c.providerCalls.includes('eth_sendTransaction'));assert.match(text(c),/归集完成/);
});
await test('collection known hash / expiry / wrong sender prevent retry dispatch; no automatic network retry',async()=>{
 for(const mode of ['txHash','candidateHash','expired','wrongSender']){
  const c=harness('collect');const v={...collection(),job:{...begunCollect(0).job,...(['txHash','candidateHash'].includes(mode)?{[mode]:hash}:{})}};
  if(mode==='expired')v.expiresAt=Date.now()-1;if(mode==='wrongSender')v.job.from=factory;c.test.set(v);let calls=0;c.capFetch=async()=>{calls++;throw new ApiError('UPSTREAM_OR_STORAGE_ERROR',502);};await c.test.retry();assert.equal(calls,0);assert.ok(!c.providerCalls.includes('eth_sendTransaction'));
 }
 const c=harness('collect');c.test.set({...collection(),job:begunCollect(0).job});let calls=0;c.capFetch=async()=>{calls++;throw new ApiError('UPSTREAM_OR_STORAGE_ERROR',502);};await c.test.retry();await settle();assert.equal(calls,1);assert.ok(!c.providerCalls.includes('eth_sendTransaction'));
});
await test('collection original hash arriving during retry preflight suppresses the new wallet request',async()=>{
 const c=harness('collect');c.test.set({...collection(),job:begunCollect(0).job});
 c.capFetch=async()=>{c.test.record.set({state:'UNKNOWN',hash});return begunCollect(1);};
 await c.test.retry();assert.equal(c.providerCalls.filter(x=>x==='eth_sendTransaction').length,0);assert.equal(c.test.record.get().hash,hash);
});
await test('collection delayed original preflight cannot dispatch after a newer manual request',async()=>{
 const c=harness('collect');c.test.set({...collection(),job:{id:'j',state:'PREPARED',from}});vm.runInContext(`review={from:'${from}',rev:0}`,c);
 let accounts=0,release,sends=0;const original=c.window.ethereum.request;
 c.window.ethereum.request=async req=>{if(req.method==='eth_accounts' && ++accounts===2)return new Promise(r=>release=r);if(req.method==='eth_sendTransaction')sends++;return original(req);};
 c.capFetch=async path=>path.endsWith('/begin')?begunCollect(0):path.endsWith('/retry')?begunCollect(1):{state:'MINED',outcome:'SUCCESS',txHash:hash};
 const pending=c.test.send();await settle();assert.equal(sends,0);await c.test.retry();assert.equal(sends,1);release([from]);await pending;assert.equal(sends,1);
});
console.log(`RESULT ${passed} isolated source simulations passed; not physical-phone or live-wallet acceptance.`);
