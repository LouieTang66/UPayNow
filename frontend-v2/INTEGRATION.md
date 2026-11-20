# UPayNow 页面、服务与认证边界

## 启动和路由

项目根目录运行 `npm ci && npm start`。首次实例没有已接入部署、Factory、payout、币种或订单，先登录并从内置已开放网络添加自己的部署；网络预设不等于现成商户合约。构建入口 `npm run build`；构建产物为 `frontend-v2/dist`，管理台与公开页面由各自后台服务挂载，不需要独立前端服务器。

| 服务 | 路由 | 支持的别名 |
|---|---|---|
| 管理服务 | `/` | `/v2/` |
| 顾客收银台（管理服务） | `/pay/:token` | `/v2/pay/:token` |
| 手机部署专用服务 | `/d/:id#capability` | `/v2/d/:id#capability` |
| 手机归集专用服务 | `/c/:id#capability` | `/v2/c/:id#capability` |

默认三个服务仅监听 loopback，端口依次为 8790、8792、8791。固定 HTTPS origin 与代理配置见 [安装说明](../docs/INSTALLATION.md)，日常管理与恢复见 [完整操作手册](../docs/OPERATIONS.md)；手机完整链接必须指向自己的专用服务，不能将路径粘贴到管理服务或将手机域名代理到管理端口。

静态资源统一采用 `/v2/assets/`，服务按角色提供所需 bundle/CSS。不得暴露源码、source map、数据库、密钥或运行目录。`/legacy/` 与旧静态 UI 不是产品入口；既有 `/pay/`、`/d/`、`/c/` 路由不要求重建订单或合约。

## 管理会话与商城 API

首次通过恢复密钥证明身份并设定密码；`GET /api/auth/status` 公开是否已设密及密码最短长度，不返回凭据。`POST /api/login` 只接受登录密码，设置 HttpOnly、SameSite=Strict 会话，HTTPS 时使用 Secure Cookie。`POST /api/auth/reset` 同时用于首次设密和重置，轮换恢复密钥并注销全部会话，不直接登录；首次设密也要保存返回的新恢复密钥。浏览器写请求必须同源；Host、Origin 和对应服务角色应一致，不新增 CORS 绕过。

前端不持久保存密码、恢复密钥或 API 凭据。管理请求通过 Cookie 认证，部署范围通过 `X-Upay-Deployment` 绑定；所有 auth/* 路由属于全局接口，不带部署头。改密码和恢复操作后须清理旧会话及在途界面状态。商城服务器使用独立 Bearer API 凭据；不能用于密码/凭据管理接口，也不能交给顾客浏览器，详见 [API 接入](../backend/README.md)及[认证说明](../docs/AUTHENTICATION.md)。

修改密码不轮换恢复密钥；修改或重置密码均不轮换 API 凭据。查看凭据或修改密码时，当前密码输错返回 401 `UNAUTHORIZED`，不清除仍有效的当前会话；`SESSION_REQUIRED` 才按会话失效处理。认证限流返回 429 `AUTH_RATE_LIMIT`，不要根据旧前端状态词典的 `LOGIN_RATE_LIMIT` 集成。

正式商城 API 开单后交付 `/pay/:token` 收银台；设置中的辅助工具另有测试/补单入口。接受迟付仅有管理认证 API，没有 UI 按钮。支付认定、通知 2xx、商城履约和归集结果必须分别处理。

## 手机能力与恢复

手机服务只接受当前批准操作的短期 capability，不获得管理角色。fragment 在本标签页可写入 sessionStorage 后从地址栏移除，刷新恢复仍受服务器截止/撤销约束。不要将二维码、完整链接、存储内容公开。

发送前服务先持久 UNKNOWN，钱包返回原哈希后登记核验。超时、刷新、断线和关闭临时通道不能证明未广播，不自动再发。登记原哈希、明确拒签和人工风险关闭必须分别处理。钱包任务人工 `resolve` 会停止该任务自动观察，人工结果不是链上收据验证。部署/归集任务与订单付款状态各自独立；详见 [恢复边界](../backend/HANDOFF.md)。

## 数据和版本边界

重新构建或替换页面不应删除状态、密钥、历史部署、订单和交易哈希，也不会升级链上不可变合约。备份、更新、代理和进程托管均由部署者负责，不新增内建运维产品，不允许两进程共享同一数据目录。

实体钱包、WalletConnect relay、手机内置浏览器、EIP-681、目标链和真实 HTTPS 都需独立确认。前端改善不能自动消除历史后端候选哈希、RPC 秘密、deploymentId 冲突或崩溃恢复风险；这些是 [安全文档](../docs/SECURITY.md) 中的待最终复核线索，不作为已修复声明。

## 开发者自动化检查

`npm run test:frontend-v2`、`npm run test:backend` 和 `npm test` 分别是前端、后端和合约回归入口。检查应使用隔离数据，不属于用户充值/付款步骤，不代替实体手机、生产 TLS、主网或独立审计验收。
