// Offline localization regression checks. No real DOM, RPC, wallet or merchant state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { build } from 'esbuild';
const root = new URL('./', import.meta.url);
const result = await build({ entryPoints: [new URL('src/shared/i18n.js', root).pathname], bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'I18N' });
const code = result.outputFiles[0].text;
function fixture(values = new Map(), blocked = false) {
  const writes = [], forbidden = () => assert.fail('language switch must not fetch, call wallets or navigate');
  const context = vm.createContext({
    localStorage: { getItem: k => { if (blocked) throw Error('blocked'); return values.get(k) ?? null; }, setItem: (k, v) => { if (blocked) throw Error('blocked'); writes.push(k); values.set(k, v); } },
    fetch: forbidden, window: { ethereum: { request: forbidden }, location: { reload: forbidden }, addEventListener() {} },
  });
  vm.runInContext(code, context);
  return { ...context.I18N, values, writes };
}
test('all three English catalogs are complete strings and retain template slots', () => {
  for (const domain of ['admin-pages', 'admin-shared', 'public']) {
    const map = JSON.parse(fs.readFileSync(new URL(`src/shared/locales/${domain}.en.json`, root), 'utf8'));
    assert(Object.keys(map).length > 0);
    for (const [source, target] of Object.entries(map)) {
      assert.equal(typeof target, 'string', source); assert(target.trim(), source);
      assert(!/[\u4e00-\u9fff]/.test(target), `untranslated value: ${source}`);
      assert.deepEqual([...target.matchAll(/\{\d+\}/g)].map(x => x[0]).sort(), [...source.matchAll(/\{\d+\}/g)].map(x => x[0]).sort(), source);
    }
  }
});
test('Chinese default, reversible English labels, templates and labeled testnets', () => {
  const f = fixture(); assert.equal(f.getLanguage(), 'zh'); assert.equal(f.translate('登录'), '登录');
  f.setLanguage('en'); assert.match(f.translate('登录'), /log in|sign in/i);
  assert.equal(f.translate('归集所选 3 笔').includes('3'), true);
  assert(!/[\u4e00-\u9fff]/.test(f.translate('已同步 · 5 分钟前')));
  assert.equal(f.translate('BSC Testnet（测试网） · 97'), 'BSC Testnet (Testnet) · 97');
  assert.equal(f.translate('Ethereum Sepolia（测试网） · 11155111'), 'Ethereum Sepolia (Testnet) · 11155111');
  f.setLanguage('zh'); assert.equal(f.translate('登录'), '登录');
});
test('preferences persist; switching touches only the language key, never transaction records', () => {
  const values = new Map([['upay.rec.deploy.fixture', '{"hash":"0xabc","pending":true}'], ['v2.deployment', 'original']]);
  const before = [...values]; const f = fixture(values); f.setLanguage('en');
  assert.equal(fixture(values).getLanguage(), 'en');
  for (const [k, v] of before) assert.equal(values.get(k), v);
  assert(f.writes.every(k => k === 'upay.language'));
  f.setLanguage('fr'); assert.equal(f.getLanguage(), 'en');
});
test('storage failure does not block a reversible language switch', () => {
  const f = fixture(new Map(), true); f.setLanguage('en'); assert.match(f.translate('登录'), /log in|sign in/i);
  f.setLanguage('zh'); assert.equal(f.translate('登录'), '登录');
});
test('interpolation preserves user text and full raw amounts; unmatched text remains unchanged', () => {
  const f = fixture(); f.setLanguage('en');
  const text = f.translate('将创建在部署“设置”下。切换部署后这份草稿会被丢弃，不会带到其他链。');
  assert(text.includes('设置')); assert(!text.includes('这份草稿'));
  assert(f.translate('已收到 0.000000000000000001 USDT，还差 999999999.999999999999999999 USDT').includes('0.000000000000000001'));
  assert.equal(f.translate('0x1234567890abcdef'), '0x1234567890abcdef');
  assert.equal(f.translate('Custom shop 我的店'), 'Custom shop 我的店');
});
