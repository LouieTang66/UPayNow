# 多链、Factory 部署与导入

**简体中文** | [English](MULTICHAIN.en.md)

UPayNow 是单商户自部署工具，一个后台可管理多条兼容当前合约的 EVM 链，同一链也可保留多套不同身份的 Factory。全新实例没有已接入部署、收款钱包或币种；新建网络从服务提供的已开放名单选择，并非任意 EVM 链。日常使用见 [用户操作手册](../docs/OPERATIONS.md)，安装及三个 HTTPS 入口见 [安装说明](../docs/INSTALLATION.md)。

## 添加自己的部署

1. 登录后进入“链与合约”，添加新的部署。
2. 选择已开放网络，自动填写默认 RPC、Chain ID 和 gas 原生币符号；显示名称可改。只有高级选项允许自定义 HTTPS RPC，不能借此绕过网络准入或链上代码核验。
3. 填写自己固定的 payout、该链上逐项核实的代币 CA 和确认数，检查重复、链归属及代币语义。
4. 校验并核对摘要；此时没有发送交易。修改关键参数后须重新核验。
5. 当前只新建 deterministic-v2 商户合约：使用固定 payout 本身签名并支付目标链 gas，调用已核验的公共 root。选择电脑注入钱包、可选 WalletConnect 或手机部署入口，核对同一份参数后明确确认；后台不代签。WalletConnect 需自己的 Reown Project ID，可在尚无部署时先到设置保存；手机专用页无需该 ID，二者不是同一入口。
6. 达到确认数且服务核验创建交易、Factory/implementation 规范字节码及不可变字段、payout、币种表、版本后，登记部署。不是钱包返回哈希就视为部署成功。

已有自己的规范 Factory 可通过“高级／历史兼容”选择 deterministic-v2 或 legacy-v1 导入，提供地址及正确起始区块；导入仅核验已有合约，不发送部署交易。legacy 继续支持历史导入与恢复，不支持新建，也不会因此获得错链找回能力。当前版本按规范代码和不可变字段核验，不能把任意同名合约视为兼容。

当前钱包集成要求可核验的发送交易，不承诺兼容内部调用/账户抽象部署。目标网络须支持当前合约需要的 EIP-1153/Cancun 指令。payout 和有序币种表不可更改；同链、同 payout、同固定版本只有一个确定性 Factory，不能通过重新部署增减或重排币种。换 payout 可形成另一套部署；更换版本须由发布兼容性另行评估，不能视为当前 UI 的普通改币操作。旧配置、订单和地址继续保留，不能迁移指向新 Factory。

公共 root 由运营方通过 [独立运维部署工具](../ops-public-deployer/README.md)预部署并核验。普通后台即使有管理员 Bearer 也不能新建 bootstrap（403 `PUBLIC_BOOTSTRAP_OPS_ONLY`）；公共入口未就绪应停止商户部署，不能要求商户先补发一笔 bootstrap。名单准入不替代实时链上代码检查。

## 数据隔离与选择

根数据实例 ID 为 `legacy`，是内部标识，不表示已有链或旧界面。新部署分别保存在状态根目录 `deployments/<uuid>/`，各自具有 SQLite、扫描游标、通知密钥、订单和归集任务；注册表及部署任务存于根状态。

切换当前部署仅改变管理上下文，不停止其他部署扫描；不同链分别运行扫描/通知，故障部署保留记录，不应删除历史库掩盖错误。重启恢复状态，不清库。

## API 范围

使用完整管理权限的 Bearer 密钥。`GET /api/deployments` 返回 `{deployments, defaultId}`；从已核验部署记录取得 ID，不使用 chainId 代替。

管理查询/归集/通知通过 `X-Upay-Deployment: <id>` 选择；也支持 query `deploymentId`，不建议同时提供。开单 JSON 可包含 `deploymentId`，与 header 必须相同。未指定默认根实例 `legacy`，因此新建部署后必须保存并显式使用其 ID。

订单号幂等作用域是每套部署。商城保存部署 ID、订单 UUID、reference 和返回的 checkoutPath。公开收银台按随机 token 找到相应订单，不受管理台当前选择影响。详见 [API 开单和通知](README.md)。

## 部署与导入 API

创建任务参数：`name`、已开放 `chainId`、`rpcUrl`、`payout`、`tokens`（准确且有序的 CA 数组）、`confirmations`；可显式传 `scheme: "deterministic-v2"`，省略也按 v2 新建，`nativeSymbol` 由网络名单确定。导入另含 `factory`、对应 `scheme` 和 `nativeSymbol`，可指定 `startBlock`；新部署起始区块取真实创建回执。

- RPC 必须 HTTPS，正常验证证书，不允许 URL 内嵌用户名密码、fragment，不跟随部署 RPC 重定向。
- 确认数为 1–256；代币列表非空、无重复，decimals 需在服务支持范围内。RPC 能访问不证明链或代币安全。
- 新建使用名单的 gas 币名称；历史自定义导入须核实并填写。原生 gas 币显示按 18 decimals 处理。

| 接口 | 作用 |
|---|---|
| `GET /api/deployment-networks` | 查询当前已开放新建网络及默认 RPC、gas 符号 |
| `POST /api/deployments/import` | 核验并导入已有规范 Factory |
| `POST /api/deployment-jobs` | 校验参数并创建 READY 任务；若已有完全匹配的规范 Factory，可直接核验登记为 MINED；本接口不广播 |
| `GET /api/deployment-jobs` / `GET /api/deployment-jobs/:id` | 查任务，已有候选哈希可继续链上核对 |
| `POST /api/deployment-jobs/:id/begin`，`{from}` | 持久 UNKNOWN 后返回钱包调用；新建 v2 的 from 必须为 payout，to 为已核验 root，不指定 nonce，value 为零；历史 legacy 创建任务无 to |
| `POST /api/deployment-jobs/:id/attach`，`{transactionHash}` | 核验原交易、回执和确认数并登记部署 |
| `POST /api/deployment-jobs/:id/cancel`，`{rejected:true}` | 明确拒签登记，不是链上未广播证明 |
| `POST /api/deployment-jobs/:id/handoff`，`{}` | 为该任务创建受限手机入口 |
| `POST /api/deployment-tunnel/close`，`{}` | 关闭手机部署临时通道，不取消 UNKNOWN 或已签交易 |

## 未知结果与恢复

连接钱包、打开二维码、核验参数都不发交易；明确确认才进入一次发送流程。UNKNOWN 不是失败；超时、断线、刷新或关闭通道不证明未广播。保留任务 ID 和原钱包哈希，通过登记原哈希/刷新继续核对，不通过新建任务盲目重发。手机部署页在原有效授权、同一任务/账户/参数且没有已知哈希等限制下可显式再次唤起钱包；这不是自动重发，也不证明第一次未广播。

固定入口设置 `UPAY_DEPLOYMENT_ORIGIN`，此模式不需要 cloudflared；未设置时可按需启动最长 300 秒的 Quick Tunnel。缺少可用组件时会按固定版本与 SHA256 校验从官方来源自动下载，普通启动不下载也不开放公网；显式指定路径无效会报错而不 fallback，详见 [组件说明](CLOUDFLARED.md)。公网访问只到部署专用端口，不能到管理端口。部署完成、截止或手动关闭后仍须保留未知任务并核对链上结果。

错误候选哈希恢复、RPC 返回边界等历史审查线索见 [安全文档](../docs/SECURITY.md)。实际目标链、钱包、TLS 与设备兼容性由部署者确认。
