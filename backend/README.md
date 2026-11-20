# UPayNow 商城 API 与付款通知

先按 [安装说明](../docs/INSTALLATION.md) 从空白实例启动，部署或导入自己的 Factory。运行入口为项目根目录 `npm ci && npm start`。空白实例没有已接入部署、币种或订单；可选网络预设由产品内置；此文不是本地充值或测试网操作教程。日常操作、备份与异常恢复见 [完整操作手册](../docs/OPERATIONS.md)。

## 认证和部署范围

商城**服务器**使用独立 API 凭据作为 `Authorization: Bearer <API凭据>`，可在后台“设置”用当前密码重新验证后取得。登录密码和恢复密钥都不能作为 Bearer。API 凭据仍有广泛业务管理权限，并非最小权限开单 key，但不能访问密码/凭据管理接口，不得交给顾客网页。管理台用密码建立 HttpOnly、SameSite=Strict Cookie；浏览器写操作还需同源 Origin。改密码或使用恢复密钥重置不改变独立 API 凭据。见[认证说明](../docs/AUTHENTICATION.md)。

`GET /api/deployments` 返回 `{deployments, defaultId}`。每套已配置部署的 `id` 不是 chainId；同一链可有多套 Factory。所有部署范围请求应显式带 `X-Upay-Deployment: <id>`。服务也支持 `?deploymentId=<id>`，但不要混用多种来源。未指定时默认 `legacy`（根数据实例标识，不代表已有配置或旧版界面）。创建订单 body 可包含 `deploymentId`，应始终与请求头一致。订单号幂等作用域为所选部署。

商城保存部署 ID、商户订单号、服务订单 UUID、币种和返回的 `checkoutPath`，不要依赖管理台当前选择来查单。

## API 开单

```sh
# 下列变量由商城服务器安全注入；BASE_URL 是自己的管理/API HTTPS origin。
# DEPLOYMENT_ID 和 TOKEN_CA 从核验通过的部署信息取得。
curl --fail-with-body "$BASE_URL/api/orders" \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "X-Upay-Deployment: $DEPLOYMENT_ID" \
  -H 'Content-Type: application/json' \
  --data "{\"reference\":\"$SHOP_ORDER_REFERENCE\",\"token\":\"$TOKEN_CA\",\"amount\":\"10.50\",\"expiresInSeconds\":1800,\"webhookUrl\":\"$WEBHOOK_URL\"}"
```

`amount` 必须是正数十进制字符串；不接受浮点 JSON、科学计数或超过 token decimals 的精度。`expiresInSeconds` 默认为 1800，范围 1–604800 秒。`reference` 是非空、最长 128 字符的商户订单号；同一部署下相同 reference 仅当币种、原始金额、有效期时长、通知设置一致时幂等返回，冲突不能覆盖旧账。网络超时后以同一 reference 和完全相同参数重试，不生成新业务订单号来规避未知结果。

`webhookUrl` 可留空以禁用该订单通知；启用时必须为自己的 HTTPS URL，域名在 `UPAY_WEBHOOK_HOSTS` 的准确白名单内。该变量是逗号分隔域名，不带协议、路径或空格；默认空白不允许外部通知。通知目标不得解析到私有地址，不跟随 HTTP 跳转。

返回真实订单详情，含 `id`、`deploymentId`、`address`、`chainId`、`factory`、`token`、`expectedUnits` 和 `checkoutPath`。将 `checkoutPath` 拼接到自己服务的公开 origin 后交给顾客；`/pay/:token` 是正式顾客收银台，不向其发送后台凭据。正式订单由商城 API 创建；管理台“设置 → 辅助工具 → 手动创建一笔订单”仅用于测试或补单。此处不提供伪造的成功响应。

## 查单与履约幂等

- `GET /api/orders/:id`：商城后台查单；`GET /api/orders` 为管理列表。
- `GET /api/status`：当前部署的扫描位置、同步错误与配置状态。
- `GET /api/pay/:opaqueToken`、`GET /api/pay/:opaqueToken/qr`：公开订单付款信息及二维码，无管理权限；完整付款链接应按订单信息保管。
- `GET /health`：进程存活及是否配置，不是支付核验健康证明。

