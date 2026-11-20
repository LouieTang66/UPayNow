// Isolated actual-source tests: no network, wallet, user state or server writes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { build } from 'esbuild';
import * as ethers from 'ethers';
const root = new URL('./src/', import.meta.url);
async function load(file, exports, dependencies = {}) {
  const text = (await fs.readFile(new URL(file, root), 'utf8')).replace(/^import .*;\n/gm, '').replaceAll('export ', '');
  const c = vm.createContext({ ...ethers, ...dependencies, console, setTimeout, URL, setInterval: () => 1, clearInterval() {} });
  vm.runInContext(text + '\nglobalThis.result = {' + exports.join(',') + '}', c);
  return c.result;
}
const dg = await load('shared/deployment-guard.js', ['deterministic', 'bootstrap', 'deterministicStage', 'assertDeploymentSender', 'validateDeploymentTransaction']);
const rg = await load('shared/recovery-guard.js', ['assertRecoveryContext', 'validateRecoveryPreview', 'validateRecoveryJob']);
const { createAttempt } = await load('admin/transaction.js', ['createAttempt']);
const A = '0x' + '11'.repeat(20), B = '0x' + '22'.repeat(20), T = '0x' + '33'.repeat(20);
const singleton = '0xce0042B868300000d44A59004Da54A005ffdcf9f';
const salt = ethers.id('upaynow:deterministic-deployer:v2'), code = '0x60006000';
const deployer = ethers.getCreate2Address(singleton, salt, ethers.keccak256(code));
let checks = 0;
const ok = fn => { fn(); checks++; };
const rejects = fn => ok(() => assert.throws(fn));
const expected = { address: A, chainId: 56 };
const summary = { scheme: 'deterministic-v2', stage: 'merchant', chainId: 56, payout: A, deployer, predictedFactory: B, tokens: [{ address: T }] };
const job = { id: 'deploy', summary };
const abi = new ethers.Interface(['function deploy(address payout,address[] tokens) returns(address)']);
const tx = { from: A, to: deployer, chainId: '0x38', value: '0x0', gas: '0x10000', data: abi.encodeFunctionData('deploy', [A, [T]]) };
ok(() => assert.equal(dg.deterministic({}), false));
ok(() => dg.validateDeploymentTransaction(tx, expected, job));
for (const bad of [{ to: B }, { from: B }, { chainId: '0x1' }, { value: '0x1' }, { nonce: '0x1' }, { data: '0x1234' }, { data: abi.encodeFunctionData('deploy', [B, [T]]) }, { data: abi.encodeFunctionData('deploy', [A, [B]]) }]) rejects(() => dg.validateDeploymentTransaction({ ...tx, ...bad }, expected, job));
rejects(() => dg.validateDeploymentTransaction(tx, expected, job, { ...tx, data: '0x1234' }));
rejects(() => dg.assertDeploymentSender(job, B));
ok(() => dg.assertDeploymentSender({ summary: { payout: A } }, B));
const boot = { summary: { ...summary, stage: 'bootstrap' } };
const bootABI = new ethers.Interface(['function deploy(bytes initCode,bytes32 salt) returns(address)']);
const bootTx = { ...tx, to: singleton, data: bootABI.encodeFunctionData('deploy', [code, salt]) };
ok(() => dg.validateDeploymentTransaction(bootTx, expected, boot));
for (const bad of [{ to: deployer }, { data: bootABI.encodeFunctionData('deploy', ['0x60016000', salt]) }, { data: bootABI.encodeFunctionData('deploy', [code, ethers.ZeroHash]) }, { data: bootTx.data + '00' }]) rejects(() => dg.validateDeploymentTransaction({ ...bootTx, ...bad }, expected, boot));
rejects(() => dg.validateDeploymentTransaction(tx, expected, { summary: { chainId: 56 } }));
ok(() => dg.validateDeploymentTransaction(Object.fromEntries(Object.entries(tx).filter(([k]) => k !== 'to')), expected, { summary: { chainId: 56 } }));
const preview = { scheme: 'deterministic-v2', singleton, deployer, factory: B, payout: A, singletonReady: true, deployerReady: false };
rejects(() => dg.deterministicStage(preview));
ok(() => assert.equal(dg.deterministicStage({ ...preview, deployerReady: true }), 'merchant'));
rejects(() => dg.deterministicStage({ ...preview, singletonReady: false }));
rejects(() => dg.deterministicStage({ ...preview, scheme: 'legacy-v1' }));
const target = Object.freeze({ id: 'TARGET', scheme: 'deterministic-v2', chainId: 56, factory: B, payout: A });
const request = Object.freeze({ sourceDeploymentId: 'SOURCE', targetDeploymentId: 'TARGET', orderId: 'ORDER-A', token: ethers.ZeroAddress });
const order = Object.freeze({ id: 'ORDER-A', orderHash: ethers.id('order'), address: T, status: 'WAITING' });
const context = Object.freeze({ request, target });
const recPreview = { ...request, orderHash: order.orderHash, address: T, chainId: 56, payout: A, token: ethers.ZeroAddress, balanceUnits: '100', decimals: 18, symbol: 'BNB' };
const app = { state: { selectedId: 'SOURCE', deployments: [target] } };
ok(() => rg.assertRecoveryContext(app, context));
ok(() => rg.validateRecoveryPreview(recPreview, request, order, target));
for (const bad of [{ sourceDeploymentId: 'TARGET' }, { targetDeploymentId: 'SOURCE' }, { orderId: 'OTHER' }, { orderHash: ethers.ZeroHash }, { address: B }, { token: T }, { payout: B }, { chainId: 1 }, { decimals: 100 }, { balanceUnits: '-1' }]) rejects(() => rg.validateRecoveryPreview({ ...recPreview, ...bad }, request, order, target));
app.state.selectedId = 'TARGET'; rejects(() => rg.assertRecoveryContext(app, context)); app.state.selectedId = 'SOURCE';
app.state.deployments = [{ ...target, factory: T }]; rejects(() => rg.assertRecoveryContext(app, context)); app.state.deployments = [target];
const recoveryJob = { id: 'RECOVERY', chainId: 56, factory: B, recoveryOnly: true, recovery: recPreview, orderIds: ['virtual-order'], state: 'PREPARED' };
ok(() => rg.validateRecoveryJob(recoveryJob, context, 'TARGET'));
rejects(() => rg.validateRecoveryJob(recoveryJob, context, 'SOURCE'));
rejects(() => rg.validateRecoveryJob({ ...recoveryJob, recoveryOnly: false }, context, 'TARGET'));

