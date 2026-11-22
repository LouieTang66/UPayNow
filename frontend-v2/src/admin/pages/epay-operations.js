import { badge, copyable, field, h, literal, replace } from '../../shared/dom.js';
import { dateTime } from '../../shared/format.js';
import { busy, errorMessage, toast } from '../ui.js';

const STATES = { RECONCILE: '需要人工对账', FAILED: '回调重试已耗尽', PENDING: '等待回调送达' };
const REASONS = { CHAIN_REVERSAL: '链上付款被撤回', FINAL_CALLBACK_OUTCOME_UNKNOWN: '最后一次回调的结果未知' };
const CHAIN = { UNVERIFIED: '链上结果未核实', CONFIRMED: '链上付款已核实', NOT_CANONICAL: '付款不在当前有效链上' };
const NEW_API = { UNVERIFIED: '商城结果未核实', CREDITED: '商城记录显示已入账', PENDING: '商城订单仍待处理', NO_EXACT_MATCH: '商城没有匹配的完整单号' };
const SOURCE = { ADMIN_SESSION: '管理台会话', API_CREDENTIAL: '管理 API 凭据' };
const choices = values => h('select', null, Object.entries(values).map(([value, label]) => h('option', { value }, label)));
const text = (value, map) => map[value] || '—';
const queuePath = 'epay/operations', reviewsPath = queuePath + '/reviews';

export function epayOperationsPanel(app) {
  const deploymentId = app.state.selectedId, epoch = app.authEpoch;
  if (!deploymentId) return null;
  const scope = { deploymentId }, filter = choices(STATES);
  const message = h('p', { role: 'status', class: 'muted' });
  const rows = h('div'), controls = h('div', { class: 'row' });
  let cursor = null, back = [], next = null, request = 0, loaded = false, loading = false;
  const previous = h('button', { type: 'button', class: 'btn small', disabled: true, onclick: () => {
    if (!back.length || loading) return;
    cursor = back.pop(); void load();
  } }, '上一页');
  const more = h('button', { type: 'button', class: 'btn small', disabled: true, onclick: () => {
    if (next === null || loading) return;
    back.push(cursor); cursor = next; void load();
  } }, '下一页');
  const refresh = h('button', { type: 'button', class: 'btn small', onclick: () => void load() }, '刷新对账队列');
  controls.append(previous, more, refresh);
  const panel = h('details', { class: 'card section-gap', onToggle: () => {
    if (panel.open && !loaded && !loading) void load();
  } }, h('summary', { class: 'card-head' }, h('strong', null, 'EPay 回调与对账')),
  h('div', { class: 'card-body' },
    h('p', { class: 'muted' }, '在 New API 管理员充值记录中搜索完整商城订单号，并核对结果是否完全匹配。链上付款与商城入账需要分别核实。'),
    field('EPay 队列状态', filter), controls, message, rows));
  function active() {
    return app.state.auth === 'in' && app.authEpoch === epoch && app.state.selectedId === deploymentId
      && app.route().page === 'notifications' && panel.open;
  }
  function handleAuth(error) {
    if (error.status === 401 && active()) app.setAuth('out');
  }
  function setButtons() {
    previous.disabled = loading || !back.length;
    more.disabled = loading || next === null;
    refresh.disabled = loading;
  }
  filter.addEventListener('change', () => { cursor = null; back = []; next = null; void load(); });
  function reviewNode(record) {
    return h('div', { class: 'muted small' },
      dateTime(record.recordedAt), ' · ', text(record.chain, CHAIN), ' · ', text(record.newApi, NEW_API), ' · ',
      text(record.authorization, SOURCE), ' · ', text(record.state, STATES), record.reason ? [' · ', text(record.reason, REASONS)] : null);
  }
  function historyNode(order) {
    const body = h('div', { role: 'status' });
    let before = null, started = false, running = false;
    const detail = h('details', { onToggle: () => {
      if (detail.open && !started) void history();
    } }, h('summary', null, '查看核对历史'), body);
    async function history() {
      if (running || !active()) return;
      running = true;
      const query = new URLSearchParams({ out_trade_no: order.outTradeNo });
      if (before !== null) query.set('before', String(before));
      try {
        const result = await app.client.get(reviewsPath + '?' + query, scope);
        if (!active()) return;
        started = true;
        replace(body, result.items.length ? result.items.map(reviewNode) : h('p', { class: 'muted' }, '没有核对记录'));
        if (result.nextBefore !== null) body.append(h('button', { type: 'button', class: 'btn small', onclick: () => {
          before = result.nextBefore; void history();
        } }, '更早的核对记录'));
      } catch (error) {
        if (active()) { handleAuth(error); replace(body, errorMessage(error)); }
      } finally { running = false; }
    }
    return detail;
  }
  function exceptionNode(order) {
    const chain = choices(CHAIN), newApi = choices(NEW_API);
    const submit = h('button', { type: 'submit', class: 'btn small primary' }, '保存人工核对');
    const form = h('form', { onSubmit: event => {
      event.preventDefault();
      if (!active() || loading) return;
      void busy(submit, async () => {
        await app.client.post(reviewsPath,
          { outTradeNo: order.outTradeNo, revision: order.revision, chain: chain.value, newApi: newApi.value }, scope);
        if (active()) { toast('已记录核对结果，未更改付款、回调或商城余额。'); await load(); }
      }, { onError: error => {
        if (!active()) return;
        handleAuth(error);
        toast(errorMessage(error), 'danger');
        if (error.code === 'EPAY_REVIEW_STALE') void load();
      } });
    } }, field('链上核对', chain), field('New API 入账核对', newApi), submit);
    const audit = order.review ? h('div', null,
      h('strong', null, order.reviewCurrent ? '已有本轮人工核对记录' : '异常已变化，需要重新核对'), reviewNode(order.review), historyNode(order))
      : h('p', { class: 'muted' }, '尚未记录人工核对');
    return [audit, h('details', null, h('summary', null, '记录人工核对'), form)];
  }
  function row(order) {
    return h('section', { class: 'section-gap' },
      h('h3', null, '商城订单号'), copyable(order.outTradeNo, { full: true, title: '商城订单号' }),
      typeof order.orderId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(order.orderId)
        ? h('p', null, h('a', { href: '#/orders/' + order.orderId }, '查看 UPayNow 原订单')) : null,
      h('p', null, badge(text(order.state, STATES), order.state === 'PENDING' ? 'neutral' : 'warn'), ' ', text(order.reason, REASONS)),
      h('p', { class: 'muted small' }, literal([order.amount, order.priceCurrency].filter(Boolean).join(' ')),
        ' · ', dateTime(order.createdAt)),
      order.state !== 'PENDING' ? exceptionNode(order) : null);
  }
  async function load() {
    if (!active()) return;
    const ticket = ++request, state = filter.value;
    loading = true; setButtons(); replace(message, '正在加载 EPay 队列…'); replace(rows);
    const query = new URLSearchParams({ state });
    if (cursor !== null) query.set('before', String(cursor));
    try {
      const result = await app.client.get(queuePath + '?' + query, scope);
      if (ticket !== request || !active()) return;
      loaded = true; next = result.nextBefore;
      replace(message, result.items.length ? '' : '此状态下没有 EPay 订单');
      replace(rows, result.items.map(row));
    } catch (error) {
      if (ticket !== request || !active()) return;
      handleAuth(error); next = null;
      replace(message, errorMessage(error));
    } finally {
      if (ticket === request) { loading = false; setButtons(); }
    }
  }
  return panel;
}
