import { h, copyable, badge } from '../../shared/dom.js';
import { chainName, amount, units, fromUnits, relative, shortAddr } from '../../shared/format.js';
import { payment, orderCollection, needsRecovery, PAID_STATES } from '../../shared/status.js';
import { loadingRows, errorState, emptyState } from '../ui.js';

export function identityCard(app, { title = '当前部署', actions } = {}) {
  const d = app.selected(), c = app.state.status?.config;
  const tokens = c?.tokens || d?.tokens || [];
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('div', null, h('h2', null, title), h('div', { class: 'sub' }, '固定收款钱包和支持币种在合约部署时写死，之后不可修改。')), actions || null),
    h('div', { class: 'identity' },
      h('div', null, h('div', { class: 'k' }, '链'), h('div', { class: 'v', translate: d?.name ? 'no' : undefined }, chainName(d?.chainId, d?.name)), h('div', { class: 'muted small' }, d?.chainId ? `Chain ID ${d.chainId} · gas 币 ${d.nativeSymbol || '—'}` : '—')),
      h('div', null, h('div', { class: 'k' }, '收款合约 Factory'), h('div', { class: 'v' }, copyable(d?.factory, { title: 'Factory 地址' }))),
      h('div', null, h('div', { class: 'k' }, '固定收款钱包 payout'), h('div', { class: 'v' }, copyable(d?.payout, { title: '收款钱包' }))),
      h('div', null, h('div', { class: 'k' }, '支持币种'), h('div', { class: 'token-chips' },
        tokens.length ? tokens.map(t => h('span', { class: 'token-chip', title: t.address }, h('strong', null, t.symbol), h('span', { class: 'mono' }, shortAddr(t.address, 6, 4)))) : h('span', { class: 'subtle' }, '—')))));
}

// Collectable estimate per token, from the payment ledger. Never summed across tokens.
export function collectableByToken(orders) {
  const map = new Map();
  for (const o of orders) {
    if (!PAID_STATES.includes(o.status)) continue;
    const c = orderCollection(o);
    if (c.label === '已归集' || c.job && needsRecovery(c.job)) continue;
    const key = o.token.toLowerCase();
    const cur = map.get(key) || { token: o.token, symbol: o.symbol, decimals: o.decimals, total: 0n, count: 0 };
    cur.total += units(o.confirmedAmount, o.decimals); cur.count++;
    map.set(key, cur);
  }
  return [...map.values()];
}

