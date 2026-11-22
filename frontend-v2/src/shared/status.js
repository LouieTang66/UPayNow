// Business status vocabulary. Payment state (from the order ledger) and
// collection state (from collection jobs + receipt events) are separate axes.

export const PAYMENT = {
  WAITING: { label: '待付款', tone: 'neutral', hint: '尚未检测到选定币种的付款。' },
  PARTIAL: { label: '部分付款', tone: 'warn', hint: '有效期内已到账但不足应付金额。' },
  CONFIRMING: { label: '确认中', tone: 'info', hint: '到账金额已足够，等待达到配置的确认数。' },
  PAID: { label: '已付足', tone: 'ok', hint: '有效期内已确认金额等于应付金额。' },
  OVERPAID: { label: '已付足 · 超额', tone: 'ok', hint: '已确认金额超过应付金额，归集时会一并转入固定收款地址。' },
  EXPIRED: { label: '已过期', tone: 'neutral', hint: '有效期内未付足。' },
  LATE_PAYMENT: { label: '过期后到账', tone: 'warn', hint: '有到账发生在有效期之后，不计入订单付款，请人工核实。' },
};
export const PAID_STATES = ['PAID', 'OVERPAID'];
export const ATTENTION_STATES = ['PARTIAL', 'LATE_PAYMENT'];

export function payment(status) { return PAYMENT[status] || { label: status || '未知', tone: 'neutral', hint: '' }; }

// Collection job states (wallet-collection.cjs / merchant.cjs).
const JOB = {
  PREPARED: { label: '待钱包确认', tone: 'info', active: true },
  SUBMITTING: { label: '发送中', tone: 'unknown', active: true },
  UNKNOWN: { label: '结果未知', tone: 'unknown', active: true },
  SUBMITTED: { label: '已提交 · 等待回执', tone: 'info', active: true },
  MINED: { label: '已上链', tone: 'ok' },
  CANCELLED: { label: '已取消', tone: 'neutral' },
  ABANDONED: { label: '已人工结案', tone: 'neutral' },
  REPLACED: { label: '已被替换', tone: 'warn' },
  EXPIRED: { label: '准备已过期', tone: 'neutral' },
};

export function job(j) {
  if (!j) return { label: '—', tone: 'neutral' };
  if (j.manualResolution) return j.manualResolution.result === 'SUCCESS' ? { label: '人工确认成功', tone: 'ok' }
    : j.manualResolution.result === 'FAILED' ? { label: '人工确认失败', tone: 'danger' } : { label: '人工结案 · 未核实', tone: 'neutral' };
  if (j.state === 'MINED') {
    if (j.outcome === 'SUCCESS') return { label: '已上链 · 全部成功', tone: 'ok' };
    if (j.outcome === 'PARTIAL_SUCCESS') return { label: '已上链 · 部分无余额', tone: 'info' };
    if (j.outcome === 'NO_BALANCE') return { label: '已上链 · 无余额转出', tone: 'neutral' };
    if (j.outcome === 'PARTIAL_FAILURE') return { label: '已上链 · 部分失败', tone: 'warn' };
    if (j.outcome === 'REVERTED') return { label: '交易回滚', tone: 'danger' };
  }
  if (j.state === 'CANCELLED' && j.error === 'USER_REJECTED') return { label: '已登记拒签', tone: 'neutral', watching: true };
  return JOB[j.state] || { label: j.state || '未知', tone: 'neutral' };
}

export function isActiveJob(j) { return !!JOB[j?.state]?.active; }
export function needsRecovery(j) { return j && (j.state === 'UNKNOWN' || j.state === 'SUBMITTING' || (j.state === 'SUBMITTED' && !j.blockNumber)); }

