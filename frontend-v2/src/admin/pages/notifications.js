import { h, badge } from '../../shared/dom.js';
import { dateTime, relative } from '../../shared/format.js';
import { NOTIFY } from '../../shared/status.js';
import { busy, toast, emptyState, loadingRows, errorState , actionButton } from '../ui.js';

import { epayOperationsPanel } from './epay-operations.js';

const TYPE = { 'payment.paid': '付款已确认', 'payment.reversed': '付款被撤回（链重组）' };

export function notificationsPage(app) {
  const s = app.state, deploymentId = s.selectedId, list = [...s.notifications].reverse();
  const failed = list.filter(n => n.state === 'FAILED').length;
  let body;
  if (!s.loaded.notifications) body = loadingRows(4);
  else if (s.errors.notifications && !list.length) body = errorState(s.errors.notifications, () => app.refresh());
  else if (!list.length) body = emptyState('还没有付款通知', '下单时填写了 webhookUrl 的订单，在付款确认或被撤回时会通知商城。');
  else body = h('div', { class: 'table-wrap' }, h('table', { class: 'table responsive' },
    h('thead', null, h('tr', null, h('th', null, '订单'), h('th', null, '事件'), h('th', null, '状态'), h('th', { class: 'num' }, '尝试'), h('th', null, '下次尝试'), h('th'))),
    h('tbody', null, list.map(n => {
      const st = NOTIFY[n.state] || { label: n.state, tone: 'neutral' };
      return h('tr', null, h('td', { class: 'ref' }, n.payload?.reference || '—', h('span', { class: 'sub' }, n.url ? new URL(n.url).host : '')),
        h('td', null, TYPE[n.payload?.type] || n.payload?.type), h('td', null, badge(st.label, st.tone)), h('td', { class: 'num' }, String(n.attempts)),
        h('td', { class: 'muted hide-sm' }, n.state === 'PENDING' && n.nextAttempt ? relative(n.nextAttempt) : '—'),
        h('td', null, ['PENDING', 'FAILED'].includes(n.state) ? actionButton(app, `notify-retry:${deploymentId}:${n.id}`, { pendingLabel: '处理中…' }, '重新排队', async () => {
          await app.client.post('notifications/' + encodeURIComponent(n.id) + '/retry', {}, { deploymentId }); toast('已重新排队。这不代表商城已经收到。'); await app.refresh();
        }) : null));
    }))));
  return h('div', null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, '付款通知'),
      h('p', { class: 'lead' }, '后台向商城发送签名的 HTTP 通知。“已送达”只表示商城返回了 2xx，不等于已经发货。'))),
    failed ? h('div', { class: 'notice warn', role: 'status', style: undefined }, h('div', { class: 'notice-body' }, h('strong', null, `${failed} 条通知发送失败`),
      '已自动重试 8 次。请确认商城接收地址可用后重新排队，事件 ID 不变，商城应按事件 ID 去重。')) : null,
    h('section', { class: 'card section-gap' }, body),
    app.keep('epay-operations', () => epayOperationsPanel(app)),
    h('p', { class: 'muted small section-gap' }, '提示：同一订单在链重组后可能先收到“撤回”、再收到新的“付款已确认”。商城应以订单号和订单当前状态为准决定是否发货，不要每收到一次付款通知就发一次货。'));
}
