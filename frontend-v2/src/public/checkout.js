// Customer checkout. Public data only; no login, no wallet connection.
import { h, replace, copyable, notice } from '../shared/dom.js';
import { amount, units, fromUnits, dateTime, countdown, chainName } from '../shared/format.js';
import { header } from './common.js';

const root = document.getElementById('app');
const token = location.pathname.split('/').pop();

function customerStatus(o) {
  const remaining = () => {
    const r = units(o.expectedAmount, o.decimals) - units(o.receivedAmount, o.decimals);
    return amount(fromUnits(r > 0n ? r : 0n, o.decimals));
  };
  switch (o.status) {
    case 'WAITING': return ['neutral', '等待付款', '转账后通常几十秒内可以看到到账，请不要关闭此页面。'];
    case 'PARTIAL': return ['warn', `已收到 ${amount(o.receivedAmount)} ${o.symbol}，还差 ${remaining()} ${o.symbol}`, '请在有效期内补足差额，并使用同一网络、同一币种。'];
    case 'CONFIRMING': return ['info', '已收到付款，正在等待网络确认', '无需再次付款。确认完成后状态会自动更新。'];
    case 'PAID': return ['ok', '付款已确认', '商家会根据订单完成后续处理。'];
    case 'OVERPAID': return ['ok', '付款已确认（金额多于应付）', '多付部分请联系商家处理。'];
    case 'EXPIRED': return ['neutral', '订单已过期', '请不要再向这个地址付款。如需继续购买，请联系商家重新下单。'];
    case 'LATE_PAYMENT': return ['warn', '订单过期后收到了付款', '这笔付款需要商家人工核实，请联系商家。'];
    default: return ['neutral', '状态读取中', ''];
  }
}

let latest = 0, shown = 0, inFlight = false, order = null, qrUrl = null, failure = null;

async function fetchOrder() {
  const r = await fetch('/api/pay/' + encodeURIComponent(token), { cache: 'no-store', credentials: 'omit' });
  if (!r.ok) { const e = new Error(r.status === 404 ? 'NOT_FOUND' : 'UNAVAILABLE'); e.status = r.status; throw e; }
  return r.json();
}

// Single-flight polling with request tickets: a slow, older response can never
// replace a newer one (F5). Backend-verified reorg reversals still show because
// they arrive as the newest response.
async function poll() {
  if (inFlight) return;
  inFlight = true;
  const ticket = ++latest;
  try {
    const value = await fetchOrder();
    if (ticket < shown) return;
    shown = ticket; order = value; failure = null;
  } catch (error) {
    if (ticket < shown) return;
    failure = error;
  } finally {
    inFlight = false;
    const key = JSON.stringify([order, failure?.status ?? !!failure]);
    if (key !== lastKey) { lastKey = key; render(); }   // unchanged data: keep the DOM (no QR reload / flicker)
  }
}
let lastKey = '';

function qr() {
  if (qrUrl) return qrUrl;
  qrUrl = '/api/pay/' + encodeURIComponent(token) + '/qr';
  return qrUrl;
}

const left = h('span', { class: 'countdown' });
function tickCountdown() {
  if (!order) return;
  const ms = new Date(order.expiresAt).getTime() - Date.now();
  left.textContent = ms > 0 ? `剩余 ${countdown(ms)}` : '已过期';
  left.classList.toggle('low', ms > 0 && ms < 5 * 60000);
}

function render() {
  if (!order) {
    return replace(root, h('div', { class: 'pub' }, header('订单付款'), h('div', { class: 'panel' }, h('div', { class: 'panel-body' },
      failure ? notice('danger', failure.status === 404 ? '找不到这个订单' : '暂时无法读取订单', failure.status === 404 ? '请确认链接完整，或联系商家。' : '请稍后刷新页面。不要在无法确认订单信息时付款。')
        : h('div', { class: 'row' }, h('span', { class: 'spinner' }), '正在读取订单…')))));
  }
  const o = order, [tone, title, desc] = customerStatus(o), closed = ['EXPIRED', 'PAID', 'OVERPAID', 'LATE_PAYMENT'].includes(o.status);
  const net = chainName(o.chainId);
  tickCountdown();
  replace(root, h('div', { class: 'pub' },
    header('订单付款', closed ? null : left),
    h('div', { class: 'panel' },
      h('div', { class: 'panel-body' },
        h('div', { class: 'amount-hero' }, h('span', { class: 'k' }, '应付金额'), h('span', { class: 'v' }, amount(o.expectedAmount), h('small', null, o.symbol))),
        h('div', { class: ['pay-status', tone] }, h('span', { class: 'dot' }), h('div', null, h('div', { class: 't' }, title), desc ? h('div', { class: 'd' }, desc) : null)),
        failure ? notice('warn', '状态刷新暂时失败', '下方显示的是上一次读取的结果，页面会继续自动重试。') : null,
        !failure && o.epayReturnUrl ? h('a', { class: 'btn', href: o.epayReturnUrl }, '返回充值站') : null,
        o.syncHealthy === false ? notice('warn', '到账状态可能有延迟', '商家后台正在同步链上记录，请稍后刷新，不要重复付款。') : null),
      closed ? null : h('div', { class: 'panel-body' },
        h('div', { class: 'qr-pub' }, h('img', { src: qr(), alt: '付款二维码', width: 220, height: 220 })),
        h('div', { class: 'addr-box' }, h('span', { class: 'muted small' }, `向此地址转入 ${o.symbol}（${net}）`), h('span', { class: 'addr' }, o.address),
          h('div', null, h('button', { class: 'btn block', type: 'button', onclick: async e => {
            try { await navigator.clipboard.writeText(o.address); e.target.textContent = '已复制收款地址'; } catch { e.target.textContent = '请长按地址手动复制'; }
          } }, '复制收款地址'))),
        h('ul', { class: 'warn-list' },
          h('li', null, `只在 ${net} 上转入 ${o.symbol}，转到其他网络或其他币种不会计入付款。`),
          h('li', null, '请转入完整金额；部分付款需要在有效期内补足。'),
          h('li', null, '交易所提币可能有延迟，请留意有效期。'))),
      h('div', { class: 'panel-body' }, h('dl', { class: 'facts' },
        h('div', null, h('dt', null, '网络'), h('dd', null, `${net} · Chain ID ${o.chainId}`)),
        h('div', null, h('dt', null, '代币合约'), h('dd', null, copyable(o.token))),
        h('div', null, h('dt', null, '已到账'), h('dd', null, `${amount(o.receivedAmount)} ${o.symbol}（已确认 ${amount(o.confirmedAmount)}）`)),
        h('div', null, h('dt', null, '有效期至'), h('dd', null, dateTime(o.expiresAt)))))),
    h('p', { class: 'pub-foot' }, '页面会自动刷新付款状态。')));
}

(async () => {
  render();
  await poll();
  setInterval(poll, 5000);
  setInterval(tickCountdown, 1000);
})();
