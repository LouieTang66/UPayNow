// Actual recovery dialog source; no wallet, network, or user-state writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source = (await fs.readFile(new URL('./src/admin/pages/crosschain-recovery.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replaceAll('export ', '');
const A = '0x' + 'ab'.repeat(20), F = '0x' + 'cd'.repeat(20), OTHER = '0x' + 'ef'.repeat(20);
const base = { id: 'SOURCE', scheme: 'deterministic-v2', chainId: 97, payout: A, factory: F };
const target = { ...base, id: 'MATCH', chainId: 11155111, name: 'Matching Sepolia' };
const h = (tag, attrs, ...children) => ({ tag, attrs: attrs || {}, children: children.flat(Infinity).filter(n => n != null) });
const flatten = nodes => nodes.flatMap(n => n && typeof n === 'object' ? [n, ...flatten(n.children || [])] : []);
function open(deployments, order = { chainId: 97 }) {
  const dialog = { closed: false, setBody(...nodes) { this.body = nodes; }, setFoot(...nodes) { this.foot = nodes; }, close() { this.closed = true; } };
  const context = vm.createContext({ h, field: (label, control) => h('field', { label }, control), notice: (...text) => h('notice', {}, ...text), chainName: (id, name) => name || String(id), openDialog: () => dialog });
  vm.runInContext(source + '\nglobalThis.open = openCrosschainRecovery;', context);
  context.open({ state: { selectedId: 'SOURCE', deployments }, client: { post() { assert.fail('Must not query or transact while selecting targets'); } } }, order);
  return dialog;
}
test('recovery dialog only offers same-wallet same-Factory v2 deployments on another chain', () => {
  const dialog = open([base, target,
    { ...target, id: 'OTHER_WALLET', payout: OTHER },
    { ...target, id: 'OTHER_FACTORY', factory: OTHER },
    { ...target, id: 'LEGACY', scheme: 'legacy-v1' },
    { ...target, id: 'SAME_CHAIN', chainId: 97 },
    { ...target, id: 'BROKEN', error: 'RPC unavailable' },
    { ...target, id: 'MISSING', payout: undefined }
  ]);
  assert.deepEqual(flatten(dialog.body).filter(n => n.tag === 'option').map(n => n.attrs.value), ['MATCH']);
});
test('case-insensitive address matching still allows the correct target', () => {
  const upper = address => '0x' + address.slice(2).toUpperCase();
  const dialog = open([base, { ...target, payout: upper(A), factory: upper(F) }]);
  assert.deepEqual(flatten(dialog.body).filter(n => n.tag === 'option').map(n => n.attrs.value), ['MATCH']);
});
test('no matching target explains the missing merchant deployment and offers no query action', () => {
  for (const deployments of [[base, { ...target, payout: OTHER }], [target], [{ ...base, error: 'offline' }, target], [{ ...base, scheme: 'legacy-v1' }, target]]) {
    const dialog = open(deployments);
    assert.equal(flatten(dialog.body).some(n => n.tag === 'select'), false);
    assert.match(JSON.stringify(dialog.body), /同一收款钱包/);
    assert.equal((dialog.foot || []).length, 0);
  }
});
test('an order from a different source chain cannot reuse the selected deployment', () => {
  const dialog = open([base, target], { chainId: 1 });
  assert.equal(flatten(dialog.body).some(n => n.tag === 'select'), false);
});
