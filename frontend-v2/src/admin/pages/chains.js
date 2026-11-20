import { h, badge, copyable, notice, field, trustedSvg, kv } from '../../shared/dom.js';
import { CHAINS, chainName, shortAddr, dateTime, relative, countdown } from '../../shared/format.js';
import { deployJob, errorText } from '../../shared/status.js';
import { openDialog, confirmDialog, busy, toast, errorMessage, emptyState, loadingRows, handoffPanel , actionButton } from '../ui.js';

import { desktopFlow, pendingRecoveryButton, claimWalletChoice } from '../desktop-flow.js';
import { deterministic, bootstrap, deterministicStage } from '../../shared/deployment-guard.js';

const IMPORT_PRESETS = [
  { id: 1, rpc: 'https://ethereum-rpc.publicnode.com' }, { id: 56, rpc: 'https://bsc-rpc.publicnode.com' },
  { id: 8453, rpc: 'https://base-rpc.publicnode.com' }, { id: 42161, rpc: 'https://arbitrum-one-rpc.publicnode.com' },
  { id: 137, rpc: 'https://polygon-bor-rpc.publicnode.com' },
];

export function chainsPage(app, route) {
  const tab = route.arg === 'records' ? 'records' : 'list';
  return h('div', null,
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, '链与合约'), h('p', { class: 'lead' }, '每套部署是一条链上的一个收款合约。收款钱包和支持币种部署后不可修改；需要变更时请新增一套部署，旧订单保持不变。')),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: () => openAddChain(app) }, '添加链'))),
    h('div', { class: 'tabs', role: 'tablist' },
      h('a', { class: ['tab', tab === 'list' && 'active'], href: '#/chains/list', role: 'tab' }, '已接入的部署'),
      h('a', { class: ['tab', tab === 'records' && 'active'], href: '#/chains/records', role: 'tab' }, '部署记录',
        (() => { const n = app.state.deploymentJobs.filter(j => j.state === 'UNKNOWN').length; return n ? badge(String(n), 'unknown', true) : null; })())),
    tab === 'list' ? deploymentList(app) : recordsView(app, route.rest[1]));
}

function deploymentList(app) {
  const s = app.state;
  if (!s.loaded.deployments) return h('section', { class: 'card' }, loadingRows(3));
  const list = s.deployments.filter(d => d.factory || d.error);
  if (!list.length) return h('section', { class: 'card' }, emptyState('还没有接入任何部署', '添加一条链：可以用钱包部署新的收款合约，也可以导入已有合约。',
    h('button', { class: 'btn primary', type: 'button', onclick: () => openAddChain(app) }, '添加链')));
  return h('div', { class: 'stack' }, list.map(d => h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('div', null, h('div', { class: 'row wrap' }, h('h2', { translate: d.name ? 'no' : undefined }, chainName(d.chainId, d.name)),
      d.id === s.selectedId ? badge('当前管理', 'info', true) : null, d.error ? badge('加载失败', 'danger') : null, d.scheme === 'legacy-v1' ? badge('旧版 · 不支持错链找回', 'neutral', true) : null, d.id === 'legacy' ? badge('原有部署', 'neutral', true) : null),
      h('div', { class: 'sub' }, `Chain ID ${d.chainId ?? '—'} · gas 币 ${d.nativeSymbol || '—'}`)),
      h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'button', onclick: () => openRenameDeployment(app, d) }, '编辑名称'),
        d.id !== s.selectedId && !d.error ? h('button', { class: 'btn small', type: 'button', onclick: () => app.selectDeployment(d.id) }, '切换到此部署') : null)),
    h('div', { class: 'card-body' }, kv([
      ['收款合约 Factory', copyable(d.factory, { full: true })],
      ['固定收款钱包', copyable(d.payout, { full: true })],
      ['支持币种', h('div', { class: 'token-chips' }, (d.tokens || []).map(t => h('span', { class: 'token-chip' }, h('strong', null, t.symbol), h('span', { class: 'mono' }, t.address))))],
      ['部署 ID', h('code', null, d.id)],
    ])))));
}

