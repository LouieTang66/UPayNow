import { h, notice, field, trustedSvg, replace } from '../../shared/dom.js';
import brandLogo from '../../../brand/upaynow-b-coin.svg';
import { languageButton } from '../../shared/i18n.js';
import { busy, errorMessage } from '../ui.js';
import { openAddChain } from './chains.js';
import { passwordInput, passwordError, secretPanel, registerAuthUI } from '../auth.js';

export function loginPage(app) {
  return app.keep('auth-login', () => buildLoginPage(app));
}

function buildLoginPage(app) {
  const epoch = app.authEpoch;
  const body = h('div', { class: 'stack' });
  let mode = 'loading', revision = 0, secret, disposed = false;
  const clear = () => { body.querySelectorAll('input,textarea').forEach(el => { el.value = ''; }); secret?.clear(); secret = null; };
  const unregister = registerAuthUI(() => { disposed = true; revision++; clear(); body.replaceChildren(); unregister(); });
  const current = ticket => !disposed && epoch === app.authEpoch && ticket === revision && app.state.auth === 'out';
  function show(nextMode) {
    clear(); mode = nextMode; const ticket = ++revision;
    const reset = mode === 'setup' || mode === 'reset';
    const password = passwordInput(reset ? 'new-password' : 'current-password');
    const confirmation = passwordInput();
    const key = h('input', { class: 'input mono', type: 'password', autocomplete: 'off', required: true, maxlength: 512 });
    const err = h('div', { class: 'error-text', role: 'alert' });
    const submit = h('button', { class: 'btn primary block', type: 'submit' }, reset ? '设置密码并生成新恢复密钥' : '登录');
    const back = h('button', { class: 'btn ghost', type: 'button', onclick: () => { if (!submit.disabled) show(reset ? 'login' : 'reset'); } }, reset ? '返回密码登录' : '忘记密码');
    const form = h('form', { class: 'stack', novalidate: true, onsubmit: e => {
      e.preventDefault(); if (submit.disabled || !current(ticket)) return;
      err.textContent = passwordError(password.value, reset ? confirmation.value : undefined);
      if (reset && !key.value.trim()) err.textContent = '请输入现有恢复密钥。';
      if (err.textContent) return;
      busy(submit, async () => {
        const payload = reset ? { recoveryKey: key.value, newPassword: password.value } : { password: password.value };
        try {
          const result = await app.client.post(reset ? 'auth/reset' : 'login', payload);
          if (!current(ticket)) return;
          clear();
          if (!reset) { if (location.hash === '#/login') location.hash = '#/overview'; app.setAuth('in'); return; }
          if (typeof result.recoveryKey !== 'string' || !result.recoveryKey) throw new Error('后台未返回凭据，请重试。');
          revision++;
          secret = secretPanel(result.recoveryKey, { recovery: true });
          const saved = h('input', { type: 'checkbox' });
          const done = h('button', { class: 'btn primary', type: 'button', disabled: true, onclick: () => { if (saved.checked) show('login'); } }, '已保存，返回密码登录');
          saved.addEventListener('change', () => { done.disabled = !saved.checked; });
          replace(body, h('h2', null, '密码已设置，请保存新恢复密钥'), secret.panel, h('label', { class: 'check' }, saved, '我已妥善保存新恢复密钥'), done);
        } finally { Object.keys(payload).forEach(k => { payload[k] = ''; }); }
      }, { onError: error => { if (current(ticket)) { err.textContent = errorMessage(error); password.value = ''; confirmation.value = ''; key.value = ''; if (error.code === 'PASSWORD_NOT_SET') show('setup'); } } });
    } }, reset ? notice('info', mode === 'setup' ? '首次设置登录密码' : '重置登录密码', '请用恢复密钥确认身份。设置完成后请保存新恢复密钥，再使用密码登录。') : notice('info', '使用密码日常登录', '恢复密钥仅用于首次设密或忘记密码；API 凭据独立使用。'),
    reset ? field('现有恢复密钥', key) : null,
    field(reset ? '新密码' : '登录密码', password, { hint: '密码须为 12–128 个字符，且不能全为空白；首尾空格会保留。' }), reset ? field('确认新密码', confirmation) : null, err, submit, back);
    replace(body, form);
  }
  async function status() {
    const ticket = revision;
    try { const result = await app.client.get('auth/status'); if (current(ticket)) show(result.passwordSet ? 'login' : 'setup'); }
    catch (error) { if (current(ticket)) replace(body, notice('danger', errorMessage(error)), h('button', { class: 'btn', type: 'button', onclick: status }, '重试')); }
  }
  replace(body, h('p', { class: 'muted' }, '正在读取密码状态…')); status();
  return h('div', { class: 'center-page' }, h('div', { class: 'language-entry' }, languageButton()), h('div', { class: 'card auth-card' },
    h('div', { class: 'brand' }, h('div', { class: 'brand-mark brand-logo', role: 'img', 'aria-label': 'UPayNow Logo' }, trustedSvg(brandLogo)), h('div', null, h('div', { class: 'brand-name' }, 'UPayNow'), h('div', { class: 'brand-sub' }, '商户后台登录'))), body));
}

export function onboardingPage(app) {
  const hasRecords = app.state.deploymentJobs.length > 0;
  return h('div', { class: 'center-page' }, h('div', { class: 'onboard stack' },
    h('div', null, h('h1', null, '开始使用 UPayNow'), h('p', { class: 'muted' }, '先接入一条链上的收款合约，之后商城就可以通过 API 自动创建收款订单。')),
    h('section', { class: 'card' }, h('ol', { class: 'onboard-steps' },
      h('li', { class: 'current' }, h('div', null, h('h3', null, '添加或导入链上部署'),
        h('p', { class: 'muted small' }, '选择网络，填写固定收款钱包和支持的代币，用你的钱包部署收款合约；已有合约可以直接导入。')),
        h('button', { class: 'btn primary', type: 'button', onclick: () => openAddChain(app) }, '添加链')),
      h('li', null, h('div', null, h('h3', null, '核对固定收款钱包和支持币种'),
        h('p', { class: 'muted small' }, '部署完成后，在“链与合约”中核对。这两项写入合约后不可修改。')), h('span')),
      h('li', null, h('div', null, h('h3', null, '查看商城接入方式'),
        h('p', { class: 'muted small' }, '获取部署 ID 和代币 CA，按示例从商城服务器创建订单、接收付款通知。')),
        h('a', { class: 'btn', href: '#/integration' }, '接入说明')))),
    hasRecords ? notice('info', '有未完成的部署记录', '之前发起过部署但尚未完成。请先查看记录，避免重复部署。', h('div', null, h('a', { class: 'btn small', href: '#/chains/records' }, '查看部署记录'))) : null));
}
