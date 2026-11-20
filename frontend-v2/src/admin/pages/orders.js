import { h, badge, copyable, kv, notice, literal } from '../../shared/dom.js';
import { amount, dateTime, relative, shortAddr, fromUnits, chainName } from '../../shared/format.js';
import { payment, orderCollection, job as jobStatus, isActiveJob, PAID_STATES } from '../../shared/status.js';
import { drawer, emptyState, errorState, loadingRows, persistentDetails } from '../ui.js';
import { startCollection, openTokenCollection } from './collect.js';
import { openCrosschainRecovery } from './crosschain-recovery.js';

const FILTERS = [
  ['all', '全部', () => true],
  ['paid', '已付足', o => PAID_STATES.includes(o.status)],
  ['open', '进行中', o => ['WAITING', 'CONFIRMING', 'PARTIAL'].includes(o.status)],
  ['attention', '需核实', o => o.status === 'LATE_PAYMENT' || o.otherTokens?.length],
  ['expired', '已过期', o => o.status === 'EXPIRED'],
];

function filtered(app) {
  const f = app.state.ui.orderFilter, q = f.q.trim().toLowerCase();
  const test = (FILTERS.find(x => x[0] === f.status) || FILTERS[0])[2];
  return app.state.orders.filter(o => test(o) && (f.token === 'all' || o.token === f.token)
    && (!q || o.reference.toLowerCase().includes(q) || o.address.toLowerCase().includes(q) || o.id.includes(q)));
}

export function ordersPage(app) {
  const s = app.state, f = s.ui.orderFilter, tokens = s.status?.config?.tokens || app.selected()?.tokens || [];
  const list = filtered(app);
  const selected = [...s.ui.selected].filter(id => s.orders.some(o => o.id === id));
  const toolbar = h('div', { class: 'toolbar' },
    h('input', { class: 'input search', type: 'search', placeholder: '搜索订单号、收款地址', value: f.q, dataset: { key: 'order-search' }, 'aria-label': '搜索订单',
      oninput: e => { f.q = e.target.value; app.render(); } }),
    h('div', { class: 'seg', role: 'group', 'aria-label': '按付款状态筛选' }, FILTERS.map(([id, label]) =>
      h('button', { type: 'button', class: f.status === id && 'active', 'aria-pressed': String(f.status === id), onclick: () => { f.status = id; app.render(); } }, label))),
    h('select', { 'aria-label': '按币种筛选', onchange: e => { f.token = e.target.value; app.render(); } },
      h('option', { value: 'all' }, '全部币种'), tokens.map(t => h('option', { value: t.address, selected: f.token === t.address, translate: 'no' }, t.symbol))),
    h('div', { class: 'grow' }),
    selected.length ? h('button', { class: 'btn small primary', type: 'button', onclick: () => startCollection(app, { mode: 'manual', orderIds: selected }) }, `归集所选 ${selected.length} 笔`) : null);

  let body;
  if (!s.loaded.orders) body = loadingRows(6);
  else if (s.errors.orders && !s.orders.length) body = errorState(s.errors.orders, () => app.refresh());
  else if (!s.orders.length) body = emptyState('还没有订单', '订单由商城服务器通过 API 创建，创建后会出现在这里。', h('a', { class: 'btn', href: '#/integration' }, '查看接入方式'));
  else if (!list.length) body = emptyState('没有符合条件的订单', '调整筛选条件后再试。');
  else body = h('div', { class: 'table-wrap' }, h('table', { class: 'table responsive' },
    h('thead', null, h('tr', null, h('th', { class: 'check-col' }), h('th', null, '商户订单号'), h('th', { class: 'num' }, '应付'), h('th', { class: 'num' }, '已确认'),
      h('th', null, '付款'), h('th', null, '归集'), h('th', null, '创建'))),
    h('tbody', null, list.map(o => {
      const p = payment(o.status), c = orderCollection(o), checked = s.ui.selected.has(o.id);
      return h('tr', { class: ['clickable', checked && 'selected'], onclick: () => app.go('orders/' + o.id) },
        h('td', { class: 'check-col', onclick: e => e.stopPropagation() }, h('input', { type: 'checkbox', checked, 'aria-label': '选择 ' + o.reference,
          onchange: e => { e.target.checked ? s.ui.selected.add(o.id) : s.ui.selected.delete(o.id); app.render(); } })),
        h('td', null, h('span', { class: 'ref' }, o.reference), h('span', { class: 'sub mono' }, shortAddr(o.address, 8, 6))),
        h('td', { class: 'num' }, amount(o.expectedAmount), ' ', o.symbol),
        h('td', { class: 'num hide-sm' }, amount(o.confirmedAmount)),
        h('td', null, badge(p.label, p.tone), o.otherTokens?.length ? h('span', { class: 'sub' }, '另收到其他币种') : null),
        h('td', null, c.none ? h('span', { class: 'subtle' }, '—') : badge(c.label, c.tone)),
        h('td', { class: 'muted hide-sm' }, relative(o.createdAt)));
    }))));

  return h('div', null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, '订单'),
      h('p', { class: 'lead' }, '订单由商城通过 API 创建。付款状态来自链上到账记录，归集状态来自归集交易回执，两者分开显示。'))),
    h('section', { class: 'card' }, toolbar, body,
      s.loaded.orders && s.orders.length ? h('div', { class: 'card-body muted small' }, `共 ${s.orders.length} 笔，当前显示 ${list.length} 笔。`) : null));
}