function openRenameDeployment(app, deployment) {
  const d = openDialog({ title: '编辑部署名称', sub: '仅修改显示备注，不改变合约、收款钱包或已有订单。' });
  const error = h('div', { class: 'error-text', role: 'alert' });
  const input = h('input', { class: 'input', value: deployment.name || '', maxlength: 128, autocomplete: 'off',
    oninput: () => { error.textContent = ''; },
    onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); save(); } } });
  let saving = false;
  const save = async () => {
    if (saving) return;
    const name = input.value.trim();
    if (!name || name.length > 128) { error.textContent = '名称不能为空，且不能超过 128 个字符。'; input.focus(); return; }
    saving = true; input.disabled = true; saveButton.textContent = '保存中…';
    try {
      await busy(saveButton, async () => {
        const updated = await app.client.post(`deployments/${deployment.id}/name`, { name });
        await app.refreshDeployments();
        app.state.deployments = app.state.deployments.map(item => item.id === deployment.id ? { ...item, name: updated.name } : item);
        app.render(); d.close(); toast('名称已更新。', 'success');
      }, { onError: e => { error.textContent = errorMessage(e); } });
    } finally { saving = false; input.disabled = false; saveButton.textContent = '保存'; }
  };
  const saveButton = h('button', { class: 'btn primary', type: 'button', onclick: save }, '保存');
  d.setBody(field('显示名称', input, '最多 128 个字符，允许与其他部署重名。'), error);
  d.setFoot(h('button', { class: 'btn', type: 'button', onclick: () => d.close() }, '取消'), saveButton);
}

