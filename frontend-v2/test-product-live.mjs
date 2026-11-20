// Product-only regression checks. Executes source with isolated API/DOM doubles;
// never starts a backend or accesses real merchant state, RPCs or wallets.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const root = new URL('./', import.meta.url);
const read = path => fs.readFileSync(new URL(path, root), 'utf8');
const { sequencer } = await import('data:text/javascript;base64,' + Buffer.from(read('src/shared/api.js')).toString('base64'));
const pageNames = ['overviewPage', 'ordersPage', 'collectPage', 'chainsPage', 'notificationsPage', 'integrationPage', 'settingsPage', 'loginPage', 'onboardingPage'];
function consoleFixture() {
  const values = new Map(), calls = [], toasts = [];
  const context = vm.createContext({
    installLanguageSupport() {}, clearAuthUI() {},
    toast: (message, tone) => toasts.push({ message, tone }), errorMessage: error => error.code || error.message,
    navigator: { onLine: true }, document: { getElementById: () => ({}) },
    location: { hash: '#/overview' },
    sessionStorage: { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) },
    sequencer, needsRecovery: () => false,
    ...Object.fromEntries(pageNames.map(name => [name, () => name])),
  });
  const source = read('src/admin/main.js').replace(/^import .*;\n/gm, '').replace(/^export /gm, '').replace(/\nboot\(\);\s*$/, '');
  vm.runInContext(source + '\nrender = () => {}; globalThis.fixture = { app, state, loadDeployments, refreshAll, selectDeployment, pageContent };', context);
  const fixture = context.fixture;
  fixture.state.client = { async get(route, options) {
    calls.push({ route, options });
    if (route === 'deployments') return { deployments: fixture.deployments || [], defaultId: 'legacy' };
    if (route === 'deployment-jobs') return [{ id: 'unfinished', state: 'UNKNOWN' }];
    return [];
  } };
  return { ...fixture, calls, context, toasts };
}

test('empty authenticated deployment list has no fabricated scope and still loads recovery records', async () => {
  const f = consoleFixture();
  await f.loadDeployments();
  assert.equal(f.state.auth, 'in');
  assert.equal(f.state.selectedId, null);
  await f.refreshAll();
  assert.deepEqual(f.calls.map(c => c.route), ['deployments', 'deployment-jobs']);
  assert.equal(f.state.deploymentJobs[0].state, 'UNKNOWN');
  assert.equal(f.pageContent({ page: 'overview' }), 'onboardingPage');
  assert.equal(f.pageContent({ page: 'chains' }), 'chainsPage');
});

test('unconfigured real registry entry retains its identity and onboarding', async () => {
  const f = consoleFixture();
  f.context.fixture.deployments = [{ id: 'legacy', factory: null }];
  await f.loadDeployments();
  assert.equal(f.state.selectedId, 'legacy');
  await f.refreshAll();
  assert.equal(f.pageContent({ page: 'overview' }), 'onboardingPage');
  for (const call of f.calls.filter(c => !['deployments', 'deployment-jobs'].includes(c.route))) {
    assert.equal(call.options.deploymentId, 'legacy');
  }
});

test('kept form nodes survive ordinary refresh but not deployment switching', async () => {
  const f = consoleFixture();
  f.state.auth = 'in'; f.state.selectedId = 'original';
  f.state.deployments = [{ id: 'original' }, { id: 'other' }];
  const node = { draft: 'unsubmitted input' };
  assert.equal(f.app.keep('manual-order', () => node), node);
  await f.refreshAll();
  assert.equal(f.app.keep('manual-order', () => assert.fail('must reuse node')), node);
  await f.selectDeployment('other');
  const next = {};
  assert.equal(f.app.keep('manual-order', () => next), next);
  assert.notEqual(next, node);
});

function selectionFixture() {
  const f = consoleFixture();
  f.state.auth = 'in'; f.state.selectedId = 'existing';
  f.state.deployments = [{ id: 'existing', factory: 'configured' }, { id: 'known', factory: 'configured' }];
  f.context.fixture.deployments = [...f.state.deployments, { id: 'created', factory: 'configured' }];
  return f;
}