// ---------- detail drawer ----------
export function openOrderDrawer(app, id) {
  const find = () => app.state.orders.find(o => o.id === id);
  let d = null;
  const close = () => { app.listeners.delete(update); if (location.hash.startsWith('#/orders/')) history.replaceState(null, '', '#/orders'); app.render(); };
  const update = () => { if (d) d.render(content(app, find(), id)); };
  d = drawer({ ...content(app, find(), id), onClose: close });
  app.listeners.add(update);
}

function content(app, o, id) {
  if (!o) return { title: '订单详情', body: app.state.loaded.orders ? notice('warn', '当前部署下找不到这笔订单', '它可能属于另一个部署。订单只在创建它的部署下查询。') : loadingRows(5) };
  const p = payment(o.status), c = orderCollection(o), dep = app.selected();
  const activeJob = (o.collectionJobs || []).find(isActiveJob);
  const canCollect = PAID_STATES.includes(o.status) && c.label !== '已归集' && !activeJob;
  const checkoutUrl = location.origin + o.checkoutPath;
  return {
    title: literal(o.reference),
    sub: `${chainName(o.chainId, dep?.name)} · ${o.symbol} · 创建于 ${dateTime(o.createdAt)}`,
    body: [
      h('div', { class: 'status-pair' },
        h('div', null, h('div', { class: 'k' }, '付款'), badge(p.label, p.tone), h('div', { class: 'd' }, p.hint)),
        h('div', null, h('div', { class: 'k' }, '归集'), c.none ? h('span', { class: 'muted' }, '付足后才能归集') : badge(c.label, c.tone), h('div', { class: 'd' },
          c.job ? (isActiveJob(c.job) ? '交易处理中，请在“归集 → 异常恢复”查看。' : '见下方归集记录。') : '资金仍在订单收款地址。'))),
      h('div', { class: 'amounts' },
        h('div', null, h('div', { class: 'k' }, '应付'), h('div', { class: 'v' }, amount(o.expectedAmount), ' ', o.symbol)),
        h('div', null, h('div', { class: 'k' }, '已确认'), h('div', { class: 'v' }, amount(o.confirmedAmount), ' ', o.symbol)),
        h('div', null, h('div', { class: 'k' }, '已检测（含未确认）'), h('div', { class: 'v' }, amount(o.receivedAmount), ' ', o.symbol))),
      o.lateAmount && o.lateAmount !== '0' ? notice('warn', `过期后到账 ${amount(o.lateAmount)} ${o.symbol}`, '这部分不计入订单付款。资金在订单地址中，可以归集，但需要和顾客、商城人工核实如何处理。') : null,
      o.otherTokens?.length ? notice('info', '这个地址还收到了其他支持币种', '其他币种不计入本订单付款，也不换算。可在下方“高级”中单独归集。') : null,
      h('div', null, h('div', { class: 'block-title' }, '付款信息'), kv([
        ['收款地址', copyable(o.address, { full: true })], ['付款币种', h('span', { translate: 'no' }, o.symbol, ' ', h('code', { class: 'subtle' }, shortAddr(o.token, 8, 6)))],
        ['有效期至', `${dateTime(o.expiresAt)}（${relative(o.expiresAt)}）`], ['收银台链接', copyable(checkoutUrl, { title: '收银台链接' })]])),
      h('div', null, h('div', { class: 'block-title' }, `到账记录（${(o.deposits || []).length}）`),
        (o.deposits || []).length ? h('table', { class: 'table' }, h('tbody', null, o.deposits.map(dp => h('tr', null,
          (() => {
            const meta = (app.state.status?.config?.tokens || dep?.tokens || []).find(t => t.address.toLowerCase() === String(dp.token).toLowerCase());
            const same = String(dp.token).toLowerCase() === o.token.toLowerCase();
            return h('td', null, meta ? amount(fromUnits(BigInt(dp.amount), meta.decimals)) : h('code', null, dp.amount), ' ', meta?.symbol || '',
              same ? null : h('span', { class: 'sub' }, '其他币种 · 不计入付款'));
          })(),
          h('td', { class: 'muted nowrap' }, dp.timestamp ? dateTime(dp.timestamp * 1000) : '—'),
          h('td', null, copyable(dp.transactionHash, { title: '交易哈希' }))))))
          : h('p', { class: 'muted small' }, '尚未检测到到账。')),
      h('div', null, h('div', { class: 'block-title' }, '归集记录'),
        (o.collectionJobs || []).length ? h('ul', { class: 'timeline' }, o.collectionJobs.map(j => {
          const s = jobStatus(j);
          return h('li', { class: s.tone === 'ok' ? 'ok' : s.tone === 'unknown' ? 'unknown' : '' }, h('div', null,
            h('div', { class: 'row wrap' }, badge(s.label, s.tone), h('span', { class: 'muted small' }, dateTime(j.createdAt))),
            j.txHash ? h('div', { class: 'small' }, '交易 ', copyable(j.txHash)) : h('div', { class: 'muted small' }, '尚未登记交易哈希')));
        })) : h('p', { class: 'muted small' }, '尚未发起归集。')),
      persistentDetails('order-advanced:' + id, {}, '高级',
        kv([['订单 ID', copyable(o.id)], ['orderIdHash', copyable(o.orderHash)], ['付款币种 CA', copyable(o.token)],
          ['付款通知地址', o.webhookUrl || '未设置'], ['状态版本', `generation ${o.generation} · stateVersion ${o.stateVersion}`]]),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn small', type: 'button', disabled: !!activeJob, onclick: () => openTokenCollection(app, o, 'supported') }, '归集其他支持币'),
          h('button', { class: 'btn small', type: 'button', disabled: !!activeJob, onclick: () => openTokenCollection(app, o, 'wrong') }, '归集错币 / 原生币')),
        h('p', { class: 'muted small' }, '这两项不改变订单币种，也不计入付款，资金只会进入固定收款钱包。')),
    ],
    foot: [
      dep?.scheme === 'deterministic-v2' ? h('button', { class: 'btn', type: 'button', onclick: () => openCrosschainRecovery(app, o) }, '错链找回') : null,
      activeJob ? h('a', { class: 'btn', href: '#/collect/recovery' }, '查看进行中的交易') : null,
      h('button', { class: 'btn primary', type: 'button', disabled: !canCollect, title: canCollect ? '' : '需要已付足且未归集，并且没有进行中的交易',
        onclick: () => startCollection(app, { mode: 'manual', orderIds: [o.id] }) }, '归集此订单'),
    ],
  };
}
