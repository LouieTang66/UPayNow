# New API EPay（可选）

UPayNow 提供一个 **New API `v1.0.0-rc.51` 的 EPay MD5 网页充值适配器**。`/epay/submit.php` 只接收该模式的签名订单，确认链上到账后通知 New API 发放余额。不会部署合约、替商户签名、改变既有 API、或改变一单一地址的归集流程。不是通用易支付网关：不支持 RSA、`mapi.php`、退款/代付，以及对任意 EPay 客户端的查询接口。

目标协议来源：[New API 下单及通知](https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.51/controller/topup.go#L271-L476) 和 [go-epay v0.0.6](https://github.com/Calcium-Ion/go-epay/tree/v0.0.6)。本库测试包含本地 EVM 模拟代币转账、链上扫描和合成的 New API 协议对端，不代表已部署完整 New API 或实测主网。可在构建后运行 `node --test backend/test/epay.test.cjs` 重现。

## 配置

1. 先按既有步骤配置并验证 UPayNow 的部署、收款钱包、代币合约、链 ID 和确认数；默认使用 `legacy`。如使用多链后台的独立部署，从 `GET /api/deployments` 找到该部署的 ID。确保反代 HTTPS 正常、保留 Host，且 `UPAY_PUBLIC_ORIGIN` 已设置。只公开所需的付款路径；不要把管理 API 作为充值入口公开。
2. 在 New API 中确认你有权启用该付款方式，按 New API 界面完成支付合规确认。选择 **MD5**，网关地址填写 `https://你的-upaynow-域名/epay`（不加 `submit.php`），填与 UPayNow 相同的 PID 和独立随机密钥。在自定义付款方式中写入类型 `usdt` 及显示名称，例如「USDT 链上付款」。不要填写支付宝通道名称来暗示真实支付宝支付。
3. 将下列环境变量注入 UPayNow 服务进程并重启。环境示例不是自动加载的 dotenv 文件。**不要提交或记录真实密钥**，不与其他支付网关共用。MD5 是目标协议的兼容要求，不建议用于新协议。

   | 变量 | 含义 |
   | --- | --- |
   | `UPAY_EPAY_ENABLED=1` | 显式启用；未设置或 `0` 时不开放入口 |
   | `UPAY_EPAY_DEPLOYMENT_ID` | 绑定单个 UPayNow 部署，默认 `legacy` |
   | `UPAY_EPAY_PID` / `UPAY_EPAY_KEY` | 商户编号和至少 32 字符的高熵密钥（可用 `openssl rand -hex 32` 生成） |
   | `UPAY_EPAY_TYPE` | 仅支持 `usdt`，也是默认值 |
   | `UPAY_EPAY_TOKEN` | 所选部署中经核实的 USDT 合约地址，不按代币符号判断真伪 |
   | `UPAY_EPAY_PRICE_CURRENCY=USDT` | 必填。管理员确认商城发出的实际 `money` 已按 USDT 计价；不接受法币或汇率配置。 |
   | `UPAY_EPAY_NOTIFY_URL` | New API 实际通知地址，通常 `https://new-api.example.com/api/user/epay/notify`，不允许查询串 |
   | `UPAY_EPAY_RETURN_URL` | New API 实际返回地址，通常 `https://new-api.example.com/usage-logs` |

   两个 URL 都必须是完整 HTTPS URL，且与 New API 签名值完全一致。New API 从 `ServerAddress` 去掉末尾斜杠后拼接 `/usage-logs` 作为返回地址；通知用 `CustomCallbackAddress`（未设则用 `ServerAddress`）拼接 `/api/user/epay/notify`，两者域名可以不同。通知仅发往此固定 URL，要求 DNS 都解析到公共 IP，固定连接到已查验 IP，不跟随重定向。HTTPS 反代应避免在访问日志中保留付款表单和签名参数；限制 New API 自身的支付日志访问。部署标识、链/Factory、PID、代币、方式和三个地址首次启用时绑定状态库，不可就地更换来改写或绕过历史订单。密钥轮换先暂停新单、处理在途订单并在两边同步。
4. 先把 New API 该充值方式的实际结算价格配置为按 USDT 计价。只改界面货币符号不够；固定协议没有币种字段，UPayNow 无法从数值判断上游计价币。用一笔隔离环境的无价值代币订单核对：例如商城标价 10.00 USDT，签名请求的 `money` 必须是 `10.00`，UPayNow 也必须显示应付 10 USDT。不要对人民币或美元计价的订单启用本入口。再核对收款地址、达到确认数、New API 实际到账额度、重复通知后额度不变。没有核对 New API 实际账本前，不要用于真实充值。

## 运行与异常

- 独立隔离的 PID + `out_trade_no` 绑定首次签名请求的金额和报价。应付金额直接使用两位小数的 USDT 金额，不查、不换算汇率；金额与订单号持久化。重复提交返回原始地址；过期订单不会被同一个编号重新激活。订单默认 30 分钟，下单成功只跳转站内付款页。Native 扫描确认付款后才发通知，付款确认不是已充值的证明；收到 New API 的成功响应后，付款页显示「返回充值站」。
- New API 通知以签名 form POST 发送，必须得到 2xx 和正文精确为 `success` 才标为送达。传输不确定时重发同一个商户订单号和平台流水号；依赖该 New API 版本账本事务内去重，而不是声称 HTTP 恰好一次投递。正常运行需保持后台链上轮询开启。
- 已知但未发出的成功通知遇到链重组会被取消；如已尝试发送（含 ACK 丢失）或已获 ACK，标为 `RECONCILE`，即使链上重新确认也不自动重发或扣余额。由商户核对链上账本、New API 余额与充值记录后人工处理。确认数并不能消除重组风险。
- 用既有商户会话/API key 查询 `GET /api/epay/orders?out_trade_no=...`（绑定的单一 PID/部署，不接收外部 PID）；`GET /api/epay/orders?state=RECONCILE` 可查询最近 100 条需人工对账的订单。主要状态：`WAITING`（待确认）、`PENDING`（待送达）、`DELIVERED`（New API 已回复）、`SUPPRESSED`（未发送即撤销）、`FAILED`（重试耗尽）及 `RECONCILE`（须人工对账）。`attempts` 为可能发出的请求数，`preflightFailures` 单独记录 DNS 等发出前失败；后台限量指数退避。对 `FAILED`，先确认收款、New API 充值及回调可用性，再按 New API 的商户后台流程人工处理；适配器不提供强制重发或自动冲正。状态库、New API 账本须纳入独立备份，不要删除／回滚单侧数据库来重试。
