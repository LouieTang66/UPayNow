'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({ document: { getElementById: () => ({}) }, location: { pathname: '/pay/unit-fixture' } });
const modern = path.join(__dirname, '../../frontend-v2/src');
vm.runInContext(fs.readFileSync(path.join(modern, 'shared/format.js'), 'utf8').replace(/^export /gm, ''), context);
const checkout = fs.readFileSync(path.join(modern, 'public/checkout.js'), 'utf8').replace(/^import .*;\n/gm, '');
const boundary = checkout.indexOf('\nlet latest =');
assert.notEqual(boundary, -1, 'checkout pure status helper boundary must exist');
vm.runInContext(checkout.slice(0, boundary), context);

test('partial-payment label uses exact token units, including 18-decimal dust and large amounts', () => {
  for (const [expectedAmount, receivedAmount, decimals, remaining] of [
    ['10.0', '3.0', 18, '7'],
    ['1.0', '0.1', 6, '0.9'],
    ['1.0', '0.999999999999999999', 18, '0.000000000000000001'],
    ['9007199254740993.0', '9007199254740992.9', 18, '0.1'],
    ['10', '3', 0, '7'],
    ['10.0', '10.1', 18, '0'],
  ]) {
    assert.equal(context.customerStatus({ status: 'PARTIAL', expectedAmount, receivedAmount, decimals, symbol: 'USDT' })[1],
      `已收到 ${context.amount(receivedAmount)} USDT，还差 ${remaining} USDT`);
  }
});

test('waiting, confirming, paid and expired labels never request an additional payment', () => {
  for (const status of ['WAITING', 'CONFIRMING', 'PAID', 'OVERPAID', 'EXPIRED', 'LATE_PAYMENT'])
    assert.ok(!context.customerStatus({ status })[1].includes('还差'));
  assert.equal(context.customerStatus({ status: 'CONFIRMING' })[1], '已收到付款，正在等待网络确认');
  assert.equal(context.customerStatus({ status: 'PAID' })[1], '付款已确认');
});
