# 公共合约独立运维部署工具

目录：项目根目录下的 `ops-public-deployer/`。以下命令在你下载的项目根目录执行。

本工具仅供负责网络开放的运营方预部署公共 root，不是商户添加链的前置点击步骤。商户流程见 [用户操作手册](../docs/OPERATIONS.md)及 [多链部署说明](../backend/MULTICHAIN.md)：从已开放网络新建 v2 商户合约，不能通过普通后台补 bootstrap。本工具的高级自定义链能力不等于该链已进入商户开放名单。

```sh
# 在项目根目录执行
npm ci                 # 已有依赖可跳过
npm run compile         # 校验并生成固定发布编译产物
node ops-public-deployer/server.cjs
```

打开 **http://127.0.0.1:8807**（可用 `PORT=8808 node ops-public-deployer/server.cjs` 改工具端口）。仅监听本机，不修改或使用普通后台数据目录，不需要管理 API 密钥。启动时不打开手机通道，点击扫码才建立临时通道。不要把运维管理服务暴露到公网。

## 使用

1. 填写自定义正整数 Chain ID、HTTPS RPC。与后台共享验证：禁止 HTTP、用户名密码、URL fragment；不跟随重定向。带 API key 的 RPC URL 仍会显示在本地预览中，请保护好。
2. “只读预览”：核验 RPC chainId、官方 ERC-2470 runtime、固定公共入口 runtime，展示字节码哈希。缺 ERC-2470 时明确拒绝；本工具不部署 ERC-2470，也不自动资助其部署账户。
3. 公共入口已经正确存在时，无需部署、发送按钮禁用；错误代码不能覆盖或强行继续。
4. 连接浏览器扩展钱包，切换到目标网络（钱包未添加的网络请先手动添加）。工具无需 payout、币种或私钥，不签名、不广播 RPC raw transaction。后端再次核验链/代码，使用 ERC-2470 的部署 calldata、正确 gas 下限与 eth_call 模拟，钱包账户/chainId 再次检查后才请求钱包确认。gas 由用户钱包支付。
5. 钱包返回交易哈希后展示它，并立即只读核验 chainId 与 runtime。尚未打包时点击“只读核验”重新查询；不会自动重复发交易。成功表示当前 RPC 上代码吻合，不表示已经最终确认，请运维自行核对浏览器交易状态、确认数及重组风险。

## 固定发布边界

- ERC-2470：`0xce0042B868300000d44A59004Da54A005ffdcf9f`
- 公共 root：`0x17F45EFf0a2cB4805180B62034F49c18d66e35EE`
- 发布清单：`../contracts/deterministic-v2-manifest.json`
- 复用 `backend/deterministic.cjs` 的发布/源代码/字节码/runtime 校验。没有地址、salt、字节码的可配置覆盖。API 多余字段一律拒绝。
- 独立管理服务保留 `/api/preview`、`/api/prepare`、`/api/verify`，另加本机同源的 `/api/phone`、`/api/phone/status`、`/api/phone/close`；手机通道只提供本次能力票据接口，不代理管理服务。普通后台即使使用 admin Bearer 也禁止新建 bootstrap（403 `PUBLIC_BOOTSTRAP_OPS_ONLY`）。历史 bootstrap 的查询、begin、refresh、attach、拒签和手机重试继续保留。
- 新商户任务仅部署 merchant；缺公共入口时显示“网络尚未开放”。不因自定义地址绕过发布校验。

## 结果未知与限制

页面在调用钱包前把 pending 标记记入浏览器 localStorage，已有标记时禁止再次发送，哈希也保存在该标记。刷新后先填写原 chainId/RPC，再只读核验。钱包明确拒签会清除标记；其他超时、断网不会清除，也不会重试。如果交易确定失败且 root 未部署，运维须先独立核对钱包/链上记录，才可在浏览器开发者工具中清除对应 `upay-ops-pending:` 项重新预览。不同浏览器/不同 RPC URL 不共享标记；多运维并发应人工协调。

本工具支持浏览器扩展钱包和**手机扫码部署**。点“手机扫码部署”会按需建立专用的 5 分钟 HTTPS 临时通道；用钱包扫码，在钱包内置浏览器中连接并确认。无需 Reown Project ID；优先使用显式指定或 PATH 中可用的 `cloudflared`，缺失时按固定版本和 SHA256 校验从官方来源自动下载，无需默认手工安装。可用 `UPAY_CLOUDFLARED` 指定路径，显式路径错误不 fallback；组件与缓存规则见 [组件说明](../backend/CLOUDFLARED.md)。手机只能操作本次固定链和固定公共入口，不能调用管理 API、改 RPC/字节码/收款钱包。

手机发送状态和哈希独立保存在 `~/HermesData/upaynow-public-ops/`（可用 `UPAY_OPS_DATA_DIR` 指定），不使用商户后台数据。拒签可再次确认；未知状态或已有哈希不自动重发。关闭／过期只关闭通道，不抹掉 UNKNOWN；过期后在桌面“只读核验”并核对钱包记录。源码更新不会改变已打开页面，请刷新运维页。

下列命令是定向验证入口，不代表本次文档更新已执行或通过测试；实体手机签名与真实主网交易仍须使用者另行验收。代码校验依赖用户选择的可信 RPC；建议发布前使用独立 RPC/区块浏览器复核。

## 定向测试（不访问公开 RPC）

```sh
npm run build
node frontend-v2/test-public-live.mjs
node frontend-v2/test-deterministic-live.mjs
node --test backend/test/deployment-service.test.cjs backend/test/deployment-result-ack.test.cjs backend/test/crosschain-v2.test.cjs backend/test/ops-public-deployer.test.cjs
```
