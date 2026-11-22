import { h, badge, copyable, notice, field, trustedSvg, replace } from '../../shared/dom.js';
import { amount, dateTime, relative, shortAddr, countdown, chainName, fromUnits } from '../../shared/format.js';
import { job as jobStatus, needsRecovery, isActiveJob, errorText } from '../../shared/status.js';
import { openDialog, confirmDialog, busy, toast, errorMessage, emptyState, loadingRows, persistentDetails, handoffPanel , actionButton, isPending } from '../ui.js';

import { desktopFlow, desktopBusy, pendingRecoveryButton, claimWalletChoice } from '../desktop-flow.js';

import { readRecovery, recoveryStore } from '../transaction.js';

const TABS = [['ready', '可归集'], ['recovery', '异常恢复'], ['records', '归集记录']];

export function collectPage(app, route) {
  const s = app.state, tab = TABS.some(t => t[0] === route.arg) ? route.arg : 'ready';
  const recoveryCount = s.jobs.filter(needsRecovery).length;
  return h('div', null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, '归集'),
      h('p', { class: 'lead' }, '把订单地址中的资金转入固定收款钱包。交易由你的钱包确认并支付 gas，后台不保管私钥。'))),
    h('div', { class: 'tabs', role: 'tablist' }, TABS.map(([id, label]) => h('a', { class: ['tab', tab === id && 'active'], role: 'tab', href: '#/collect/' + id, 'aria-selected': String(tab === id) },
      label, id === 'recovery' && recoveryCount ? badge(String(recoveryCount), 'unknown', true) : null))),
    tab === 'ready' ? readyTab(app) : tab === 'recovery' ? recoveryTab(app) : recordsTab(app));
}

// ---------- 可归集 ----------
function readyTab(app) {
  const s = app.state, preview = s.ui.collectPreview?.deploymentId === s.selectedId ? s.ui.collectPreview : null;
  const active = s.jobs.find(isActiveJob);
  const stale = preview && Date.now() - preview.at > 120000;
  const deploymentId = s.selectedId;
  const key = 'collect-preview:' + deploymentId, checking = isPending(key);
  const run = async () => {
    try {
      const value = await app.client.post('collect-all/preview', {}, { deploymentId });
      s.ui.collectPreview = { deploymentId, at: Date.now(), value, error: null };
    } catch (error) { s.ui.collectPreview = { deploymentId, at: Date.now(), value: null, error }; }
  };
  return h('div', { class: 'stack' },
    active ? notice('unknown', '有一笔归集交易仍在处理或结果未知', '仅暂停这笔交易涉及的订单；其他订单仍可正常归集，也可核实后人工更改结果。', h('div', null, h('a', { class: 'btn small', href: '#/collect/recovery' }, '去异常恢复'))) : null,
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', null, h('h2', null, '一键归集已付足订单'),
        h('div', { class: 'sub' }, '只包含有效期内已确认付足、且订单地址当前仍有该币种余额的订单；刚好付足和超额付款都包含。')),
        actionButton(app, key, { class: 'btn primary', pendingLabel: '正在核对…' }, preview ? '重新核对' : '核对可归集订单', run)),
      checking ? h('div', { class: 'card-body row' }, h('span', { class: 'spinner' }), h('span', { class: 'muted' }, '正在同步链上记录并逐笔读取实时余额，通常需要几秒到十几秒，请勿重复点击。'))
        :
      !preview ? h('div', { class: 'card-body muted' }, '点击“核对可归集订单”后，后台会先同步链上记录，再逐笔读取订单地址的实时余额。这一步不发送交易。')
        : preview.error ? h('div', { class: 'card-body' }, notice('warn', '暂时不能核对', errorMessage(preview.error)))
        : !preview.value.entries.length ? preview.value.heldCount
          ? emptyState('所选订单仍在等原交易核对', '这些订单暂未解锁。请到异常恢复查看，勿重复发起。')
          : emptyState('没有可归集的订单', '已付足订单的余额都已归集，或尚未达到确认数。')
        : h('div', null,
          preview.value.heldCount ? h('div', { class: 'card-body' }, notice('unknown', '部分订单仍在等原交易核对', '本次仅列出未锁定的订单。')) : null,
          stale ? h('div', { class: 'card-body' }, notice('warn', '核对结果已超过 2 分钟', '余额可能已变化，请重新核对后再发起。')) : null,
          h('div', { class: 'table-wrap' }, h('table', { class: 'table responsive' },
            h('thead', null, h('tr', null, h('th', null, '商户订单号'), h('th', { class: 'num' }, '应付'), h('th', { class: 'num' }, '当前余额（将全部归集）'))),
            h('tbody', null, preview.value.entries.map(e => h('tr', null, h('td', { class: 'ref' }, e.reference),
              h('td', { class: 'num' }, amount(e.expectedAmount), ' ', e.symbol), h('td', { class: 'num' }, h('strong', null, amount(e.balance)), ' ', e.symbol)))))),
          h('div', { class: 'card-body row between wrap' },
            h('div', { class: 'muted small' }, `核对于 ${dateTime(preview.at)} · 资金去向：固定收款钱包 `, h('code', null, shortAddr(preview.value.payout, 8, 6))),
            h('button', { class: 'btn primary', type: 'button', disabled: stale,
              onclick: () => startCollection(app, { mode: 'paid', orderIds: preview.value.entries.map(e => e.id), entries: preview.value.entries }) }, `归集这 ${preview.value.entries.length} 笔`)))),
    phoneChannelCard(app));
}

