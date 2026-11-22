// Focused isolated checks. No server, RPC, database, keychain or real wallet.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { build } from 'esbuild';
const dir = new URL('./src/admin/', import.meta.url);
const source = await fs.readFile(new URL('transaction.js', dir), 'utf8');
const { createAttempt } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const hash = '0x' + 'ab'.repeat(32);
let checks = 0;
function fixture({ beginError, sendError, attachError, preflightError, saveError } = {}) {
  const events = [], records = [];
  const scope = { deploymentId: 'ORIGINAL' };
  const client = { async post(route, body, opts) {
    assert.equal(opts, scope); events.push(route.split('/').at(-1));
    if (route.endsWith('/begin')) { if (beginError) throw beginError; return { job: { state: 'UNKNOWN' }, transaction: { data: '0x1234' } }; }
    if (route.endsWith('/attach')) { assert.equal(body.transactionHash, hash); if (attachError) throw attachError; return { state: 'SUBMITTED' }; }
    return { state: 'CANCELLED' };
  } };
  const attempt = createAttempt({ client, route: 'wallet/jobs/test', scope, from: 'sender', save: value => { records.push(value); if (saveError && value.hash) throw Error('quota'); }, remove: () => events.push('remove'),
    sender: async () => { events.push('preflight'); if (preflightError) throw preflightError; return async () => { events.push('send'); if (sendError) throw sendError; return hash; }; } });
  return { attempt, events, records };
}
{
  const f = fixture(); assert.equal((await f.attempt()).state, 'SUBMITTED');
  assert.deepEqual(f.events, ['begin', 'preflight', 'send', 'attach', 'remove']);
  assert.equal(f.records[0].phase, 'BEGIN_UNKNOWN'); assert.equal(f.records[1].hash, hash);
  await assert.rejects(f.attempt()); assert.equal(f.events.filter(x => x === 'send').length, 1); checks++;
}
for (const options of [{ beginError: Error('response lost') }, { sendError: Error('disconnected') }, { preflightError: Object.assign(Error('account change'), { code: 4001 }) }]) {
  const f = fixture(options); await assert.rejects(f.attempt());
  assert(!f.events.includes('cancel')); assert(!f.events.includes('attach'));
  if (options.beginError || options.preflightError) assert(!f.events.includes('send'));
  await assert.rejects(f.attempt()); checks++;
}
{
  const f = fixture({ sendError: Object.assign(Error('rejected'), { code: 4001 }) }); await assert.rejects(f.attempt());
  assert.deepEqual(f.events, ['begin', 'preflight', 'send', 'cancel', 'remove']); checks++;
}
{
  const f = fixture({ attachError: Error('offline') }); await assert.rejects(f.attempt());
  assert.equal(f.records.at(-1).hash, hash); assert(!f.events.includes('remove')); await assert.rejects(f.attempt()); checks++;
}
{
  const f = fixture({ saveError: true }); await f.attempt(); assert(f.events.includes('attach')); checks++;
}
// Execute the actual wallet adapter using SDK/DOM/provider doubles.
const walletSource = (await fs.readFile(new URL('wallet.js', dir), 'utf8')).replace(/^import .*;\n/gm, '').replaceAll('export ', '');
let accounts = ['0x' + '11'.repeat(20)], chain = 97, sends = 0;
const handlers = {};
const injected = { async request({ method }) { if (method === 'eth_accounts') return accounts; if (method === 'eth_chainId') return '0x' + chain.toString(16); if (method === 'eth_sendTransaction') { sends++; return hash; } return accounts; }, on(event, fn) { handlers[event] = fn; } };
const dialogs = [];
const sandbox = { window: { ethereum: injected }, URL, location: { origin: 'https://merchant.invalid' }, setTimeout, clearTimeout,
  h: (...args) => args, openDialog: config => { const d = { setBody() {}, close() { config.onClose?.(); }, config }; dialogs.push(d); return d; },
  QRCode: { async toCanvas() {} }, UniversalProvider: {} };
