// Execute the actual admin client wrapper without network, ports, or merchant data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read = file => fs.readFileSync(new URL('src/' + file, import.meta.url), 'utf8');
const strip = s => s.replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
async function fixture() {
  let failure;
  const names = ['overviewPage','ordersPage','collectPage','chainsPage','notificationsPage','integrationPage','settingsPage'];
  const context = vm.createContext({ navigator: { onLine: true }, document: { getElementById: () => ({}), addEventListener() {} }, window: { addEventListener() {} }, location: { hash: '#/settings' }, setInterval() {}, installLanguageSupport() {}, clearAuthUI() {}, needsRecovery: () => false,
    ...Object.fromEntries(names.map(name => [name, () => null])),
    liveClient: () => ({ post: async () => { throw failure; } }) });
  // The API module supplies only its real request sequencer, not its HTTP client.
  const api = strip(read('shared/api.js')).replace('function liveClient()', 'function unusedLiveClient()');
  const main = strip(read('admin/main.js')).replace(/\nboot\(\);\s*$/, '');
  vm.runInContext(api + '\n' + main + '\nrender=()=>{};bootData=async()=>{};globalThis.subject={app,state,boot};', context);
  const f=context.subject; await f.boot(); f.app.setAuth('in');
  return { ...f, fail(code) { failure=Object.assign(new Error(code),{status:401,code}); } };
}

test('wrong password during reauthentication keeps the cookie session and dialog owner', async () => {
  const f=await fixture(); f.fail('UNAUTHORIZED');
  for (const route of ['auth/api-key','auth/recovery-key','auth/password']) {
    await assert.rejects(f.state.client.post(route, {}), {code:'UNAUTHORIZED'});
    assert.equal(f.state.auth,'in');
  }
});

test('actually expired credential-management session is cleared', async () => {
  const f=await fixture(); f.fail('SESSION_REQUIRED');
  await assert.rejects(f.state.client.post('auth/api-key', {}), {code:'SESSION_REQUIRED'});
  assert.equal(f.state.auth,'out');
});

test('business API unauthorized still clears the logged-in view', async () => {
  const f=await fixture(); f.fail('UNAUTHORIZED');
  await assert.rejects(f.state.client.post('wallet/config', {}), {code:'UNAUTHORIZED'});
  assert.equal(f.state.auth,'out');
});
