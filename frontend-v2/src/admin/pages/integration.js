import { h, copyable, notice, kv } from '../../shared/dom.js';
import { chainName } from '../../shared/format.js';

export function integrationPage(app) {
  const d = app.selected(), tokens = app.state.status?.config?.tokens || d?.tokens || [];
  const origin = location.origin;
  const token = tokens[0]?.address || '<当前部署支持的代币 CA>';
  const create = `curl -X POST ${origin}/api/orders \\
  -H "Authorization: Bearer <API 凭据>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "deploymentId": "${d?.id || '<部署 ID>'}",
    "reference": "SHOP-ORDER-0001",
    "token": "${token}",
    "amount": "10.50",
    "expiresInSeconds": 1800,
    "webhookUrl": "https://shop.example.com/hooks/upaynow"
  }'`;
  const verify = `// Node.js 示例：先验签，再解析正文
const crypto = require('node:crypto');
function verify(rawBody, headers, secret) {
  const ts = headers['x-upaynow-timestamp'];
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;   // 时间窗
  const expected = crypto.createHmac('sha256', secret).update(ts + '.' + rawBody).digest('hex');
  const given = String(headers['x-upaynow-signature'] || '');
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}`;
  return h('div', null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, '商城接入'),
      h('p', { class: 'lead' }, '商城服务器通过 API 创建收款订单，把收银台链接交给顾客；付款确认后后台发送签名通知。'))),
    notice('warn', 'API 凭据只放在商城服务器', '商城使用独立 API 凭据，不使用登录密码或恢复密钥。可在设置中验证当前密码后取得。API 凭据仍有广泛业务管理权限，不能交给顾客网页、App 或公开仓库。'),
    h('section', { class: 'card section-gap' }, h('div', { class: 'card-head' }, h('div', null, h('h2', null, '当前部署的接入参数'),
      h('div', { class: 'sub' }, '订单只属于创建它的部署。每次下单都要带上部署 ID，并使用该部署支持的准确代币 CA。'))),
      h('div', { class: 'card-body' }, d?.factory ? kv([
        ['部署', `${chainName(d.chainId, d.name)} · Chain ID ${d.chainId}`], ['deploymentId', copyable(d.id, { full: true })],
        ...tokens.map(t => [`${t.symbol} 的 CA`, h('span', null, copyable(t.address, { full: true }), h('span', { class: 'muted small' }, ` decimals ${t.decimals}`))]),
      ]) : h('p', { class: 'muted' }, '当前部署尚未配置。'))),
    h('section', { class: 'card section-gap' }, h('div', { class: 'card-head' }, h('h2', null, '1. 创建订单')),
      h('div', { class: 'card-body stack' }, h('pre', { class: 'code' }, create),
        h('ul', { class: 'muted small' },
          h('li', null, 'amount 必须是十进制字符串，不能用浮点数或科学计数，小数位不能超过该币种的 decimals。'),
          h('li', null, 'reference 是商城自己的订单号，在同一部署内幂等：参数相同会返回原订单，参数不同会被拒绝。'),
          h('li', null, '请保存返回的 id、deploymentId、address 和 checkoutPath。'),
          h('li', null, 'webhookUrl 的域名需要服务器启动时通过 UPAY_WEBHOOK_HOSTS 允许。')))),
    h('section', { class: 'card section-gap' }, h('div', { class: 'card-head' }, h('h2', null, '2. 引导顾客付款')),
      h('div', { class: 'card-body stack' }, h('p', null, '把 ', h('code', null, origin + '/pay/<checkoutPath 中的令牌>'), ' 发给顾客。收银台只显示该订单的付款信息，不需要登录。'),
        h('p', { class: 'muted small' }, '顾客需要在正确的链上，向订单收款地址转入订单指定的代币。转错币种或转错链都不会计入付款。'))),
    h('section', { class: 'card section-gap' }, h('div', { class: 'card-head' }, h('h2', null, '3. 接收付款通知')),
      h('div', { class: 'card-body stack' },
        kv([['事件', 'payment.paid（已确认付足）、payment.reversed（链重组撤回）'], ['请求头', h('code', null, 'X-Upaynow-Event / X-Upaynow-Timestamp / X-Upaynow-Signature')],
          ['签名', 'HMAC-SHA256(timestamp + "." + 原始正文)，密钥是服务器数据目录中的 webhook.secret'], ['成功', '返回 2xx 才算送达；失败会自动重试，最多 8 次']]),
        h('pre', { class: 'code' }, verify),
        notice('info', '按订单状态履约', '同一订单可能因链重组先撤回、再重新确认，届时会收到新的事件 ID。请以订单号 + 最新 stateVersion 判断是否发货，不要每收到一个付款事件就发一次货。'))));
}