vm.createContext(sandbox);
vm.runInContext(walletSource + '\nglobalThis.adapter = { connectWallet, walletSender, metadata, validateTransaction };', sandbox);
const a = sandbox.adapter;
const config = { chainId: 97, nativeSymbol: 'BNB', rpcUrl: 'https://rpc.invalid', factory: '0x' + '22'.repeat(20), verifiedDeployment: true };
// Custom EVM chains (including formerly privileged test IDs) need the same
// deployment verification as every other chain.
for (const chainId of [1, 56, 97, 11155111, 31337, 654321]) {
  await assert.rejects(a.connectWallet('injected', { ...config, chainId, verifiedDeployment: false }), /目标部署尚未核验/);
  checks++;
}
assert.equal(a.metadata({ chainId: 654321, chainName: 'Custom EVM', nativeSymbol: 'GAS' }).symbol, 'GAS'); checks++;
chain = 654321;
assert.equal((await a.connectWallet('injected', { ...config, chainId: chain, nativeSymbol: 'GAS' })).chainId, chain); checks++;
// New deployments have no Factory yet: the explicit deployment workflow may
// connect a real wallet without weakening collection's verified-Factory gate.
assert.equal((await a.connectWallet('injected', { ...config, chainId: chain, nativeSymbol: 'GAS', verifiedDeployment: false, allowDeployment: true })).chainId, chain); checks++;
chain = 97;
const expected = await a.connectWallet('injected', config);
const tx = { from: accounts[0], to: config.factory, chainId: '0x61', value: '0x0', data: '0x1234', gas: '0x10000' };
await (await a.walletSender(tx, expected, config, false))(); assert.equal(sends, 1); checks++;
for (const bad of [{ ...tx, nonce: '0x0' }, { ...tx, to: accounts[0] }, { ...tx, chainId: '0x1' }, { ...tx, value: '0x1' }]) assert.throws(() => a.validateTransaction(bad, expected, config, false));
assert.throws(() => a.validateTransaction(tx, expected, config, true)); checks++;
assert.equal(a.metadata({ chainId: 137, nativeSymbol: 'ETH' }).symbol, 'POL'); checks++;
const pendingSend = await a.walletSender(tx, expected, config, false);
handlers.accountsChanged(); assert.throws(pendingSend); assert.equal(sends, 1); checks++;
// Cancellation rejects promptly, and a late WalletConnect session is disconnected.
let resolveConnect, disconnects = 0;
const wc = { on() {}, removeListener() {}, request: injected.request, connect: () => new Promise(resolve => { resolveConnect = resolve; }), async disconnect() { disconnects++; } };
sandbox.UniversalProvider.init = async () => wc;
const connecting = a.connectWallet('walletconnect', { ...config, projectId: 'a'.repeat(32) });
await new Promise(setImmediate); dialogs.at(-1).config.onClose();
await assert.rejects(connecting); resolveConnect(); await new Promise(setImmediate); assert(disconnects >= 1); checks++;
// Execute the actual desktop orchestration: prepare is review-only; changing the
// selected dropdown before confirmation must not redirect begin/attach.
{
  const desktopSource = (await fs.readFile(new URL('desktop-flow.js', dir), 'utf8')).replace(/^import .*;\n/gm, '').replaceAll('export ', '');
  const events = [], scopes = [], cache = {};
  const { keccak256 } = await import('ethers');
  const node = (tag, attrs, ...children) => ({ tag, attrs, children });
  const s = { address: accounts[0], chainId: 97, revision: 1 };
  let preparation = 'mixed';
  const api = { async get(route, scope) { scopes.push(scope.deploymentId); return { ...config, payout: accounts[0] }; }, async post(route, body, scope) {
    scopes.push(scope.deploymentId); events.push(route.split('/').at(-1));
    if (route === 'wallet/prepare') {
      if (preparation === 'held') throw Object.assign(Error('still awaiting original transaction'), { code: 'TRANSACTION_RECONCILIATION_REQUIRED' });
      if (preparation === 'empty') return { job: null, heldCount: 0 };
      return { heldCount: 1, job: { id: 'J', orderIds: ['APPROVED'], state: 'PREPARED' }, summary: { chainId: 97, from: s.address, to: config.factory, value: '0x0', calldataHash: keccak256('0x1234') } };
    }
    if (route.endsWith('/begin')) return { job: { state: 'UNKNOWN' }, transaction: tx };
    return { state: 'SUBMITTED' };
  } };
  const dialog = () => ({ closed: false, setTitle() {}, setBody(...nodes) { this.body = nodes; }, setFoot(...nodes) { this.foot = nodes; }, close() { this.closed = true; } });
  const d = dialog();
  const app = { client: api, state: { mode: 'live', selectedId: 'ORIGINAL' }, refresh() {}, refreshDeployments() {} };
  const context = { h: node, notice: node, kv: node, copyable: node, keccak256, createAttempt,
    connectWallet: async () => s, assertWallet: async () => {}, walletSender: async () => async () => { events.push('send'); return hash; }, metadata: () => ({ name: 'BSC Testnet', symbol: 'BNB' }),
    recoveryStore: key => ({ save: r => { cache[key] = r; }, remove: () => { delete cache[key]; } }), readRecovery: () => cache,
    errorMessage: e => e.message, toast() {}, setInterval: () => 1, clearInterval() {} };
  vm.createContext(context); vm.runInContext(desktopSource + '\nglobalThis.flow = { desktopFlow, desktopBusy };', context);
  await context.flow.desktopFlow(app, d, { kind: 'injected', deploymentId: 'ORIGINAL', intent: { mode: 'paid', orderIds: ['APPROVED'] } });
  assert.deepEqual(events, ['prepare']); assert(context.flow.desktopBusy());
  assert.match(JSON.stringify(d.body), /部分订单仍在等原交易核对/);
  app.state.selectedId = 'OTHER';
  const sendButton = d.foot.at(-1); const click = { currentTarget: { disabled: false } };
  await Promise.all([sendButton.attrs.onclick(click), sendButton.attrs.onclick(click)]);
  assert.deepEqual(events, ['prepare', 'begin', 'send', 'attach']); assert(scopes.every(id => id === 'ORIGINAL')); assert(!context.flow.desktopBusy()); checks++;
  for (const [mode, expected, unexpected] of [['held', /still awaiting original transaction/, /没有可归集余额/], ['empty', /没有可归集余额/, /still awaiting original transaction/]]) {
    preparation = mode;
    const result = dialog();
    await context.flow.desktopFlow(app, result, { kind: 'injected', deploymentId: 'ORIGINAL', intent: { mode: 'paid', orderIds: ['APPROVED'] } });
    assert.match(JSON.stringify(result.body), expected); assert.doesNotMatch(JSON.stringify(result.body), unexpected);
    assert.equal(events.filter(e => e === 'send').length, 1); assert(!context.flow.desktopBusy()); checks++;
  }
}
// Explicit pre-transition BUSY is bounded, and only a successful unchanged
// PREPARED readback clears uncertainty. No wallet send can happen here.
{
  let calls = 0, removed = false;
  const attempt = createAttempt({ client: { async post() { calls++; throw Object.assign(Error('busy'), { code: 'BUSY_RETRY_LATER', status: 409 }); }, async get() { return [{ id: 'busy', state: 'PREPARED' }]; } }, route: 'wallet/jobs/busy', scope: { deploymentId: 'ORIGINAL' }, from: accounts[0], sender: () => { throw Error('must not send'); }, save() {}, remove() { removed = true; } });
  await assert.rejects(attempt); assert.equal(calls, 4); assert(removed); checks++;
}
// Resolve every real import and syntax-check the actual entry in memory only.
const result = await build({ entryPoints: [new URL('main.js', dir).pathname], bundle: true, loader: { '.svg': 'text' }, write: false, format: 'iife', platform: 'browser', logLevel: 'silent' });
assert(result.outputFiles[0].contents.length > 1000); checks++;
console.log(`PASS ${checks} isolated admin wallet/state-machine checks; in-memory entry bundle resolved. No real transactions or live state accessed.`);
