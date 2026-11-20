import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source=(await fs.readFile(new URL('./src/admin/pages/chains.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replaceAll('export ','');
const apiSource=await fs.readFile(new URL('./src/shared/api.js',import.meta.url),'utf8');
const {liveClient}=await import('data:text/javascript;base64,'+Buffer.from(apiSource).toString('base64'));
const uiSource=(await fs.readFile(new URL('./src/admin/ui.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replaceAll('export ','');
const ui=vm.createContext({});vm.runInContext(uiSource+'\nglobalThis.busyExport=busy;',ui);
const flatten=nodes=>nodes.flatMap(n=>n&&typeof n==='object'?[n,...flatten(n.children||[])]:[]);
function fixture(){
  const h=(tag,attrs,...children)=>{const classes=new Set();return {tag,attrs:attrs||{},value:attrs?.value||'',children:children.flat(Infinity).filter(n=>n!=null),focus(){this.focused=true;},classList:{contains:key=>classes.has(key),add:key=>classes.add(key),remove:key=>classes.delete(key)}};};
  const d={closed:false,setBody(...n){this.body=n},setFoot(...n){this.foot=n},close(){this.closed=true}};
  const deployment={id:'legacy',name:'原名称',factory:'0x'+'11'.repeat(20),payout:'0x'+'22'.repeat(20),chainId:97};
  const app={state:{selectedId:'OTHER',deployments:[deployment,{...deployment,id:'OTHER',name:'已有名称'}]},client:liveClient(),renders:0,refreshes:0,render(){this.renders++},async refreshDeployments(){this.refreshes++}};
  const context=vm.createContext({h,field:(label,input)=>h('field',{label},input),openDialog:()=>d,busy:ui.busyExport,toast(){},errorMessage:e=>e.code||e.message});
  vm.runInContext(source+'\nglobalThis.open=openRenameDeployment;',context);context.open(app,deployment);
  return {app,d,input:flatten(d.body).find(n=>n.tag==='input'),error:flatten(d.body).find(n=>n.attrs?.role==='alert'),save:()=>d.foot.at(-1).attrs.onclick(),cancel:()=>d.foot[0].attrs.onclick()};
}
const withFetch=async(fake,fn)=>{const saved=globalThis.fetch;globalThis.fetch=fake;try{await fn()}finally{globalThis.fetch=saved}};

test('custom dialog prefills name, uses real global client, trims, single-flights, and updates the captured deployment only',()=>{
  let finish,calls=0;
  return withFetch((url,opts)=>{calls++;assert.equal(url,'/api/deployments/legacy/name');assert.equal(opts.credentials,'same-origin');assert.equal(opts.headers['X-Upay-Deployment'],undefined);assert.deepEqual(JSON.parse(opts.body),{name:'已有名称'});return new Promise(resolve=>{finish=()=>resolve(new Response(JSON.stringify({id:'legacy',name:'已有名称'})))});},async()=>{
    const f=fixture();assert.equal(f.input.value,'原名称');
    const identities=JSON.stringify(f.app.state.deployments.map(({name,...rest})=>rest));
    f.input.value='  已有名称  ';const first=f.save(),second=f.save();
    assert.equal(calls,1);assert.equal(f.input.disabled,true);assert.equal(f.d.foot.at(-1).textContent,'保存中…');
    finish();await Promise.all([first,second]);
    assert.equal(f.d.closed,true);assert.equal(f.app.state.deployments[0].name,'已有名称');assert.equal(f.app.state.selectedId,'OTHER');
    assert.equal(f.app.refreshes,1);assert.equal(f.app.renders,1);
    assert.equal(JSON.stringify(f.app.state.deployments.map(({name,...rest})=>rest)),identities);
  });
});
test('empty/overlong names stay in the dialog, cancel does not write, and no native prompt is used',()=>withFetch(()=>assert.fail('Must not fetch'),async()=>{
  assert(!/\bprompt\s*\(/.test(source));
  const f=fixture();for(const name of ['  ','x'.repeat(129)]){f.input.value=name;await f.save();assert.match(f.error.textContent,/名称不能为空/);assert.equal(f.d.closed,false)}
  f.cancel();assert.equal(f.d.closed,true);assert.equal(f.app.state.deployments[0].name,'原名称');
}));
test('save failures stay inline, preserve the draft and re-enable input without changing state',()=>withFetch(async()=>new Response(JSON.stringify({error:'SAVE_FAILED'}),{status:500}),async()=>{
  const f=fixture();f.input.value='新名称';await f.save();
  assert.equal(f.error.textContent,'SAVE_FAILED');assert.equal(f.d.closed,false);assert.equal(f.input.value,'新名称');assert.equal(f.input.disabled,false);assert.equal(f.d.foot.at(-1).disabled,false);assert.equal(f.app.renders,0);
}));