// Exercise actual desktop one-send with the dedicated prepare route and captured target header.
async function flowFixture({ changeSelection = false, changeDuringBegin = false, loseAttach = false } = {}) {
  const events = [], records = {}, scopes = [];
  const state = { selectedId: 'SOURCE', deployments: [target] };
  const localApp = { state, refresh() {}, refreshDeployments() {}, client: {
    async get(route, scope) { scopes.push(scope.deploymentId); return { ...target, rpcUrl: 'https://rpc.invalid', nativeSymbol: 'BNB', verifiedDeployment: true }; },
    async post(route, body, scope) {
      events.push(route); scopes.push(scope?.deploymentId || 'GLOBAL');
      if (route === 'crosschain-recovery/prepare') { assert.equal(body.orderId, 'ORDER-A'); return { deploymentId: 'TARGET', job: recoveryJob, summary: { chainId: 56, from: A, to: B, value: '0x0', calldataHash: ethers.keccak256('0x1234') } }; }
      if (route.endsWith('/begin')) { if (changeDuringBegin) state.selectedId = 'TARGET'; return { job: { ...recoveryJob, state: 'UNKNOWN' }, transaction: { ...tx, to: B, data: '0x1234' } }; }
      if (route.endsWith('/attach')) { if (loseAttach) throw Error('offline'); return { state: 'MINED', outcome: 'SUCCESS' }; }
      return { state: 'CANCELLED' };
    }
  } };
  const node = (tag, attrs, ...children) => ({ tag, attrs, children });
  const d = { closed: false, setTitle() {}, setBody() {}, setFoot(...nodes) { this.foot = nodes; }, close() { this.closed = true; } };
  const f = await load('admin/desktop-flow.js', ['desktopFlow'], { ...dg, ...rg, h: node, notice: node, kv: node, copyable: node, createAttempt,
    connectWallet: async () => expected, assertWallet: async () => {}, walletSender: async () => async () => { events.push('SEND'); return ethers.id('tx'); },
    metadata: () => ({ name: 'BNB', symbol: 'BNB' }), errorMessage: e => e.message, toast() {},
    readRecovery: () => records, recoveryStore: key => ({ save: v => { records[key] = v; }, remove: () => delete records[key] }) });
  await f.desktopFlow(localApp, d, { kind: 'injected', deploymentId: 'TARGET', recovery: context });
  assert.deepEqual(events, ['crosschain-recovery/prepare']);
  if (changeSelection) state.selectedId = 'TARGET';
  const click = { currentTarget: { disabled: false } }, sendButton = d.foot.at(-1);
  await Promise.all([sendButton.attrs.onclick(click), sendButton.attrs.onclick(click)]);
  assert.equal(events.filter(e => e === 'SEND').length, changeSelection || changeDuringBegin ? 0 : 1);
  assert(scopes.every(s => s === 'TARGET' || s === 'GLOBAL'));
  assert(!events.includes('wallet/prepare'));
  if (loseAttach || changeDuringBegin) assert(records['TARGET:RECOVERY']);
  if (loseAttach) assert.equal(records['TARGET:RECOVERY'].phase, 'HASH_PENDING');
  assert.equal(order.status, 'WAITING'); checks++;
}
await flowFixture(); await flowFixture({ changeSelection: true }); await flowFixture({ changeDuringBegin: true }); await flowFixture({ loseAttach: true });
const status = await load('shared/status.js', ['deployJob', 'errorText', 'job', 'isActiveJob', 'needsRecovery']);
ok(() => assert.equal(status.deployJob({ ...boot, state: 'MINED', outcome: 'SUCCESS' }).label, '入口就绪 · 待部署商户'));
ok(() => assert.equal(status.deployJob({ state: 'MINED', outcome: 'SUCCESS' }).label, '部署成功 · 已加入'));
for (const code of ['DETERMINISTIC_RELEASE_MISMATCH', 'CANONICAL_SINGLETON_MISSING', 'PAYOUT_WALLET_REQUIRED', 'CONFIRMATIONS_REORGED', 'RECOVERY_BALANCE_EMPTY']) ok(() => assert(!status.errorText(code).includes(code)));
for (const result of ['SUCCESS', 'FAILED', 'UNRESOLVED']) ok(() => { const j = { state: 'ABANDONED', manualResolution: { result } }; assert(status.job(j).label.includes('人工')); assert.equal(status.isActiveJob(j), false); assert.equal(status.needsRecovery(j), false); });
// Compile every actual entry in memory, without writing generated artifacts.
const bundle = await build({ entryPoints: ['admin/main.js', 'public/deploy.js', 'public/collect.js', 'public/checkout.js'].map(p => new URL(p, root).pathname), bundle: true, outdir: '/tmp/upay-build-in-memory', write: false, loader: { '.svg': 'dataurl' }, platform: 'browser', format: 'iife', logLevel: 'silent' });
assert.equal(bundle.outputFiles.length, 4); checks++;
console.log(`PASS ${checks} deterministic/cross-chain guards and actual desktop flow checks; 4 browser entries bundled in memory. No network, user state or real wallet accessed.`);