function phoneChannelCard(app) {
  const t = app.state.handoffConfig?.tunnel, deploymentId = app.state.selectedId;
  if (!app.state.handoffConfig?.enabled) return null;
  const running = t && ['STARTING', 'RUNNING', 'CLOSING'].includes(t.state);
  return h('section', { class: 'card' }, h('div', { class: 'card-head' },
    h('div', null, h('h2', null, '手机归集入口'), h('div', { class: 'sub' }, '仅在你发起归集时临时开放，最长 5 分钟；只能处理本批订单，不暴露管理后台。')),
    running ? actionButton(app, 'tunnel-close:' + deploymentId, { class: 'btn danger small', pendingLabel: '正在关闭…' }, '立即关闭', async () => {
      await app.client.post('handoffs/tunnel/close', {}, { deploymentId }); toast('已关闭手机入口。已发送的交易不受影响。'); app.refresh();
    }) : null),
    h('div', { class: 'card-body row wrap' }, running ? badge('开放中', 'info') : badge('未开放', 'neutral'),
      running && t.expiresAt ? h('span', { class: 'muted small' }, `截止 ${dateTime(t.expiresAt)}`) : h('span', { class: 'muted small' }, '平时不开放任何公网入口。')));
}

// ---------- 发起归集（发送方式） ----------
export function startCollection(app, { mode, orderIds, entries, token, wrongToken }) {
  if (desktopBusy() || app.state.ui.collectionOpen) return toast('有钱包确认流程正在进行，请先完成或关闭该窗口。', 'danger');
  if (app.state.jobs.some(j => isActiveJob(j) && j.orderIds?.some(id => orderIds.includes(id)))) return toast('选中的订单仍有未处理交易，请先恢复这些订单；其他订单不受影响。', 'danger');
  if (!Array.isArray(orderIds) || !orderIds.length || orderIds.some(id => !app.state.orders.some(o => o.id === id))) return toast('订单不属于当前部署或尚未读取完成，请重新核对。', 'danger');
  app.state.ui.collectionOpen = true;
  const s = app.state, dep = app.selected();
  const deploymentId = s.selectedId;                      // bound for the whole flow; never follows a later switch
  const orders = orderIds.map(id => s.orders.find(o => o.id === id)).filter(Boolean);
  const intent = { mode, orderIds, ...(token ? { token } : {}), ...(wrongToken ? { wrongToken, confirmWrongToken: true } : {}) };
  const summary = h('div', { class: 'summary-box stack tight' },
    h('div', { class: 'row between' }, h('span', { class: 'muted' }, '网络'), h('strong', null, `${chainName(dep?.chainId, dep?.name)} · Chain ${dep?.chainId}`)),
    h('div', { class: 'row between' }, h('span', { class: 'muted' }, '资金去向'), copyable(dep?.payout)),
    h('div', { class: 'row between' }, h('span', { class: 'muted' }, '订单数'), h('strong', null, String(orderIds.length))),
    h('div', { class: 'row between' }, h('span', { class: 'muted' }, '币种'), h('span', { translate: !wrongToken && !token ? 'no' : undefined }, wrongToken ? '错币 / 原生币（手动）' : token ? '其他支持币（手动）' : [...new Set((entries || orders).map(o => o.symbol))].join('、'))));
  const d = openDialog({ onClose: () => { s.ui.collectionOpen = false; }, title: '发起归集', sub: '归集执行时订单地址里该币种的全部余额，包含超额部分。', body: [summary,
    h('div', { class: 'block-title' }, '选择由哪个钱包确认并支付 gas'),
    h('div', { class: 'choice' },
      h('button', { type: 'button', onclick: () => phoneFlow(app, d, deploymentId, intent) }, h('span', { class: 't' }, '手机钱包扫码'),
        h('span', { class: 'd' }, '临时开放一个 5 分钟的专用入口，在手机钱包内置浏览器中核对并确认。')),
      h('button', { type: 'button', onclick: () => desktopFlow(app, d, { kind: 'injected', deploymentId, intent }) }, h('span', { class: 't' }, '本机浏览器钱包'),
        h('span', { class: 'd' }, '使用浏览器扩展钱包（如 MetaMask）。')),
      h('button', { type: 'button', onclick: () => desktopFlow(app, d, { kind: 'walletconnect', deploymentId, intent }) }, h('span', { class: 't' }, 'WalletConnect'),
        h('span', { class: 'd' }, '需要在设置中填写你自己的 Reown Project ID。'))),
    notice(null, null, '关闭窗口、断网或入口到期都不会取消已经签名的交易；结果未知时请到“异常恢复”登记原交易哈希，不要重复发起。')],
    foot: [h('button', { class: 'btn', type: 'button', onclick: () => d.close() }, '取消')] });
}