以准确链和 token 的 ERC-20 Transfer 记录、确认数与规范链扫描认定付款；不同 CA 不相加。`paid`、`syncHealthy`、业务状态、通知和归集状态必须区分。当前余额为零不代表未付，归集成功也不代表已付足；任何人可向固定 payout 触发合法归集。

**商城负责库存、预留、扣减、发货和退款策略**。履约流程至少应：

1. 验证回调签名和时间窗；按事件 ID 持久去重，按订单 `stateVersion` 防止旧事件覆盖新状态。
2. 核对订单号、部署、链、Factory、token、原始数量及自己的应付记录；必要时服务器查单，确认 `paid === true` 和 `syncHealthy === true`。
3. 用业务数据库事务/唯一约束或 outbox，将订单履约和库存动作做成订单级幂等。重试同一支付事件、重新认定一轮支付或重复查单都不能重复发货。
4. 处理 `payment.reversed`：停止尚未执行的履约并按业务策略对账；通知不会自动回滚已发出的商品。

服务无 exactly-once 网络交付承诺，固定确认数也不等于协议 finalized。不能把顾客页面的“已付款”声明当付款证据。

## 签名通知

达到付款认定时生成 `payment.paid`；已认定付款被重组撤回时生成 `payment.reversed`。正文包括 `id`、`type`、`orderId`、`reference`、`paymentGeneration`、`stateVersion`、`chainId`、`factory`、`orderAddress`、`token`、`expectedUnits`、`confirmedUnits`、`status` 和 `latePaymentAccepted`。整数数量字段为字符串，不得当作浮点或跨币美元金额；当前通知正文不含 `decimals`，请从已核验的部署币种信息或订单详情取得。

| HTTP 头 | 含义 |
|---|---|
| `X-Upaynow-Event` | 稳定事件 ID，不是事件类型 |
| `X-Upaynow-Timestamp` | 本次尝试的 Unix 秒时间戳 |
| `X-Upaynow-Signature` | 小写 hex HMAC-SHA256 |

签名输入严格为 `timestamp + "." + 原始请求正文`，密钥为**订单所属部署**状态目录内 `webhook.secret` 去除末尾换行的内容。多部署有各自 secret，不能一律使用根 secret。接收端应在 JSON 重序列化之前保留原始字节，校验时间窗和格式，以恒定时间方式比较签名，验证成功后再执行业务。按事件 ID 与正文类型建立对应关系，不只信任头字段。

接收端只有在事件已可靠接收后返回 2xx，服务才标记 DELIVERED。自动尝试最多 8 次；失败可在通知列表重新排队，事件 ID 不变。重试可有新的 timestamp/签名；正文和事件身份不因此变成新履约。服务可能取消已失效的队列事件，不能依赖回调绝不丢失来代替定期对账。

## 商户明确接受超时付款

接口：`POST /api/orders/:id/accept-late-payment`，请求体只能为 `{}`。使用管理会话或独立 API 凭据及准确 `X-Upay-Deployment`，没有公开顾客入口，当前管理 UI 也没有接受迟付按钮；不收金额、币种、paid 或库存判断字段。

```sh
curl --fail-with-body -X POST "$BASE_URL/api/orders/$ORDER_ID/accept-late-payment" \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "X-Upay-Deployment: $DEPLOYMENT_ID" \
  -H 'Content-Type: application/json' \
  --data '{}'
```

当顾客要求继续处理已超时订单时，**商城后台**先查单并检查、预留库存；有库存才明确接受，无库存转人工处理。UPayNow 没有库存系统，不会自行锁库存、发货或退款。

服务先有界同步并核验同步健康、合约身份和规范链锚点。首次接受仅限已过期订单，须有原订单 CA 的已确认超时到账且累计足额；有效期内部分付款与确认后的超时补款可合计，其他币不能补足。正常已付足订单返回原状态，不重新认单。

成功 HTTP 200 返回完整订单详情和 `deploymentId`。商城仍须检查 `paid === true`、`syncHealthy === true` 并幂等履约：