// ---------- 添加链（每次打开都是全新表单：F8） ----------
export function openAddChain(app, defaults = {}) {
  const form = { scheme: 'deterministic-v2', preset: '', chainId: '', name: '', nameAuto: true, rpcUrl: '', nativeSymbol: '', payout: '', tokens: '', confirmations: '12', importMode: false, factory: '', startBlock: '' };
  for (const name of ['chainId', 'name', 'rpcUrl', 'nativeSymbol', 'payout', 'confirmations']) if (defaults[name] !== undefined) form[name] = String(defaults[name]);
  if (defaults.tokens) form.tokens = defaults.tokens.map(t => t.address || t).join('\n');
  let step = 'params', verified = null, verifiedKey = null, sending = null, error = null;
  let networks = [], networksReady = false, networksError = null;
  const key = () => JSON.stringify([form.scheme, form.importMode, form.chainId, form.rpcUrl.trim(), form.nativeSymbol.trim(), form.payout.trim().toLowerCase(),
    form.tokens.split(/\s+/).filter(Boolean).map(s => s.toLowerCase()), form.confirmations, form.importMode ? form.factory.trim().toLowerCase() : '', form.startBlock, form.name.trim()]);
  const d = openDialog({ title: '添加链', wide: true });

  const input = (name, attrs = {}) => {
    const el = h(attrs.textarea ? 'textarea' : 'input', { class: ['input', attrs.mono && 'mono'], value: form[name], readonly: attrs.readonly, placeholder: attrs.placeholder || '', autocomplete: 'off', spellcheck: 'false',
      oninput: e => {
        form[name] = e.target.value;
        if (name === 'name') form.nameAuto = !e.target.value.trim();     // user-typed name is kept; clearing it restores auto naming (F2)
        // Edited after verification: the old READY record stays in 部署记录 but is no
        // longer the sendable result of this form (F3). No redraw, so focus is kept.
        if (verified && key() !== verifiedKey) verified = null;
      } });
    if (attrs.textarea) el.value = form[name];
    return el;
  };

  function applyPreset(value) {
    form.preset = value;
    const p = form.importMode ? IMPORT_PRESETS.map(p => ({ chainId: p.id, defaultRPC: p.rpc, name: CHAINS[p.id].name, nativeSymbol: CHAINS[p.id].native })).find(p => String(p.chainId) === value) : networks.find(p => String(p.chainId) === value);
    form.chainId = p ? String(p.chainId) : ''; form.rpcUrl = p?.defaultRPC || ''; form.nativeSymbol = p?.nativeSymbol || '';
    if (form.nameAuto) form.name = p?.name || '';
    if (verified && key() !== verifiedKey) verified = null;
    draw();
  }

  function payload() {
    const tokens = form.tokens.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    return { name: form.name.trim() || chainName(form.chainId), chainId: Number(form.chainId), rpcUrl: form.rpcUrl.trim(), nativeSymbol: form.nativeSymbol.trim(),
      payout: form.payout.trim(), tokens, confirmations: Number(form.confirmations), scheme: form.importMode ? form.scheme : 'deterministic-v2',
      ...(form.importMode ? { factory: form.factory.trim(), ...(form.startBlock ? { startBlock: Number(form.startBlock) } : {}) } : {}) };
  }
  function localCheck(p) {
    if (!form.importMode && (!networksReady || !networks.some(n => n.chainId === p.chainId))) return networksError || '请选择已开放网络，当前网络尚未开放新建部署。';
    if (!Number.isSafeInteger(p.chainId) || p.chainId <= 0) return '请填写 Chain ID。';
    let url; try { url = new URL(p.rpcUrl); } catch { return 'RPC 地址无效。'; }
    if (url.protocol !== 'https:') return errorText('RPC_HTTPS_REQUIRED');
    if (url.username || url.password) return errorText('RPC_CREDENTIALS_NOT_ALLOWED');
    if (!/^0x[0-9a-fA-F]{40}$/.test(p.payout)) return '请填写正确的收款钱包地址。';
    if (!p.tokens.length || p.tokens.some(t => !/^0x[0-9a-fA-F]{40}$/.test(t))) return '请逐行填写正确的代币合约地址（CA）。';
    if (new Set(p.tokens.map(t => t.toLowerCase())).size !== p.tokens.length) return errorText('DUPLICATE_TOKEN');
    if (!Number.isSafeInteger(p.confirmations) || p.confirmations < 1 || p.confirmations > 256) return '确认数需在 1–256 之间。';
    if (form.importMode && !/^0x[0-9a-fA-F]{40}$/.test(p.factory)) return '请填写已有 Factory 合约地址。';
    return null;
  }

  function steps() {
    const order = ['params', 'review', 'send'], i = order.indexOf(step);
    return h('div', { class: 'steps' }, ['填写参数', '核对', form.importMode ? '完成' : '钱包确认'].map((t, n) => h('span', { class: n === i ? 'on' : n < i ? 'done' : '' }, `${n + 1}. ${t}`)));
  }

  function draw() {
    if (d.closed) return;
    if (step === 'params') {
      d.setTitle('添加链', '填写参数并验证。验证只读取链上信息，不会发送交易。');
      d.setBody(steps(),
        form.scheme === 'deterministic-v2' && !form.importMode ? notice('warn', '签名钱包必须等于固定收款 payout', '同地址部署防抢占：不能签名的收款地址不支持此模式。仅添加 RPC 不代表支持；必须通过官方 EIP-2470 入口及链上代码核验。公共入口仅由运营方预部署；未开放的网络不能创建商户部署任务。本页只部署商户合约。') : null,
        h('details', { class: 'advanced', open: form.importMode }, h('summary', null, '高级／历史兼容：导入已有合约'),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: form.importMode, onchange: e => { form.importMode = e.target.checked; form.scheme = 'deterministic-v2'; verified = null; error = null; applyPreset(''); } }),
            h('span', null, h('strong', null, '导入已有收款合约'), h('span', { class: 'muted' }, ' · 只核验已有合约，不创建新合约或支付部署 gas'))),
          form.importMode ? field('合约版本（仅导入）', h('select', { onchange: e => { form.scheme = e.target.value; verified = null; draw(); } },
            h('option', { value: 'deterministic-v2', selected: form.scheme === 'deterministic-v2' }, '跨链同址合约（deterministic-v2）'),
            h('option', { value: 'legacy-v1', selected: form.scheme === 'legacy-v1' }, '旧版合约（legacy-v1，仅历史导入）'))) : null),
        h('div', { class: 'form-grid' },
          field('网络', h('select', { disabled: !form.importMode && !networksReady, onchange: e => applyPreset(e.target.value) }, h('option', { value: '', selected: !form.preset }, form.importMode ? '自定义 EVM 链（仅导入）' : '请选择已开放网络'),
            (form.importMode ? IMPORT_PRESETS.map(p => ({ chainId: p.id, name: CHAINS[p.id].name })) : networks).map(p => h('option', { value: String(p.chainId), selected: form.preset === String(p.chainId) }, `${p.name} · ${p.chainId}`)))),
          field('显示名称', input('name', { placeholder: '例如：BNB Smart Chain' }), { hint: form.nameAuto ? '随网络自动填写；手动修改后会保留你的名称。' : '已使用你填写的名称。清空后恢复自动名称。' }),
          field('Chain ID', input('chainId', { readonly: !form.importMode })),
          field('gas 原生币符号', input('nativeSymbol', { readonly: !form.importMode })),
          h('details', { class: 'full', open: form.importMode }, h('summary', null, '高级：自定义 RPC（HTTPS）'), field('RPC 地址（HTTPS）', input('rpcUrl', { mono: true, placeholder: 'https://…' }), { hint: '仍会核验 Chain ID、固定入口及代码；不能包含用户名密码。带密钥的 RPC 会显示在记录中，请谨慎使用。' })),
          h('div', { class: 'full' }, field('固定收款钱包 payout', input('payout', { mono: true, placeholder: '0x…' }), { hint: '所有归集资金都只能进入这个地址，部署后不可修改。请使用你能长期控制的钱包。' })),
          h('div', { class: 'full' }, field('支持的代币合约地址（每行一个）', input('tokens', { textarea: true, mono: true, placeholder: '0x…\n0x…' }), { hint: '必须是这条链上的准确 CA，不按名称识别。部署后不能增减。' })),
          field('付款确认数', input('confirmations'), { hint: '到账后等待的区块数。确认数不等于绝对不可回滚。' }),
          form.importMode ? field('已有 Factory 地址', input('factory', { mono: true, placeholder: '0x…' })) : h('div'),
          form.importMode ? field('起始扫描区块（可选）', input('startBlock', { placeholder: '默认 0' })) : null),
        !form.importMode && !networksReady ? notice('danger', networksError || '正在加载已开放网络；加载完成前禁止新建部署。') : null,
        error ? notice('danger', error) : null);
      d.setFoot(h('span', { class: 'left' }, '关闭此窗口不会影响已有部署或部署记录。'),
        h('button', { class: 'btn', type: 'button', onclick: () => d.close() }, '取消'),
        h('button', { class: 'btn primary', type: 'button', disabled: !form.importMode && !networksReady, onclick: e => verify(e.currentTarget) }, form.importMode ? '验证并导入' : '验证参数'));
    } else if (step === 'review') {
      const j = verified, s = j.summary;
      d.setTitle('核对部署参数', '请逐项核对。确认后才会请求钱包签名。');
      d.setBody(steps(), h('div', { class: 'summary-box' }, kv([
        ['网络', `${s.name} · Chain ID ${s.chainId} · gas ${s.nativeSymbol}`], ['固定收款钱包', copyable(s.payout, { full: true })],
        ['支持币种', h('div', { class: 'stack tight' }, (s.tokens || []).map(t => h('div', null, h('strong', { translate: 'no' }, t.symbol || ''), ` · decimals ${t.decimals ?? '—'} · `, h('code', null, t.address || t))))],
        ['付款确认数', String(s.confirmations)], ['RPC', h('code', null, s.rpcUrl)], ['部署记录', h('code', null, j.id)]])),
        deterministic(j) ? notice('info', bootstrap(j) ? '准备同地址部署入口' : '部署商户合约', `预期 Factory：${s.predictedFactory}。签名钱包必须为 ${s.payout}。${bootstrap(j) ? '本笔只准备公共入口；成功后需再次点击部署商户合约，不会自动签第二笔。' : '本笔核验成功才会注册商户部署。'}`) : null,
        notice('warn', '部署后不可修改', '收款钱包和支持币种会写入合约，部署后不能更改。若要修改，请返回上一步重新验证。'));
      d.setFoot(h('button', { class: 'btn', type: 'button', onclick: () => { step = 'params'; draw(); } }, '返回修改'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => { if (key() !== verifiedKey) { verified = null; step = 'params'; return draw(); } step = 'send'; draw(); } }, '下一步：选择钱包'));
    } else if (step === 'send') {
      d.setTitle('选择钱包确认部署', `部署记录 ${verified.id.slice(0, 8)}… · 部署 gas 由该钱包支付`);
      d.setBody(steps(), sendChoices(app, verified, d), notice(null, null, '钱包返回哈希前断开、超时或关闭窗口，都不代表部署失败。请到“部署记录”中登记原交易哈希，不要重新部署。'));
      d.setFoot(h('button', { class: 'btn', type: 'button', onclick: () => { step = 'review'; draw(); } }, '返回'));
    }
  }

  async function verify(button) {
    error = null;
    if (!form.importMode && verified && key() === verifiedKey) { step = 'review'; return draw(); } // unchanged: reuse the same record
    const p = payload(), problem = localCheck(p);
    if (problem) { error = problem; return draw(); }
    await busy(button, async () => {
      if (form.importMode) {
        const entry = await app.client.post('deployments/import', p);
        await app.refreshDeployments(); toast(`已导入 ${entry?.name || '部署'}`); d.close(); app.selectDeployment(entry.id);
      } else {
        const snapshot = key();
        let stage;
        if (p.scheme === 'deterministic-v2') {
          const preview = await app.client.post('deterministic/preview', p);
          stage = deterministicStage(preview);
          if (preview.factoryReady) throw new Error('该同地址商户合约已存在，请核对后使用导入已有合约。');
        }
        const job = await app.client.post('deployment-jobs', { ...p, ...(stage ? { stage } : {}) });
        if (key() !== snapshot) { error = '验证期间参数被修改，请重新验证。'; return draw(); }
        verified = job; verifiedKey = snapshot; step = 'review'; draw(); app.refresh();
      }
    }, { onError: e => { error = errorMessage(e); draw(); } });
  }
  draw();
  app.client.get('deployment-networks').then(list => {
    if (!Array.isArray(list) || !list.length || list.some(n => !Number.isSafeInteger(n.chainId) || !n.name || !n.nativeSymbol || !n.defaultRPC)) throw new Error('INVALID_NETWORK_LIST');
    networks = list; networksReady = true;
    if (!form.importMode) applyPreset(networks.some(n => String(n.chainId) === form.chainId) ? form.chainId : '');
    else draw();
  }).catch(() => { networks = []; networksReady = false; networksError = '已开放网络名单加载失败，已禁用新建部署。请关闭后重试；仍可导入已有合约。'; draw(); });
}

