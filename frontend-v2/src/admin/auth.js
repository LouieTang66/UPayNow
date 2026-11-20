// Secrets live only in form controls / short-lived closures. Never persist them.
import { h, field, notice } from '../shared/dom.js';
import { openDialog, busy, errorMessage, toast } from './ui.js';

const cleanups = new Set();
export function clearAuthUI() { for (const clear of [...cleanups]) clear(); }
export function registerAuthUI(clear) { cleanups.add(clear); return () => cleanups.delete(clear); }
export function passwordInput(autocomplete = 'new-password') {
  return h('input', { class: 'input', type: 'password', autocomplete, required: true, maxlength: 128 });
}
export function passwordError(value, confirmation) {
  if (value.length < 12 || value.length > 128 || !value.trim()) return '密码须为 12–128 个字符，且不能全为空白；首尾空格会保留。';
  if (confirmation !== undefined && value !== confirmation) return '两次输入的新密码不一致。';
  return '';
}
export function secretPanel(value, { recovery = false } = {}) {
  let secret = value;
  const output = h('textarea', { class: 'input mono', readOnly: true, rows: 4, autocomplete: 'off', translate: 'no', 'aria-label': recovery ? '恢复密钥' : 'API 凭据' });
  output.value = secret;
  const panel = h('div', { class: 'stack' }, notice('warn', '请妥善保存，不要分享或截图。', recovery ? '新恢复密钥替代旧密钥。它仅用于设密或重置密码，不能登录或接入商城。' : 'API 凭据独立于登录密码；密码重置不会影响 API 凭据。'), output,
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: async () => {
      if (!secret) return;
      try { await navigator.clipboard.writeText(secret); toast('已复制'); } catch { toast('无法复制，请手动选择并保存。', 'danger'); }
    } }, '复制'), h('button', { class: 'btn', type: 'button', onclick: () => {
      if (!secret) return;
      const url = URL.createObjectURL(new Blob([secret + '\n'], { type: 'text/plain' }));
      const a = h('a', { href: url, download: recovery ? 'upaynow-recovery-key.txt' : 'upaynow-api-key.txt' }); a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } }, '下载备份')));
  return { panel, clear() { secret = ''; output.value = ''; panel.replaceChildren(); } };
}

export function openAuthDialog(app, kind) {
  const epoch = app.authEpoch;
  const current = passwordInput('current-password'), next = passwordInput(), confirm = passwordInput();
  const error = h('div', { class: 'error-text', role: 'alert' });
  const change = kind === 'password', recovery = kind === 'recovery-key';
  let revealed, unregister;
  const clearFields = () => { current.value = ''; next.value = ''; confirm.value = ''; };
  const dialog = openDialog({ title: change ? '修改密码' : recovery ? '备份恢复密钥' : '查看 API 凭据', onClose: () => { clearFields(); revealed?.clear(); unregister?.(); } });
  unregister = registerAuthUI(() => dialog.close());
  const submit = h('button', { class: 'btn primary', type: 'submit' }, change ? '修改密码并退出' : '验证并查看');
  const form = h('form', { class: 'stack', novalidate: true, onsubmit: e => {
    e.preventDefault();
    if (submit.disabled) return;
    error.textContent = '';
    const validation = change ? passwordError(next.value, confirm.value) : '';
    if (!current.value || validation) { error.textContent = validation || '请输入当前密码。'; return; }
    busy(submit, async () => {
      const body = change ? { currentPassword: current.value, newPassword: next.value } : { password: current.value };
      try {
        const result = await app.client.post('auth/' + kind, body);
        if (dialog.closed || app.authEpoch !== epoch || app.state.auth !== 'in') return;
        clearFields();
        if (change) { dialog.close(); app.setAuth('out'); return; }
        const value = recovery ? result.recoveryKey : result.apiKey;
        if (typeof value !== 'string' || !value) throw new Error('后台未返回凭据，请重试。');
        revealed = secretPanel(value, { recovery });
        dialog.setBody(revealed.panel); dialog.setFoot(h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, '关闭'));
      } finally { for (const key of Object.keys(body)) body[key] = ''; }
    }, { onError: err => { if (!dialog.closed && app.authEpoch === epoch) { current.value = ''; error.textContent = errorMessage(err); } } });
  } }, notice('info', '请再次验证当前密码。', change ? '修改后所有浏览器会话都会退出，请用新密码重新登录。' : '验证成功后仅在此弹窗临时显示，关闭即清空。'), field('当前密码', current),
  change ? [field('新密码', next, { hint: '密码须为 12–128 个字符，且不能全为空白；首尾空格会保留。' }), field('确认新密码', confirm)] : null, error, submit);
  dialog.setBody(form);
}