function phoneFlow(app, d, deploymentId, intent) {
  if (desktopBusy() || !claimWalletChoice(d)) return;
  d.setTitle('手机钱包确认', '正在准备本批范围并启动临时入口，最长约 45 秒。');
  d.setBody(h('div', { class: 'row' }, h('span', { class: 'spinner' }), '正在启动临时 HTTPS 入口…'));
  d.setFoot();
  app.client.post('handoffs', intent, { deploymentId }).then(result => {
    if (d.closed) return;
    const left = h('span', { class: 'countdown' });
    const tick = () => {
      const ms = new Date(result.expiresAt).getTime() - Date.now();
      left.textContent = ms > 0 ? `入口剩余 ${countdown(ms)}` : '入口已到期';
      left.classList.toggle('low', ms < 60000);
      if (ms <= 0) { clearInterval(timer); replace(qr, h('div', { class: 'muted' }, '入口已到期，二维码已失效。')); }
    };
    const { panel, qr } = handoffPanel({ qrSvg: result.qrSvg, url: result.url, countdownEl: left,
      steps: ['用手机钱包的内置浏览器扫码', '核对本批订单和固定收款钱包', '在手机上确认并支付 gas'],
      warning: '持有链接可查看并发起本批归集，资金仍只进入固定收款钱包。手机断开或入口关闭不代表交易失败，结果见“归集记录”。' });
    const timer = setInterval(tick, 1000); tick();
    d.setTitle('用手机钱包扫码', '');
    d.setBody(panel);
    d.setFoot(h('button', { class: 'btn danger', type: 'button', onclick: e => busy(e.currentTarget, async () => {
      await app.client.post('handoffs/' + encodeURIComponent(result.id) + '/revoke', {}, { deploymentId }); clearInterval(timer); d.close(); toast('已作废入口并关闭通道。已发送的交易仍会被核对。');
    }) }, '作废入口'), h('button', { class: 'btn', type: 'button', onclick: () => { clearInterval(timer); d.close(); } }, '收起（入口保持到期）'));
    app.refresh();
  }).catch(error => {
    if (d.closed) return;
    d.setTitle('未能开放手机入口');
    d.setBody(notice('danger', errorMessage(error), '没有发送任何交易。可以稍后重试，或改用本机钱包。'));
    d.setFoot(h('button', { class: 'btn', type: 'button', onclick: () => d.close() }, '关闭'));
  });
}

