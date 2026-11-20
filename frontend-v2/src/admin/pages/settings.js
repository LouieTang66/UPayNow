import { h, badge, notice, field, kv, copyable } from '../../shared/dom.js';
import { dateTime, chainName } from '../../shared/format.js';
import { busy, toast, persistentDetails, openDialog, errorMessage } from '../ui.js';

import { openAuthDialog } from '../auth.js';

export function settingsPage(app) {
  const s = app.state, st = s.status, d = app.selected();
  return h('div', null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, '设置'), h('p', { class: 'lead' }, '会话、钱包连接、手机入口和当前部署的运行状态。'))),
    h('div', { class: 'grid halves' },
      h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, '登录会话')),
        h('div', { class: 'card-body stack' }, kv([['方式', '密码登录；恢复密钥仅用于设密或重置'], ['会话', '浏览器 HttpOnly Cookie，8 小时有效；本页面不持久保存密码或密钥']]),
          h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => openAuthDialog(app, 'password') }, '修改密码'), h('button', { class: 'btn', type: 'button', onclick: e => busy(e.currentTarget, () => app.logout()) }, '退出登录')),
          h('button', { class: 'btn', type: 'button', onclick: () => openAuthDialog(app, 'recovery-key') }, '备份恢复密钥'))),
      h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, '独立 API 凭据')),
        h('div', { class: 'card-body stack' }, h('p', { class: 'muted small' }, '商城使用独立 API 凭据，不使用密码或恢复密钥。修改或重置密码不影响 API 凭据。'),
          h('div', null, h('button', { class: 'btn', type: 'button', onclick: () => openAuthDialog(app, 'api-key') }, '验证密码并查看 API 凭据')))),
      walletConnectCard(app),
      h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, '链上同步'), st?.syncError ? badge('异常', 'danger') : badge('正常', 'ok')),
        h('div', { class: 'card-body' }, kv([['部署', d ? `${chainName(d.chainId, d.name)} · ${d.chainId ?? '—'}` : '—'],
          ['已扫描区块', st ? `${st.cursor ?? '—'} / 链上最新 ${st.head ?? '—'}` : '—'], ['最近追平', dateTime(st?.lastSync)],
          ['付款确认数', String(st?.config?.confirmations ?? '—')], ['RPC 服务', st?.config?.rpcOrigin || '—'],
          st?.syncError ? ['错误', h('code', null, st.syncError)] : null]))),
      h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, '手机入口')),
        h('div', { class: 'card-body stack' }, kv([['模式', s.handoffConfig?.mode === 'quick' ? '按需临时开放（Cloudflare Quick Tunnel，最长 5 分钟）' : s.handoffConfig?.enabled ? '固定 HTTPS 地址' : '未启用'],
          ['当前状态', s.handoffConfig?.tunnel?.state === 'RUNNING' ? '开放中' : '未开放']]),
          h('p', { class: 'muted small' }, '手机入口只开放本批专用页面，不暴露管理后台。关闭入口不会取消已签名的交易。')))),
    h('section', { class: 'card section-gap' }, h('div', { class: 'card-head' }, h('div', null, h('h2', null, '辅助工具'), h('div', { class: 'sub' }, '正式订单应由商城 API 创建；这里只用于测试或补单。'))),
      h('div', { class: 'card-body' }, persistentDetails('tool-manual-order', {}, '手动创建一笔订单', manualOrderForm(app)))));
}

function walletConnectCard(app) {
  const deploymentId = app.state.selectedId;
  const drafts = app.state.ui.walletDrafts ||= {};
  const input = h('input', { class: 'input mono', value: drafts[deploymentId] ?? app.state.walletConfig?.projectId ?? '', placeholder: '32 位十六进制，可留空', dataset: { key: 'wc-project' }, autocomplete: 'off', oninput: e => { drafts[deploymentId] = e.target.value; } });
  return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'WalletConnect')),
    h('div', { class: 'card-body stack' }, h('p', { class: 'muted small' }, '使用 WalletConnect 需要你自己在 Reown 申请的 Project ID，可在配置链前保存。浏览器扩展钱包和手机扫码入口不需要。'),
      field('Reown Project ID', input),
      h('div', null, h('button', { class: 'btn', type: 'button', onclick: e => {
        const v = input.value.trim();
        if (v && !/^[0-9a-fA-F]{32}$/.test(v)) return toast('Project ID 应为 32 位十六进制。', 'danger');
        busy(e.currentTarget, async () => { await app.client.post('wallet/config', { projectId: v }, { deploymentId }); toast('已保存。'); app.refresh(); });
      } }, '保存'))));
}

function manualOrderForm(app) {
  // Kept across polling re-renders and scoped to the current deployment (app.keep).
  return app.keep('manual-order', () => buildManualOrderForm(app))
    || h('p', { class: 'muted small' }, '正在读取当前部署支持的币种…');
}

function buildManualOrderForm(app) {
  const tokens = app.state.status?.config?.tokens || app.selected()?.tokens || [];
  if (!tokens.length) return null;                      // not cached until the token list is known
  const deploymentId = app.state.selectedId, deploymentName = app.selected()?.name || '—';
  const ref = h('input', { class: 'input', placeholder: '例如 TEST-0001', maxlength: 128, autocomplete: 'off' });
  const amt = h('input', { class: 'input', placeholder: '例如 10.50', inputmode: 'decimal', autocomplete: 'off' });
  const tok = h('select', null, tokens.map(t => h('option', { value: t.address, translate: 'no' }, t.symbol)));
  const ttl = h('select', null, [[30, '30 分钟'], [60, '1 小时'], [1440, '1 天']].map(([v, l]) => h('option', { value: v }, l)));
  const reset = () => { app.forget('manual-order'); app.render(); };
  return h('div', { class: 'stack' }, h('div', { class: 'form-grid' }, field('商户订单号', ref), field('金额', amt), field('币种', tok), field('有效期', ttl)),
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', onclick: e => busy(e.currentTarget, async () => {
        if (app.state.selectedId !== deploymentId) throw new Error('部署已切换，这份草稿已作废。');
        const o = await app.client.post('orders', { deploymentId, reference: ref.value.trim(), token: tok.value, amount: amt.value.trim(), expiresInSeconds: Number(ttl.value) * 60 }, { deploymentId });
        toast('订单已创建。'); reset(); app.refresh(); app.go('orders/' + o.id);
      }, { onError: err => toast(errorMessage(err), 'danger') }) }, '创建订单'),
      h('button', { class: 'btn ghost', type: 'button', onclick: reset }, '清空')),
    h('p', { class: 'muted small' }, `将创建在部署“${deploymentName}”下。切换部署后这份草稿会被丢弃，不会带到其他链。`));
}
