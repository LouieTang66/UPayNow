'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Store } = require('../store.cjs');
const { Deployments } = require('../deployments.cjs');
const config = (factory = '0x0000000000000000000000000000000000000011') => ({
  name: 'isolated', chainId: 97, rpcUrl: 'https://rpc.example.invalid', factory,
  payout: '0x0000000000000000000000000000000000000022', startBlock: 123,
  confirmations: 2, nativeSymbol: 'BNB', tokens: [{ address: '0x0000000000000000000000000000000000000033', decimals: 18, symbol: 'TEST' }]
});
function engine(dir, hooks = {}) {
  const store = new Store(dir);
  const e = { store, handoff: {}, closeCount: 0, merchant: { chain: store.get('config') ? { config: store.get('config') } : null } };
  e.merchant.configure = async c => {
    if (hooks.failConfigure) throw new Error('configure failed');
    store.set('config', c); store.set('cursor', c.startBlock - 1); e.merchant.chain = { config: c };
  };
  e.close = async () => { e.closeCount++; store.close(); };
  return e;
}
async function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upay-deployments-'));
  const root = engine(dir);
  const registries = [];
  const make = options => { const d = new Deployments(root, { createEngine: async dir => engine(dir), ...options }); registries.push(d); return d; };
  try { await fn({ root, dir, make }); }
  finally { for (const d of registries) await d.close(); await root.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('legacy remains visible, existing data/config never rewritten, root never closed by registry', async () => {
  await fixture(async ({ root, make }) => {
    const d = make();
    assert.equal(d.get(), root);
    assert.equal(d.list().deployments[0].name, '未配置');
    const old = config(); root.store.set('config', old);
    root.store.saveOrder({ id: 'old', reference: 'ref', publicToken: 'old-url' });
    assert.equal(await d.register({ ...old, startBlock: 999 }), root);
    assert.deepEqual(root.store.get('config'), old);
    assert.equal(root.store.get('deployments'), null);
    assert.equal(d.findPublic('old-url').engine, root);
    assert.throws(() => d.get('missing'), { status: 404 });
    await d.close(); assert.equal(root.closeCount, 0);
  });
});

test('concurrent identity registrations deduplicate; factories isolate data and restart restores offline', async () => {
  await fixture(async ({ root, dir, make }) => {
    const d = make();
    const [a, same] = await Promise.all([d.register(config()), d.register({ ...config(), startBlock: 999 })]);
    assert.equal(a, same);
    assert.notEqual(a.id, 'legacy');
    assert.equal(path.dirname(a.store.dir), path.join(dir, 'deployments'));
    const b = await d.register(config('0x0000000000000000000000000000000000000044'));
    assert.notEqual(a.id, b.id);
    a.store.saveOrder({ id: 'a', reference: 'shared-reference', publicToken: 'a-url' });
    b.store.saveOrder({ id: 'b', reference: 'shared-reference', publicToken: 'b-url' });
    a.store.saveHandoff({ id: 'handoff-a' });
    assert.equal(d.findPublic('a-url').order.id, 'a');
    assert.equal(d.findPublic('b-url').engine, b);
    assert.equal(d.findHandoff('handoff-a'), a.handoff);
    assert.throws(() => d.findPublic('missing'), { status: 404 });
    assert.throws(() => d.findHandoff('missing'), { status: 404 });
    a.store.set('cursor', 777);
    const saved = root.store.get('deployments');
    assert.equal(saved.length, 2); assert.equal(saved[0].config.startBlock, 123);
    await d.close();
    let configurations = 0;
    const restored = make({ createEngine: async dir => {
      const e = engine(dir); e.merchant.configure = async () => { configurations++; throw new Error('RPC must not run'); }; return e;
    } });
    await restored.load();
    assert.equal(configurations, 0);
    assert.equal(restored.get(a.id).store.get('cursor'), 777);
    assert.equal(restored.findPublic('a-url').engine.id, a.id);
    assert.equal(restored.list().deployments.length, 3);
    assert.equal(restored.list().defaultId, 'legacy');
    assert.deepEqual(root.store.get('deployments'), saved);
  });
});

test('configure failure closes child and retains directory without registering or changing root', async () => {
  await fixture(async ({ root, make }) => {
    let child;
    const d = make({ createEngine: async dir => { child = engine(dir, { failConfigure: true }); return child; } });
    await assert.rejects(d.register(config()), /configure failed/);
    assert.equal(child.closeCount, 1);
    assert.equal(fs.existsSync(child.store.dir), true);
    assert.equal(fs.existsSync(path.join(child.store.dir, 'owner.lock')), false);
    assert.equal(root.store.get('deployments'), null);
    assert.equal(d.entries.size, 1);
  });
});

test('one bad restored entry stays visible, other deployment loads, traversal descriptor cannot open paths', async () => {
  await fixture(async ({ root, make }) => {
    const d = make(); const good = await d.register(config()); await d.close();
    const saved = root.store.get('deployments');
    const badId = randomUUID();
    saved.push({ id: badId, config: config('0x0000000000000000000000000000000000000055') });
    saved.push({ id: '../../escape', config: config() });
    root.store.set('deployments', saved);
    const opened = [];
    const restored = make({ createEngine: async dir => {
      opened.push(dir); if (dir.endsWith(badId)) throw new Error('isolated initialization failure'); return engine(dir);
    } });
    await restored.load();
    assert.equal(restored.get(good.id).id, good.id);
    assert.match(restored.get(badId).error, /initialization failure/);
    assert.equal(restored.list().deployments.length, 4);
    assert.equal(opened.length, 2);
    assert.equal(restored.get('../../escape').error, 'INVALID_DEPLOYMENT_ID');
    assert.deepEqual(root.store.get('deployments'), saved);
  });
});

test('import awaits deployment inspection before creation and leaves duplicates/history untouched', async () => {
  const servicePath = require.resolve('../deployment-service.cjs');
  const previous = require.cache[servicePath];
  let inspections = 0, fail = false;
  require.cache[servicePath] = { id: servicePath, filename: servicePath, loaded: true, exports: {
    inspectDeployment: async input => {
      inspections++;
      await Promise.resolve();
      if (fail) throw new Error('runtime mismatch');
      return { ...input, tokens: config().tokens };
    }
  } };
  try {
    await fixture(async ({ make }) => {
      let creations = 0;
      const d = make({ createEngine: async dir => { creations++; assert.equal(inspections, 1); return engine(dir); } });
      const a = await d.import({ ...config(), tokens: config().tokens.map(t => t.address) });
      assert.equal(creations, 1);
      assert.equal(d.list().deployments[1].tokens[0].symbol, 'TEST');
      assert.equal(await d.import({ ...config(), startBlock: 999 }), a);
      assert.equal(inspections, 1);
      assert.equal(a.store.get('config').startBlock, 123);
      fail = true;
      await assert.rejects(d.import(config('0x0000000000000000000000000000000000000066')), /runtime mismatch/);
      assert.equal(creations, 1);
    });
  } finally {
    if (previous) require.cache[servicePath] = previous; else delete require.cache[servicePath];
  }
});

test('custom chains retain HTTPS validation and ignore user path/id', async () => {
  await fixture(async ({ make }) => {
    let calls = 0;
    const d = make({ createEngine: async dir => { calls++; return engine(dir); } });
    await assert.rejects(d.register({ ...config(), chainId: 0 }), { code: 'INVALID_CHAIN_ID' });
    await assert.rejects(d.register({ ...config(), confirmations: 0 }), { code: 'INVALID_CONFIRMATIONS' });
    assert.equal(calls, 0);
    const a = await d.register({ ...config(), id: '../../bad', dir: '/invalid', chainId: 31337, rpcUrl: 'https://127.0.0.1:43210' });
    assert.match(a.id, /^[0-9a-f-]{36}$/);
    assert.equal(calls, 1);
    await assert.rejects(d.register({ ...config(), rpcUrl: 'http://localhost' }), { code: 'RPC_HTTPS_REQUIRED' });
  });
});