// Other supported token, or unsupported/native "wrong token", for one order.
export function openTokenCollection(app, order, kind) {
  const tokens = (app.state.status?.config?.tokens || app.selected()?.tokens || []).filter(t => t.address.toLowerCase() !== order.token.toLowerCase());
  const select = h('select', null, tokens.map(t => h('option', { value: t.address, translate: 'no' }, `${t.symbol} · ${shortAddr(t.address, 8, 6)}`)));
  const input = h('input', { class: 'input mono', placeholder: '0x…（原生币填 0x0000000000000000000000000000000000000000）', autocomplete: 'off', spellcheck: 'false' });
  const ack = h('input', { type: 'checkbox' });
  const d = openDialog({
    title: kind === 'wrong' ? '归集错币 / 原生币' : '归集其他支持币',
    sub: `订单 ${order.reference}。不改变订单币种，不计入付款。`,
    body: kind === 'wrong'
      ? [field('代币合约地址', input, { hint: '会调用该合约读取余额并转账，请只填写你核实过的地址。支持币种请用“其他支持币”。' }),
        h('label', { class: 'check' }, ack, '我确认要调用这个合约，并理解它报告的余额不一定可信。')]
      : tokens.length ? [field('币种', select), notice(null, null, '执行时该币种的全部余额会转入固定收款钱包。')] : [notice('info', '当前部署只支持一种币', '没有其他支持币种可归集。')],
    foot: [h('button', { class: 'btn', type: 'button', onclick: () => d.close() }, '取消'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => {
        if (kind === 'wrong') {
          if (!/^0x[0-9a-fA-F]{40}$/.test(input.value.trim())) return toast('请填写完整的合约地址。', 'danger');
          if (!ack.checked) return toast('请先勾选确认。', 'danger');
          d.close(); startCollection(app, { mode: 'manual', orderIds: [order.id], wrongToken: input.value.trim() });
        } else if (tokens.length) { d.close(); startCollection(app, { mode: 'manual', orderIds: [order.id], token: select.value }); }
      } }, '下一步')],
  });
}

// ---------- 异常恢复 ----------
function recoveryTab(app) {
  const s = app.state;
  if (!s.loaded.jobs) return h('section', { class: 'card' }, loadingRows(3));
  const pending = s.jobs.filter(j => needsRecovery(j) || j.state === 'PREPARED');
  const watching = s.jobs.filter(j => ['CANCELLED', 'ABANDONED'].includes(j.state) && j.watchUntilBlock).slice(0, 5);
  return h('div', { class: 'stack' },
    notice(null, '先找原交易，不要重发', '“结果未知”表示钱包可能已经发出交易，也可能没有。断网、超时、关闭页面或手机入口到期都不能说明交易没有发出。请先在钱包或区块浏览器中找到这笔交易的哈希并登记；只有确认钱包明确拒绝时，才登记拒签。'),
    pending.length ? pending.map(j => recoveryCard(app, j)) : h('section', { class: 'card' }, emptyState('没有需要恢复的交易', '所有归集交易都已有明确结果。')),
    watching.length ? h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('div', null, h('h2', null, '已结案、仍在观察'),
      h('div', { class: 'sub' }, '登记拒签或人工结案后，后台仍会继续观察一段区块；如果原交易后来上链，会自动识别。'))),
      h('ul', { class: 'tasks' }, watching.map(j => h('li', { class: 'task info' }, h('span', { class: 'icon' }),
        h('div', { class: 'grow' }, h('div', { class: 't' }, `${jobStatus(j).label} · ${j.orderIds.length} 笔订单`), h('div', { class: 'd' }, `创建于 ${dateTime(j.createdAt)}`)))))) : null);
}

function orderRefs(app, j) {
  if (j.recoveryOnly) return `错链找回 · 原订单 ${j.recovery?.orderId || '—'} · 来源 ${j.recovery?.sourceDeploymentId || '—'}（不计入付款）`;
  return j.orderIds.map(id => app.state.orders.find(o => o.id === id)?.reference || shortAddr(id, 8, 4)).join('、');
}