// Per-order collection result inside a (possibly batched) job. An outer
// success never implies every pair succeeded: read the per-pair events.
export function orderCollection(order) {
  const jobs = order.collectionJobs || [];
  const latest = jobs[0];
  if (!latest) return PAID_STATES.includes(order.status) || order.status === 'LATE_PAYMENT'
    ? { label: '未归集', tone: 'neutral', job: null } : { label: '—', tone: 'neutral', job: null, none: true };
  if (latest.state === 'MINED' && latest.outcome !== 'REVERTED') {
    const events = (latest.events || []).filter(e => !e.orderHash || e.orderHash === order.orderHash);
    if (events.some(e => e.name === 'CollectFailed')) return { label: '归集失败', tone: 'danger', job: latest };
    if (events.some(e => e.name === 'Collected' || e.name === 'WrongTokenCollected')) return { label: '已归集', tone: 'ok', job: latest };
    return { label: '已执行 · 无余额', tone: 'neutral', job: latest };
  }
  const s = job(latest);
  return { label: s.label, tone: s.tone, job: latest };
}

export const NOTIFY = {
  PENDING: { label: '待发送', tone: 'info' },
  DELIVERED: { label: '已送达', tone: 'ok' },
  FAILED: { label: '发送失败', tone: 'danger' },
  CANCELLED: { label: '已作废', tone: 'neutral' },
};

export const DEPLOY_JOB = {
  READY: { label: '已验证 · 未发送', tone: 'info' },
  UNKNOWN: { label: '结果未知', tone: 'unknown' },
  MINED: { label: '已上链', tone: 'ok' },
  CANCELLED: { label: '已登记拒签', tone: 'neutral' },
};
export function deployJob(j) {
  if (j?.state === 'MINED') {
    if (j.outcome !== 'SUCCESS') return { label: '部署失败', tone: 'danger' };
    const bootstrap = (j.scheme || j.summary?.scheme) === 'deterministic-v2' && (j.stage || j.summary?.stage) === 'bootstrap';
    return { label: bootstrap ? '入口就绪 · 待部署商户' : '部署成功 · 已加入', tone: 'ok' };
  }
  if (j?.state === 'UNKNOWN' && j.candidateHash) return { label: '已登记哈希 · 核验中', tone: 'info' };
  return DEPLOY_JOB[j?.state] || { label: j?.state || '未知', tone: 'neutral' };
}