function sendChoices(app, job, d) {
  return h('div', { class: 'choice' },
    h('button', { type: 'button', onclick: () => deployPhone(app, job, d) }, h('span', { class: 't' }, '手机钱包扫码'), h('span', { class: 'd' }, '临时开放 5 分钟的专用页面，在手机钱包内置浏览器中核对并确认。')),
    h('button', { type: 'button', onclick: () => desktopFlow(app, d, { kind: 'injected', deploymentId: app.state.selectedId, deploymentJob: job }) }, h('span', { class: 't' }, bootstrap(job) ? '准备同地址部署入口' : deterministic(job) ? '部署商户合约' : '本机浏览器钱包'), h('span', { class: 'd' }, '使用浏览器扩展钱包，单次确认。')),
    h('button', { type: 'button', onclick: () => desktopFlow(app, d, { kind: 'walletconnect', deploymentId: app.state.selectedId, deploymentJob: job }) }, h('span', { class: 't' }, 'WalletConnect'), h('span', { class: 'd' }, '需要你自己的 Reown Project ID。')));
}

function deployPhone(app, job, d) {
  if (!claimWalletChoice(d)) return;
  d.setTitle('手机钱包确认部署', '正在启动临时入口…');
  d.setBody(h('div', { class: 'row' }, h('span', { class: 'spinner' }), '正在准备手机入口，首次使用会自动下载所需组件，请勿重复点击。')); d.setFoot();
  app.client.post(`deployment-jobs/${job.id}/handoff`, {}).then(r => {
    if (d.closed) return;
    const left = h('span', { class: 'countdown' });
    const timer = setInterval(() => { const ms = new Date(r.expiresAt).getTime() - Date.now(); left.textContent = ms > 0 ? `入口剩余 ${countdown(ms)}` : '入口已到期'; if (ms <= 0) clearInterval(timer); }, 1000);
    d.setTitle('用手机钱包扫码部署', bootstrap(job) ? '本次仅准备公共入口；完成后还需另行确认商户部署。' : '在手机上核对全部参数后确认。完成后会自动加入部署列表。');
    d.setBody(handoffPanel({ qrSvg: r.qrSvg, url: r.url, countdownEl: left,
      steps: ['用手机钱包的内置浏览器扫码', '逐项核对网络、收款钱包和支持币种', '在手机上确认部署并支付 gas'],
      warning: '入口到期或关闭不会取消已签名的交易，结果请在“部署记录”中查看。' }).panel);
    d.setFoot(h('button', { class: 'btn', type: 'button', onclick: e => busy(e.currentTarget, async () => { await app.client.post('deployment-tunnel/close', {}); clearInterval(timer); toast('已关闭部署入口。'); d.close(); }) }, '关闭入口'),
      h('a', { class: 'btn primary', href: '#/chains/records/' + job.id, onclick: () => { clearInterval(timer); d.close(); } }, '查看部署记录'));
  }).catch(e => { if (!d.closed) { d.setBody(notice('danger', errorMessage(e), '没有发送交易。')); d.setFoot(h('button', { class: 'btn', type: 'button', onclick: () => d.close() }, '关闭')); } });
}