export function overviewPage(app) {
  const s = app.state, d = app.selected();
  const loading = !s.loaded.orders && !s.errors.orders;
  const orders = s.orders;
  const by = st => orders.filter(o => st.includes(o.status)).length;
  const recovery = s.jobs.filter(needsRecovery);
  const failedNotify = s.notifications.filter(n => n.state === 'FAILED');
  const partialJobs = s.jobs.filter(j => j.state === 'MINED' && j.outcome !== 'SUCCESS');
  const late = orders.filter(o => o.status === 'LATE_PAYMENT');

  const tasks = [
    ...recovery.map(j => ({ tone: 'unknown', t: `归集交易结果未知 · ${j.orderIds.length} 笔订单`, d: '钱包可能已经发出交易。请登记原交易哈希或按流程结案，不要重复发起。', go: 'collect/recovery', action: '去处理' })),
    s.status?.syncError ? { tone: 'danger', t: '链上同步异常', d: '付款状态可能不是最新的。请检查该链 RPC 是否可用。', go: 'settings', action: '查看' } : null,
    ...partialJobs.map(j => ({ tone: 'danger', t: j.outcome === 'REVERTED' ? '一笔归集交易已回滚' : '一笔批量归集部分失败', d: '资金仍在订单地址，可在处理原因后重新归集。', go: 'collect/records', action: '查看' })),
    failedNotify.length ? { tone: 'warn', t: `${failedNotify.length} 条付款通知发送失败`, d: '商城可能还不知道这些订单已付款。', go: 'notifications', action: '查看' } : null,
    late.length ? { tone: 'warn', t: `${late.length} 笔订单在过期后到账`, d: '过期后到账不计入订单付款，需要人工核实处理。', go: 'orders', action: '查看' } : null,
  ].filter(Boolean);

  const collectable = collectableByToken(orders);

  return h('div', null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, '总览'),
      h('p', { class: 'lead' }, d ? `正在查看 ${chainName(d.chainId, d.name)} 的部署。切换右上角部署不会影响其他链的扫描。` : ''))),
    identityCard(app),
    h('div', { class: 'grid two section-gap' },
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, '需要处理'), tasks.length ? badge(`${tasks.length} 项`, 'warn', true) : null),
        loading ? loadingRows(3) : tasks.length ? h('ul', { class: 'tasks' }, tasks.map(t => h('li', { class: ['task', t.tone] }, h('span', { class: 'icon' }),
          h('div', { class: 'grow' }, h('div', { class: 't' }, t.t), h('div', { class: 'd' }, t.d)),
          h('a', { class: 'btn small go', href: '#/' + t.go }, t.action))))
          : emptyState('目前没有需要处理的事项', '结果未知的交易、失败通知和同步异常会出现在这里。')),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('div', null, h('h2', null, '待归集'), h('div', { class: 'sub' }, '已付足、尚未归集的订单，按币种分别统计。')),
          h('a', { class: 'btn small', href: '#/collect' }, '去归集')),
        loading ? loadingRows(2) : collectable.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
          h('thead', null, h('tr', null, h('th', null, '币种'), h('th', { class: 'num' }, '订单数'), h('th', { class: 'num' }, '已确认金额'))),
          h('tbody', null, collectable.map(c => h('tr', null, h('td', null, h('strong', { translate: 'no' }, c.symbol), h('span', { class: 'sub mono' }, shortAddr(c.token))),
            h('td', { class: 'num' }, String(c.count)), h('td', { class: 'num' }, amount(fromUnits(c.total, c.decimals)), ' ', c.symbol)))))) : emptyState('暂无待归集订单'),
        h('div', { class: 'card-body muted small' }, '这是按付款记录估算的金额。实际归集按执行时订单地址的链上余额，包含超额部分；不同币种不合并，也不换算法币。'))),
    h('section', { class: 'card section-gap' },
      h('div', { class: 'card-head' }, h('h2', null, '订单状态'), h('a', { class: 'btn small ghost', href: '#/orders' }, '全部订单')),
      s.errors.orders ? errorState(s.errors.orders, () => app.refresh()) : h('div', { class: 'counts' },
        [['已付足', by(PAID_STATES), 'paid'], ['进行中', by(['WAITING', 'CONFIRMING', 'PARTIAL']), 'open'], ['需人工核实', by(['LATE_PAYMENT']), 'attention'], ['已过期', by(['EXPIRED']), 'expired']]
          .map(([l, n, f]) => h('a', { class: 'count', href: '#/orders', onclick: () => { app.state.ui.orderFilter.status = f; } }, h('div', { class: 'n' }, loading ? '—' : String(n)), h('div', { class: 'l' }, l))))),
    h('section', { class: 'card section-gap' },
      h('div', { class: 'card-head' }, h('h2', null, '最近订单')),
      loading ? loadingRows(4) : orders.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table responsive' },
        h('thead', null, h('tr', null, h('th', null, '商户订单号'), h('th', { class: 'num' }, '应付'), h('th', null, '付款'), h('th', null, '归集'), h('th', null, '创建'))),
        h('tbody', null, orders.slice(0, 6).map(o => {
          const p = payment(o.status), c = orderCollection(o);
          return h('tr', { class: 'clickable', onclick: () => app.go('orders/' + o.id) },
            h('td', { class: 'ref' }, o.reference), h('td', { class: 'num' }, amount(o.expectedAmount), ' ', o.symbol),
            h('td', null, badge(p.label, p.tone)), h('td', null, c.none ? h('span', { class: 'subtle' }, '—') : badge(c.label, c.tone)), h('td', { class: 'muted hide-sm' }, relative(o.createdAt)));
        })))) : emptyState('还没有订单', '订单由商城通过 API 自动创建。', h('a', { class: 'btn', href: '#/integration' }, '查看接入方式'))));
}