test('new deployment is loaded into the registry before switching scope, without a page reload', async () => {
  const f = selectionFixture();
  await f.selectDeployment('created');
  assert.equal(f.calls[0].route, 'deployments');
  assert.equal(f.state.selectedId, 'created');
  assert.equal(f.app.selected().id, 'created');
  assert.equal(f.context.sessionStorage.getItem('v2.deployment'), 'created');
  for (const call of f.calls.filter(c => c.options)) assert.equal(call.options.deploymentId, 'created');
});

test('missing target preserves the current scope instead of selecting an absent dropdown option', async () => {
  const f = selectionFixture();
  await f.selectDeployment('missing');
  assert.equal(f.state.selectedId, 'existing');
  assert.deepEqual(f.calls.map(c => c.route), ['deployments']);
  assert.equal(f.context.sessionStorage.getItem('v2.deployment'), null);
  assert.equal(f.toasts[0].message, 'DEPLOYMENT_NOT_FOUND');
});

test('registry fetch failure preserves selection and cannot issue scoped requests to an unknown target', async () => {
  const f = selectionFixture();
  f.state.client.get = async () => { throw Object.assign(new Error('offline'), { status: 503 }); };
  await f.selectDeployment('created');
  assert.equal(f.state.selectedId, 'existing');
  assert.equal(f.state.auth, 'in');
  assert.equal(f.toasts[0].message, 'offline');
});

test('a later known selection wins over an earlier pending new-deployment lookup', async () => {
  const f = selectionFixture(), get = f.state.client.get;
  let release;
  f.state.client.get = (route, options) => route === 'deployments' ? new Promise(resolve => { release = resolve; }) : get(route, options);
  const first = f.selectDeployment('created');
  await f.selectDeployment('known');
  release({ deployments: f.context.fixture.deployments }); await first;
  assert.equal(f.state.selectedId, 'known');
  assert.equal(f.context.sessionStorage.getItem('v2.deployment'), 'known');
  assert(!f.calls.some(c => c.options?.deploymentId === 'created'));
});

test('rapid new-deployment selections keep the latest intent even when replies arrive out of order', async () => {
  const f = selectionFixture(), get = f.state.client.get, pending = [];
  f.state.client.get = (route, options) => route === 'deployments' ? new Promise(resolve => pending.push(resolve)) : get(route, options);
  const first = f.selectDeployment('created'), second = f.selectDeployment('latest');
  pending[1]({ deployments: [...f.context.fixture.deployments, { id: 'latest', factory: 'configured' }] }); await second;
  pending[0]({ deployments: f.context.fixture.deployments }); await first;
  assert.equal(f.state.selectedId, 'latest');
  assert.equal(f.app.selected().id, 'latest');
});

test('choosing the current deployment cancels a pending selection without changing scope', async () => {
  const f = selectionFixture(), get = f.state.client.get;
  let release;
  f.state.client.get = (route, options) => route === 'deployments' ? new Promise(resolve => { release = resolve; }) : get(route, options);
  const first = f.selectDeployment('created');
  await f.selectDeployment('existing');
  release({ deployments: f.context.fixture.deployments }); await first;
  assert.equal(f.state.selectedId, 'existing');
  assert(!f.calls.some(c => c.options));
});

test('logout during registry lookup cannot restore authentication or select the late target', async () => {
  const f = selectionFixture();
  let release;
  f.state.client.get = () => new Promise(resolve => { release = resolve; });
  const first = f.selectDeployment('created'); f.app.setAuth('out');
  release({ deployments: f.context.fixture.deployments }); await first;
  assert.equal(f.state.auth, 'out');
  assert.equal(f.state.selectedId, null);
  assert.equal(f.state.deployments.length, 0);
});

test('production sources and styles contain no demo adapters, mode endpoint or test-network presets', () => {
  assert.equal(fs.existsSync(new URL('src/shared/demo.js', root)), false);
  for (const dir of ['src', 'styles']) {
    const walk = path => {
      for (const entry of fs.readdirSync(new URL(path, root), { withFileTypes: true })) {
        const file = path + '/' + entry.name;
        if (entry.isDirectory()) walk(file);
        else assert.doesNotMatch(read(file), /demo|演示|mode\.json|\b(?:97|11155111|31337)\b/i, file);
      }
    };
    walk(dir);
  }
  for (const file of ['brand/upaynow-a-arrow.svg', 'brand/upaynow-b-coin.svg', 'brand/upaynow-c-up.svg']) {
    assert.ok(fs.statSync(new URL(file, root)).size > 0);
  }
});