// ---------- 部署记录（独立入口：U1 / U2） ----------
function recordsView(app, selectedId) {
  const s = app.state, jobs = s.deploymentJobs;
  if (!s.loaded.deploymentJobs) return h('section', { class: 'card' }, loadingRows(3));
  if (!jobs.length) return h('section', { class: 'card' }, emptyState('还没有部署记录', '通过“添加链”验证参数后，会在这里生成一条部署记录。'));
  const current = jobs.find(j => j.id === selectedId);
  return h('div', { class: 'grid two' },
    h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('div', null, h('h2', null, '部署记录'), h('div', { class: 'sub' }, '这是收款合约的部署记录，不是顾客订单。'))),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('tbody', null, jobs.map(j => {
        const st = deployJob(j);
        return h('tr', { class: ['clickable', j.id === selectedId && 'selected'], onclick: () => app.go('chains/records/' + j.id) },
          h('td', null, h('strong', { translate: 'no' }, j.summary?.name || '—'), h('span', { class: 'sub' }, `Chain ${j.summary?.chainId} · ${dateTime(j.createdAt)}`)),
          h('td', null, badge(st.label, st.tone)));
      }))))),
    current ? recordDetail(app, current) : h('section', { class: 'card' }, emptyState('选择一条部署记录', '查看状态、登记原交易哈希或登记明确拒签。')));
}