function recoveryCard(app, j) {
  const st = jobStatus(j), deploymentId = app.state.selectedId;
  const awaitingWallet = j.state === 'UNKNOWN' && j.error === 'WALLET_CONFIRMATION_PENDING' && !j.txHash && !j.candidateHash;
  const hasHash = !!(j.txHash || j.candidateHash);
  const act = (route, body) => app.client.post(route, body, { deploymentId });
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('div', null, h('div', { class: 'row wrap' }, h('h2', null, j.recoveryOnly ? '错链找回交易' : `归集交易 · ${j.orderIds.length} 笔订单`), badge(st.label, st.tone)),
      h('div', { class: 'sub' }, `${orderRefs(app, j)} · 发起于 ${dateTime(j.begunAt || j.createdAt)}（${relative(j.begunAt || j.createdAt)}）`))),
    h('div', { class: 'card-body stack' },
      hasHash ? h('div', { class: 'row wrap' }, h('span', { class: 'muted' }, '已登记交易'), copyable(j.txHash || j.candidateHash), h('span', { class: 'muted small' }, '可刷新核对；如果 RPC 一直无法提供回执，也可以自行核实后人工更改状态。'))
        : h('p', null, j.state === 'PREPARED' ? '这是尚未开始发送的准备记录，可取消后重新核对。' : awaitingWallet ? '交易已交给钱包，但后台还没有收到交易哈希。' : '后台无法确定这笔交易是否已发出。'),
      h('div', { class: 'muted small' }, `发送钱包 `, h('code', null, shortAddr(j.from, 8, 6)), ' · 请在这个钱包的交易记录中查找。'),
      h('div', { class: 'row wrap' },
        pendingRecoveryButton(app, deploymentId + ':' + j.id),
        j.state === 'PREPARED' && !readRecovery()[deploymentId + ':' + j.id] ? h('button', { class: 'btn small', onclick: e => busy(e.currentTarget, async () => {
          await act(`wallet/jobs/${j.id}/cancel`, {}); recoveryStore(deploymentId + ':' + j.id).remove(); await app.refresh();
        }) }, '取消未发送的准备记录') : null,
        actionButton(app, 'scan:' + deploymentId, { pendingLabel: '正在刷新…' }, '刷新状态', async () => { await app.client.post(j.recoveryOnly ? `wallet/jobs/${j.id}/refresh` : 'scan', {}, { deploymentId }); await app.refresh(); toast('已刷新链上状态。'); }),
        !hasHash ? h('button', { class: 'btn small primary', type: 'button', onclick: () => attachHashDialog(app, j, deploymentId) }, '登记原交易哈希') : null,
        awaitingWallet ? h('button', { class: 'btn small', type: 'button', onclick: async () => {
          const ok = await confirmDialog({ title: '登记钱包明确拒签', confirmText: '登记拒签',
            body: [h('p', null, '只有在钱包里明确点了“拒绝”，并且确认没有发出交易时才使用。'), h('p', { class: 'muted small' }, '登记后可以重新发起归集。后台仍会继续观察约 64 个区块；如果这笔交易其实已经发出并上链，会被自动识别。')],
            requireCheck: '我确认钱包显示的是“已拒绝”，不是超时或断网。' });
          if (ok && await confirmDialog({ title: '再次确认明确拒签', body: h('p', null, '这不是未知交易的清理操作。你确认钱包明确拒绝且没有返回哈希？'), confirmText: '确认登记拒签' })) busy(null, async () => { await act(`wallet/jobs/${j.id}/cancel`, { rejected: true }); toast('已登记拒签。'); app.refresh(); });
        } }, '登记明确拒签') : null,
        ['UNKNOWN', 'SUBMITTED'].includes(j.state) ? h('button', { class: 'btn small ghost', type: 'button', onclick: () => abandonDialog(app, j, deploymentId) }, '人工更改状态') : null)),
    h('div', { class: 'card-body' }, persistentDetails('job-tech:' + j.id, {}, '技术详情', h('dl', { class: 'kv' },
      h('dt', null, '任务 ID'), h('dd', null, copyable(j.id)), h('dt', null, '起始区块'), h('dd', null, String(j.dispatchBlock ?? '—')),
      h('dt', null, '状态码'), h('dd', null, h('code', null, `${j.state}${j.error ? ' / ' + j.error : ''}`))))));
}

function attachHashDialog(app, j, deploymentId) {
  const input = h('input', { class: 'input mono', placeholder: '0x 开头，共 66 位', autocomplete: 'off', spellcheck: 'false' });
  const err = h('div', { class: 'error-text', role: 'alert' });
  const d = openDialog({ title: '登记原交易哈希', sub: '只登记已经发出的那笔交易，不会发送新交易。',
    body: [field('交易哈希', input, { hint: '在发送钱包的交易记录或区块浏览器中复制。后台会核对发送者、合约、调用数据和网络，不匹配会被拒绝。' }), err],
    foot: [h('button', { class: 'btn', type: 'button', onclick: () => d.close() }, '取消'),
      h('button', { class: 'btn primary', type: 'button', onclick: e => {
        const hash = input.value.trim();
        if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) { err.textContent = errorText('INVALID_TRANSACTION_HASH'); return; }
        busy(e.currentTarget, async () => { await app.client.post(`wallet/jobs/${j.id}/attach`, { transactionHash: hash }, { deploymentId }); d.close(); toast('已登记，正在等待链上回执。'); app.refresh(); },
          { onError: error => { err.textContent = errorMessage(error); } });
      } }, '登记并核对')] });
}