- 状态为 `PAID` 或 `OVERPAID`；`latePaymentAccepted: true` 表示明确接受。
- `latePaymentAcceptance` 保存 `acceptedAt`、核验区块/哈希、获接受的 `depositIds` 和 `confirmedUnits`；原币种、金额、地址和 `expiresAt` 不改。
- `receivedAmount` / `confirmedAmount` 包含获接受到账；`lateAmount` 是尚未接受金额，`lateReceivedAmount` 保留全部超时到账历史。
- 接受记录和付款 outbox 同事务持久化；重复或并发调用保留原记录，不为同一轮支付生成重复事件。网络通知仍可重试，商城必须去重。

接受仅绑定本次已确认事件快照，不永久批准未来到账。重组撤销这些到账时仍会生成 `payment.reversed` 并撤回 paid；此时重复接受可返回 `PAYMENT_NO_LONGER_CONFIRMED`，不会自动接受替代转账。

主要拒绝码：401 `UNAUTHORIZED`；404 `ORDER_NOT_FOUND` / `DEPLOYMENT_NOT_FOUND`；400 `ACCEPT_LATE_PAYMENT_BODY_MUST_BE_EMPTY`；409 `ORDER_NOT_EXPIRED`、`NO_CONFIRMED_LATE_PAYMENT`、`PAYMENT_NOT_FULLY_CONFIRMED`、`SCAN_NOT_READY`、`SCAN_REORG_RETRY`、`PAYMENT_NO_LONGER_CONFIRMED`。RPC/存储故障不是接受成功。

超时或断线**不能直接认定失败并释放库存**：重试此幂等接口或查单核对接受记录、paid 和同步健康后再处理。接口不发链上交易、不花 gas、不替代商城库存事务。

## 管理与归集接口索引

| 接口 | 用途 |
|---|---|
| `POST /api/login` / `/api/logout` | 管理会话；登录要求同源 Origin |
| `POST /api/scan` | 有界同步；后台亦周期扫描 |
| `POST /api/collect-all/preview` | 预览已付足订单归集 |
| `POST /api/collect-all` | 受理已付足订单归集任务 |
| `POST /api/collect` | 人工指定正常/错币归集 |
| `GET /api/jobs` | 归集任务与回执 |
| `POST /api/jobs/:id/reconcile` | `{ "transactionHash": "<原交易哈希>" }` 核对，不重广播 |
| `GET /api/notifications` | 通知状态 |
| `POST /api/notifications/:id/retry` | 对可重试通知重新排队，body `{}` |
| `GET/POST /api/wallet/config` | 钱包连接配置 |
| `POST /api/wallet/prepare` | 准备钱包归集任务 |
| `POST /api/wallet/jobs/:id/begin`、`attach`、`cancel`、`resolve` | 发送前登记及原交易恢复流程 |

正常人工归集 body 为 `{ "orderIds": ["<订单UUID>"] }`，默认使用每张订单认单 CA；可显式传 `token` 归集另一受支持 CA，但不会改订单付款币种。错币归集使用 `wrongToken` 和 `confirmWrongToken:true`，不能同时传正常 `token`；原生币用零地址。所有资金只到固定 payout。普通归集可由其他钱包付 Gas；专用错链找回流程要求目标链 payout 钱包签名。当前按链/部署操作，没有钱包分组或跨链归集队列。外部钱包模式由前端钱包流程继续确认，不代表请求返回 202 就已广播或成功。批量外层成功不保证逐项成功。

未知交易先登记原哈希核验，不能盲目重发。钱包任务人工 `resolve` 会保存未链上验证的人工结果、解除任务锁定并停止该任务自动观察；不是链上成功证明，也不撤销已发交易。

新 Factory 使用 [多链部署 API](MULTICHAIN.md)；`POST /api/config` 仅限未配置的根实例初始化，不能用来覆盖已存在部署。手机能力及 UNKNOWN 恢复见 [手机入口说明](HANDOFF.md)。

## 开发者自动化检查

后台回归入口 `npm run test:backend`；前端 `npm run test:frontend-v2`；合约 `npm test`。这些不属于商户使用步骤，测试必须与商户状态隔离，结果不等于实体钱包或主网验收。安全限制见 [SECURITY.md](../docs/SECURITY.md)。