// Backend error codes -> plain Chinese. Unknown codes are shown as a generic
// sentence with the code kept for support, never as raw stack traces.
const ERRORS = {
  DEPLOYMENT_NETWORK_NOT_OPEN: '该网络尚未开放新建商户部署，请选择已开放网络；旧部署导入和已有任务恢复不受影响。',
  CANONICAL_SINGLETON_UNAVAILABLE: '该网络尚未开放：官方 ERC-2470 入口不可用，请联系运营方。',
  PUBLIC_BOOTSTRAP_OPS_ONLY: '公共入口仅允许运营方通过独立工具部署，客户端不能新建此任务。',
  DETERMINISTIC_DEPLOYER_NOT_READY: '该网络尚未开放：公共入口未就绪，请联系运营方。',
  UNAUTHORIZED: '密码或恢复密钥不正确，或登录已失效，请核对后重试。',
  AUTH_REQUIRED: '登录已失效，请重新输入密码。',
  SESSION_REQUIRED: '此操作需要密码登录会话，请重新登录。',
  INVALID_PASSWORD: '密码不正确，请重新输入。',
  PASSWORD_INVALID: '密码须为 12–128 个字符，且不能全为空白；首尾空格会保留。',
  PASSWORD_NOT_SET: '尚未设置登录密码，请使用现有恢复密钥首次设密。',
  AUTH_BUSY: '正在处理另一项身份操作，请稍后重试。',
  LOGIN_RATE_LIMIT: '尝试次数过多，请 5 分钟后再试。',
  ORIGIN_REQUIRED: '请求来源不正确，请从后台页面直接操作。',
  BUSY_RETRY_LATER: '后台正在处理另一项操作，请稍后重试。',
  SCAN_NOT_READY: '链上记录还在追赶，同步完成后才能归集。',
  SCAN_REORG_RETRY: '链上区块发生变化，请稍后重试。',
  TRANSACTION_RECONCILIATION_REQUIRED: '本次选中的订单仍有未处理交易，请先恢复这些订单；其他订单可以正常归集。',
  INVALID_MANUAL_RESOLUTION: '请选择人工核实的结果。',
  WALLET_JOB_STATE_CHANGED: '任务状态已变化，请刷新后重新核对。',
  CONNECTED_WALLET_NEEDS_GAS: '钱包没有足够的原生币支付 gas。',
  DEPLOYMENT_RETRY_UNAVAILABLE: '当前部署任务不能重新唤起钱包，请刷新并核对原交易。',
  DEPLOYMENT_PHONE_REQUIRED: '重新唤签仅支持原手机部署入口。',
  DEPLOYMENT_RETRY_SCOPE_CHANGED: '部署参数发生变化，已停止重新唤签。',
  LEGACY_DEPLOYMENT_DISABLED: '旧版新建部署已停用，请使用跨链同址新版；已有旧合约可从高级入口导入和管理。',
  INVALID_DEPLOYMENT_NAME: '名称不能为空，且不能超过 128 个字符；只能修改显示名称。',
  DEPLOYMENT_NOT_FOUND: '找不到该部署，请刷新部署列表。',
  DEPLOYMENT_UNAVAILABLE: '该部署当前无法加载，请检查服务端日志。',
  DEPLOYMENT_SCOPE_MISMATCH: '请求中的部署与当前选择不一致，已拒绝。',
  USE_ADD_DEPLOYMENT: '已有部署不能修改配置；请通过“添加链”创建新部署。',
  PAYOUT_WALLET_REQUIRED: '新模式必须用固定收款钱包确认商户部署或恢复，请切换到该钱包。',
  CANONICAL_SINGLETON_MISSING: '这条链没有经过核验的标准部署入口，暂不能使用跨链同地址模式；可以选择旧模式。',
  CANONICAL_SINGLETON_RUNTIME_MISMATCH: '标准部署入口的代码与固定版本不符，已阻止操作。',
  DETERMINISTIC_FACTORY_ALREADY_EXISTS: '这个商户地址已完成部署，无需再次发送。请取消当前未发送任务，再用原参数核对并导入已有部署。',
  DEPLOYER_RUNTIME_MISMATCH: '公共部署入口的代码不符，已阻止操作。',
  DETERMINISTIC_RELEASE_MISMATCH: '本地合约与固定版本清单不一致，已停止生成地址；请核对版本，不要盲目重新部署。',
  BOOTSTRAP_SIMULATION_FAILED: '公共入口部署预演未成功，尚未请求钱包发送交易，请核对链和入口状态。',
  TOKEN_REGISTRY_CHANGED: '该地址的固定币种名单与填写的不一致，不能覆盖；请核对原配置或选择旧模式另建部署。',
  DETERMINISTIC_DEPLOYMENTS_REQUIRED: '源链与目标链都必须是已核验的新同地址模式；旧地址不能自动升级恢复。',
  RECOVERY_REQUIRES_DIFFERENT_CHAIN: '请选择另一条实际到账链，同链错币请使用现有错币归集。',
  RECOVERY_DEPLOYMENT_MISMATCH: '两条链的收款钱包、Factory 或版本不一致，已阻止恢复。',
  RECOVERY_ADDRESS_MISMATCH: '原订单在目标链的预测地址不一致，已阻止操作；请勿重建订单代替。',
  RECOVERY_ORDER_SCOPE_MISMATCH: '原订单不属于所选源链部署，已阻止操作。',
  RECOVERY_BALANCE_EMPTY: '指定资产在目标链的原订单地址暂无可归集余额，请核对网络和 CA。',
  CONFIRMATIONS_REORGED: '区块重组后确认数不足，已退回等待确认，不要重复发送。',
  RPC_HTTPS_REQUIRED: 'RPC 必须是 HTTPS 地址。',
  RPC_CREDENTIALS_NOT_ALLOWED: 'RPC 地址中不能包含用户名或密码。',
  CHAIN_ID_MISMATCH: 'RPC 返回的 Chain ID 与填写的不一致。',
  TOKEN_NOT_CONTRACT: '有代币地址在该链上不是合约，请核对 CA。',
  DUPLICATE_TOKEN: '代币地址有重复。',
  INVALID_PAYOUT: '收款地址无效，或与代币地址相同。',
  INVALID_ADDRESS: '地址格式不正确。',
  INVALID_TRANSACTION_HASH: '交易哈希格式不正确（0x 加 64 位十六进制）。',
  TRANSACTION_DOES_NOT_MATCH_JOB: '该哈希与这笔任务不匹配（发送者、合约、调用数据或网络不同）。',
  TRANSACTION_HASH_ALREADY_ATTACHED: '这条记录已登记过另一个哈希。',
  TRANSACTION_HASH_IN_USE: '该哈希已被另一条记录使用。',
  DEPLOYMENT_TRANSACTION_MISMATCH: '该哈希不是这条部署记录发出的创建交易。',
  DEPLOYMENT_NOT_CANCELLABLE: '这条部署记录已有交易哈希，不能登记为拒签。',
  UNCERTAIN_TRANSACTION_CANNOT_CANCEL: '结果未知的交易不能直接取消，请先登记原哈希或按流程结案。',
  EXPLICIT_RISK_ACKNOWLEDGEMENT_REQUIRED: '需要勾选风险确认并填写至少 4 个字的说明。',
  KNOWN_TRANSACTION_REQUIRES_RECONCILIATION: '这笔任务已有交易哈希，只能通过链上核对结案。',
  NOTIFICATION_NOT_RETRYABLE: '只有待发送或失败的通知可以重新排队。',
  HANDOFF_NOT_ENABLED: '手机入口未启用。',
  TUNNEL_BUSY: '已有一个手机入口正在开放，请先处理或关闭。',
  CLOUDFLARED_NOT_FOUND: '指定的 cloudflared 无法运行，请检查路径和执行权限。',
  CLOUDFLARED_DOWNLOAD_FAILED: '手机入口组件下载失败，请检查运行设备的网络后重试。',
  CLOUDFLARED_INTEGRITY_FAILED: '手机入口组件校验失败，未执行下载文件，请重试。',
  CLOUDFLARED_CACHE_FAILED: '无法保存手机入口组件，请检查数据目录的写入权限和磁盘空间。',
  CLOUDFLARED_UNSUPPORTED_PLATFORM: '当前系统或处理器暂不支持自动下载 cloudflared，请手动指定兼容组件。',
  CHAIN_NOT_CONFIGURED: '请先在“链与合约”中配置收款部署，再执行链上操作。',
  TUNNEL_START_TIMEOUT: '临时手机入口启动超时，没有自动重试。',
  TUNNEL_START_FAILED: '临时手机入口启动失败。',
  NO_COLLECTABLE_ORDERS: '所选订单当前没有可归集余额。',
  REFERENCE_CONFLICT: '这个商户订单号已用于不同的金额、币种或通知设置。',
  UNSUPPORTED_TOKEN: '该代币不在当前部署的支持列表中。',
  AMOUNT_MUST_BE_DECIMAL_STRING: '金额需为十进制数字，例如 10.50。',
  INVALID_AMOUNT_PRECISION: '金额小数位超过该代币支持的精度。',
  WEBHOOK_HOST_NOT_ALLOWED: '通知地址的域名不在服务器允许列表中。',
  UPSTREAM_OR_STORAGE_ERROR: '后台或链上节点暂时不可用。',
  NETWORK_ERROR: '无法连接后台，请检查网络。',
  EPAY_OPERATIONS_UNAVAILABLE: '当前部署未启用 EPay 对账。',
  INVALID_EPAY_OPERATIONS_REQUEST: 'EPay 对账请求无效。',
  EPAY_REVIEW_STALE: '此订单的异常状态已经变化，请刷新后重新核对。',
  REQUEST_TIMEOUT: '后台响应超时。若已开始钱包操作，请先核对原任务，不要重复发送。',
  INVALID_API_RESPONSE: '后台返回了无法识别的数据，请检查服务状态。',
};
export function errorText(code) { return ERRORS[code] || `操作未完成（${code || '未知原因'}）。`; }