function abandonDialog(app, j, deploymentId) {
  const result = h('select', { class: 'input' },
    h('option', { value: '' }, '请选择核实结果'), h('option', { value: 'SUCCESS' }, '人工确认成功'),
    h('option', { value: 'FAILED' }, '人工确认失败 / 未执行'), h('option', { value: 'UNRESOLVED' }, '仅人工结案，结果仍未核实'));
  const note = h('textarea', { placeholder: '填写核实依据，例如浏览器结果、到账记录或钱包记录。', maxlength: 500 });
  const ack = h('input', { type: 'checkbox' });
  const err = h('div', { class: 'error-text', role: 'alert' });
  const d = openDialog({ title: '人工更改归集状态', sub: '只更新这笔归集任务的人工结果，不发送交易，不修改订单付款状态。',
    body: [notice('warn', '人工结果会解除本任务的订单锁', '请先核对钱包、区块浏览器或收款余额。人工确认不等于后台已验证链上回执；若原交易仍在执行，重新归集可能重复消耗 gas。原哈希和历史记录都会保留，自动刷新不会覆盖人工结果。'),
      j.txHash || j.candidateHash ? copyable(j.txHash || j.candidateHash) : null,
      field('核实结果', result), field('核实说明（至少 4 个字）', note),
      h('label', { class: 'check' }, ack, '我已自行核实，并理解人工更改结果及解除锁定的风险。'), err],
    foot: [h('button', { class: 'btn', type: 'button', onclick: () => d.close() }, '取消'),
      h('button', { class: 'btn danger', type: 'button', onclick: e => busy(e.currentTarget, async () => {
        if (!result.value) { err.textContent = '请选择核实结果。'; return; }
        const resolved = await app.client.post(`wallet/jobs/${j.id}/resolve`, { acknowledge: ack.checked, note: note.value, result: result.value, expectedState: j.state }, { deploymentId });
        recoveryStore(deploymentId + ':' + j.id).remove();
        d.close(); toast(resolved.manualResolution ? '已保存人工结果并解除本任务锁定。' : '后台已核实链上结果。'); app.refresh();
      }, { onError: error => { err.textContent = errorMessage(error); } }) }, '确认更改')] });
}

// ---------- 归集记录 ----------
function recordsTab(app) {
  const s = app.state;
  if (!s.loaded.jobs) return h('section', { class: 'card' }, loadingRows(4));
  if (!s.jobs.length) return h('section', { class: 'card' }, emptyState('还没有归集记录'));
  const tokens = s.status?.config?.tokens || app.selected()?.tokens || [];
  return h('section', { class: 'card' }, h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
    h('thead', null, h('tr', null, h('th', null, '时间'), h('th', null, '结果'), h('th', null, '订单'), h('th', null, '交易'))),
    h('tbody', null, s.jobs.flatMap(j => {
      const st = jobStatus(j);
      const rows = [h('tr', null, h('td', { class: 'nowrap' }, dateTime(j.createdAt)), h('td', null, badge(st.label, st.tone)),
        h('td', null, orderRefs(app, j)), h('td', null, j.txHash ? copyable(j.txHash) : h('span', { class: 'subtle' }, '—')))];
      if (j.manualResolution) rows.push(h('tr', null, h('td', { colspan: 4 },
        h('div', { class: 'muted small' }, `人工备注：${j.manualResolution.note} · ${dateTime(j.manualResolution.at)}`),
        h('button', { class: 'btn small ghost', type: 'button', onclick: () => abandonDialog(app, j, s.selectedId) }, '更改人工结果'))));
      if (j.state === 'MINED' && j.events?.length) rows.push(h('tr', null, h('td', { colspan: 4 }, persistentDetails('job-events:' + j.id, {}, '逐笔结果',
        h('ul', { class: 'timeline' }, j.events.map(e => {
          const o = s.orders.find(x => x.orderHash === e.orderHash), t = tokens.find(x => x.address.toLowerCase() === String(e.token).toLowerCase());
          return h('li', { class: e.name === 'Collected' ? 'ok' : '' }, h('div', null, h('strong', { translate: 'no' }, o?.reference || shortAddr(e.forwarder)), ' · ',
            e.name === 'Collected' ? `已归集 ${t ? amount(fromUnits(BigInt(e.amount), t.decimals)) + ' ' + t.symbol : e.amount}` : e.name === 'CollectFailed' ? `失败（${e.reasonSelector || '无原因码'}），资金仍在订单地址` : e.name));
        }))))));
      return rows;
    })))),
    h('div', { class: 'card-body muted small' }, '批量交易上链成功不代表每一笔都成功；请以逐笔结果为准。'));
}