function recordDetail(app, j) {
  const st = deployJob(j), s = j.summary || {};
  const canAttach = (j.state === 'UNKNOWN' && !j.candidateHash) || j.state === 'CANCELLED';
  const canReject = j.state === 'READY' || (j.state === 'UNKNOWN' && !j.candidateHash);
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('div', null, h('div', { class: 'row wrap' }, h('h2', { translate: s.name ? 'no' : undefined }, s.name || '部署记录'), badge(st.label, st.tone)), h('div', { class: 'sub' }, `更新于 ${relative(j.updatedAt || j.createdAt)}`))),
    h('div', { class: 'card-body stack' },
      j.state === 'UNKNOWN' && !j.candidateHash ? notice('unknown', '部署交易结果未知', '交易可能已由钱包发出。请在发送钱包中找到对应的原交易并登记哈希；不要重新发送。') : null,
      j.state === 'UNKNOWN' && j.candidateHash ? notice('info', '已登记交易哈希，正在等待确认', bootstrap(j) ? '达到确认数并通过代码核验后，公共入口即就绪；仍需单独确认下一笔商户部署。' : '达到确认数并通过合约核验后，会自动加入部署列表。') : null,
      j.state === 'MINED' && j.outcome === 'SUCCESS' ? bootstrap(j)
        ? notice('ok', '公共入口已准备就绪', '尚未注册商户部署。请主动创建下一笔商户部署任务，再核对并签名。', h('button', { class: 'btn small primary', type: 'button', onclick: e => busy(e.currentTarget, async () => {
          if (!s.tokens?.length) { openAddChain(app, s); return; }
          const p = { ...s, scheme: 'deterministic-v2', tokens: (s.tokens || []).map(t => t.address || t) };
          const preview = await app.client.post('deterministic/preview', p);
          if (deterministicStage(preview) !== 'merchant' || preview.factoryReady) throw new Error('入口未就绪或商户合约已存在，请重新核对。');
          const next = await app.client.post('deployment-jobs', { ...p, stage: 'merchant' });
          await app.refresh(); app.go('chains/records/' + next.id);
        }) }, '部署商户合约（下一笔确认）'))
        : notice('ok', '部署成功', '已通过链上核验并加入部署列表。', h('div', null, h('button', { class: 'btn small', type: 'button', onclick: () => j.deploymentId && app.selectDeployment(j.deploymentId) }, '切换到此部署'))) : null,
      j.state === 'MINED' && j.outcome !== 'SUCCESS' ? notice('danger', '部署交易已上链但没有成功', '没有添加任何可用合约。可以修正后重新添加链。') : null,
      j.state === 'CANCELLED' ? notice(null, '已登记为钱包拒签', '如果这笔交易其实已经发出，仍可登记原交易哈希恢复。') : null,
      kv([['网络', `Chain ID ${s.chainId} · ${s.nativeSymbol || ''}`], ['固定收款钱包', copyable(s.payout)],
        ['模式 / 阶段', `${s.scheme || j.scheme || 'legacy-v1'} / ${s.stage || j.stage || '普通部署'}`], ...(deterministic(j) ? [['预期 Factory', copyable(s.predictedFactory)], ['签名钱包', copyable(s.payout)]] : []),
        ['支持币种', (s.tokens || []).map(t => t.symbol || shortAddr(t.address || t)).join('、')], ['发送钱包', j.from ? copyable(j.from) : '尚未开始'],
        ['交易哈希', j.txHash || j.candidateHash ? copyable(j.txHash || j.candidateHash) : '尚未登记'], ['Factory', j.factory ? copyable(j.factory) : '—'], ['记录 ID', h('code', null, j.id)]]),
      h('div', { class: 'row wrap' },
        pendingRecoveryButton(app, 'deployment:' + j.id),
        actionButton(app, 'deploy-refresh:' + j.id, { pendingLabel: '正在刷新…' }, '刷新状态', async () => { await app.client.get('deployment-jobs/' + j.id); await app.refresh(); toast('已刷新。'); }),
        canAttach ? h('button', { class: 'btn small primary', type: 'button', onclick: () => attachDeployHash(app, j) }, '登记原交易哈希') : null,
        canReject ? h('button', { class: 'btn small', type: 'button', onclick: async () => {
          const ok = await confirmDialog({ title: '登记钱包明确拒签', confirmText: '登记拒签',
            body: [h('p', null, '只在钱包明确显示“已拒绝”时使用。登记后保留这条记录，不证明交易未广播。')], requireCheck: '我确认钱包显示的是“已拒绝”。' });
          if (ok) busy(null, async () => { await app.client.post(`deployment-jobs/${j.id}/cancel`, { rejected: true }); toast('已登记拒签。'); app.refresh(); });
        } }, '登记明确拒签') : null,
        j.state === 'READY' ? h('button', { class: 'btn small', type: 'button', onclick: () => { const d = openDialog({ title: '选择钱包确认部署' }); d.setBody(sendChoices(app, j, d)); } }, '继续部署') : null)));
}

function attachDeployHash(app, j) {
  const input = h('input', { class: 'input mono', placeholder: '0x 开头，共 66 位', autocomplete: 'off', spellcheck: 'false' });
  const err = h('div', { class: 'error-text', role: 'alert' });
  const d = openDialog({ title: '登记原部署交易哈希', sub: '只登记已经发出的那笔创建合约交易，不会发送新交易。',
    body: [field('交易哈希', input), notice('warn', '请仔细核对后再登记', '当前后台版本中，一条部署记录登记哈希后不能再更换；登记错误需要通过“导入已有收款合约”接入真实部署。'), err],
    foot: [h('button', { class: 'btn', type: 'button', onclick: () => d.close() }, '取消'),
      h('button', { class: 'btn primary', type: 'button', onclick: e => {
        const hash = input.value.trim();
        if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) { err.textContent = errorText('INVALID_TRANSACTION_HASH'); return; }
        busy(e.currentTarget, async () => { await app.client.post(`deployment-jobs/${j.id}/attach`, { transactionHash: hash }); d.close(); toast('已登记，正在核验。'); app.refresh(); },
          { onError: error => { err.textContent = errorMessage(error); } });
      } }, '登记并核验')] });
}
