# UPayNow 多 CA、同订单地址：合约接口（v3）

**简体中文** | [English](multi-ca-interface.en.md)

项目仓库：<https://github.com/LouieTang66/UPayNow>。此文是当前 `ForwarderFactory` / `ForwarderImpl` 源码接口说明，不是待实现的界面设计稿；标题 v3 指多 CA 合约的 `SALT_VERSION=3`，不等于应用部署方案 `deterministic-v2` 的版本号。此文面向需要直接接入合约的开发者；普通部署者从 [空白安装](INSTALLATION.md) 和 [完整操作手册](OPERATIONS.md) 开始，商城优先使用 [服务器 API](../backend/README.md)。没有预置 Factory、payout 或币种，接口示例不能代替真实部署配置。当前说明不代表主网验收或安全审计完成。

## 先用简单的话说明

一个 Factory 在部署时填入：

```text
固定商户收款钱包
支持的 CA 列表，例如本链核实后的 USDT、USDC
```

以后每个订单只生成一个收款地址，不会因用户选 USDT 或 USDC 而变化。归集时告诉 Factory“归集这个订单的哪一种币”，该币直接转给固定商户钱包，另一种币不动。

合约不会：定价格、查美元汇率、把不同币数量相加、决定哪个币种的付款有效、阻止用户转入第二种币或判断订单付够。“一个订单不允许混合支付”仍由商家后台执行认单规则；链上实际收到多种币时，它们可以分别归集，但不能据此判定业务付款有效。

## 部署时固定的名单

```solidity
constructor(address payout_, address[] settlementTokens_)
```

- payout 不能为零地址、本 Factory 地址、某个名单内的 token CA 或本 Factory 创建的 implementation。
- 名单不能为空；每项必须有代码，不能为零地址/普通钱包，不能重复。
- 基本校验不证明资产真伪；准确链 ID、认可 CA 与兼容性仍需事先核实。
- 名单只在构造时写入，合约没有后续新增、删除、替换接口，也没有管理员或升级权。
- 已部署 Factory 不能增加 CA、换 payout 或升级，也不会更新旧订单。应用新建 deterministic-v2 还受同链、同 payout、同固定版本唯一 Factory 的限制，不能简单重部署来增币；换 payout 可形成另一身份，版本变更需另行发布兼容性评估，见[部署说明](../backend/MULTICHAIN.md)。
- 一个 Factory 只在它部署的那条链生效，不会自行跨链转移资产。应用的 deterministic-v2 可在满足严格条件的另一链部署同址 Factory 并找回误付资产；这不是桥接、自动跨链归集或源订单认单，见 [跨链同地址部署与恢复](CROSSCHAIN-V2.zh-CN.md)。

## 单币版到多币版的变化

| 旧单币版 | 新多币版 |
|---|---|
| 构造 `(payout, token)` | 构造 `(payout, [tokenA, tokenB, ...])` |
| `settlementToken()` | `getSettlementTokens()`、`isSupportedToken(token)` |
| `collect(orderHash)` | `collect(orderHash, token)` |
| `collectBatch([hashA, hashB])` | `collectBatch([{orderIdHash,token}, ...])` |
| `collectBatchItem(orderHash)` | `collectBatchItem(orderHash,token)`，仍仅 Factory 自用 |
| Collected 不带 CA | Collected 带 indexed token |
| CollectFailed 不带 CA | CollectFailed 带 indexed token |
| 订单模板固化单一 token | 订单模板只固化 hub 与 payout，由 Factory 校验本次 token |
| SALT_VERSION=2 | SALT_VERSION=3，地址规则不含所选 token |

`predictAddress(orderHash)`、`deploy(orderHash)`、`collectWrongToken(orderHash,token)` 的参数形状不变。它们属于新版 Factory；这不代表新旧 Factory 的同一订单地址相同，也不代表能用新版 ABI 控制旧部署。

## 全部 Factory 函数

### 查询，不发交易时不付链上 gas

```text
payout() -> address
getSettlementTokens() -> address[]
isSupportedToken(address token) -> bool
predictAddress(bytes32 orderIdHash) -> address
computeSalt(bytes32 orderIdHash) -> bytes32
SALT_VERSION() -> uint8，当前为3
implementation() -> address
forwarderCodehash() -> bytes32
isForwarder(address forwarder) -> bool
```

`getSettlementTokens` 返回部署时的完整列表；不存在单数的 settlementToken getter。不能只根据 symbol/name 判定 token，后台始终保存链 ID 与准确 CA。

`predictAddress` 只用订单标识；不传 token。计算规则包含版本、订单 hash、payout，CREATE2 还绑定该 Factory 和 implementation。对同一个已部署 Factory，同一个 hash 的地址不会因归集选择变化。

尚未部署的订单地址可以先收到代币；这时 isForwarder=false、代码为空不代表付款无效，后台应从地址展示前就安排监听和补扫。

### 普通写操作

```text
deploy(bytes32 orderIdHash) -> address forwarder
collect(bytes32 orderIdHash,address token) -> uint256 amount
collectBatch(CollectRequest[] requests) -> uint256 succeeded,uint256 failed
collectWrongToken(bytes32 orderIdHash,address token) -> uint256 amountSent
```

`CollectRequest` 是：

```solidity
struct CollectRequest {
    bytes32 orderIdHash;
    address token;
}
```

- collect 只接受名单内 CA，校验在部署订单之前执行；不支持的币不能冒充正常结算。
- 每次 collect 仅归集指定币的全部当前余额，不动其他支持币或错币。
- 空余额是成功尝试，但不发 Collected；重复归集不会重复转走旧余额。
- collectBatch 每项按 `(订单,CA)` 隔离。允许同订单不同 CA，也允许重复项；不是业务上允许混付的声明。
- 空批次回滚；没有恢复固定数量、单项 gas 或总预留限制。后台仍须预演、留余量、拆批并逐项核对。
- succeeded 不是已付款订单数。空项和重复项也可能成功；外层 status=1 不代表全项成功。
- collectWrongToken 拒绝名单内的所有 CA，而不仅仅拒绝其中一种；零地址表示原生币，其他未支持 token 走人工路径。
- 所有入口的资金目标仍只有 payout，不接受调用者传入接收人。

### 内部批量入口

```text
collectBatchItem(bytes32 orderIdHash,address token) -> uint256 amount
```

只有 Factory 自己可以调用，后台/部署人直接调用会 OnlySelf。不要把它当公开后台 API。

## 订单小合约的接口

```text
hub() -> address
payout() -> address
sweepSettlementToken(address token) -> uint256 amount
sweepWrongToken(address token) -> uint256 amount
receive()：接收原生币的特殊入口
```

两个 sweep 只允许固定 hub，也就是创建 implementation 的 Factory。Factory 校验支持列表后，才选择正常/错币路径。模板不持有或自行修改名单，也没有初始化、改向、管理员、任意调用或升级接口。

后台应从 Factory 触发写操作，不直接调用订单小合约。不要向 Factory/implementation 付款；误转那里仍无找回入口。

## 事件必须按 CA 分账

```solidity
event ForwarderDeployed(bytes32 indexed orderIdHash, address indexed forwarder);
event Collected(bytes32 indexed orderIdHash, address indexed forwarder, address indexed token, uint256 amount);
event CollectFailed(bytes32 indexed orderIdHash, address indexed forwarder, address indexed token, bytes4 reasonSelector, uint256 returnDataSize);
event WrongTokenCollected(bytes32 indexed orderIdHash, address indexed forwarder, address indexed token, uint256 amountSent);
```

后台分别记录：订单、准确 CA、该币最小单位数量、交易哈希、日志序号和区块信息。不把 USDT 数量加到 USDC 数量上，也不从这些事件计算统一美元金额。

Collected.amount 只是该次请求转出的数量，不保证独立测得的净到账，不证明足额付款。WrongTokenCollected 永远不能直接充当正常订单支付证据。

单笔失败整笔回滚，不产生 CollectFailed。批量子项失败且外层交易最终成功才会留下相应失败事件。全批回滚则不会保留这些日志。

若同订单的 tokenA 失败但 tokenB 成功，tokenB 对订单合约的部署/登记可以保留；不能再根据 tokenA 失败就要求该地址必定没有代码。失败应精确到 `(订单,CA,这次尝试)`。

## ethers 接入形状示例

下面是给开发者的示意代码，不含真实配置/密钥，不是已经运行的生产后台：

```js
// 业务订单映射必须保存；哈希规则固定且不重用。
const orderHash = ethers.id('upaynow:merchant-id:unique-order-id');
const address = await factory.predictAddress(orderHash);

// 商家后台开单时决定唯一认单币种与金额；当前收银台不切换订单币种。
// 等符合你的付款/确认策略后，只归集指定 CA。
const tx = await factory.collect(orderHash, USDT_CA);
const receipt = await tx.wait();
// 解析正确 Factory 的 Collected，核对 token/order/address。

// 同一 Factory 的批量输入：
const tx2 = await factory.collectBatch([
  { orderIdHash: ORDER_A, token: USDT_CA },
  { orderIdHash: ORDER_B, token: USDC_CA },
]);
const receipt2 = await tx2.wait();
// status=1 只代表外层成功，还要查逐项事件/结果。
```

支持名单包含两币，不要求每个订单都使用两币；后台不必为了这次改造引入混付、兑换或汇率模块。

SDK 发交易先返回交易对象/哈希，不会在收据里自动给出函数 return 的 amount/计数。模拟调用只能预判，最终以有效链上的收据、事件和状态核对。

## 必须继续保持的后台边界

- 付款流水来自准确代币合约对订单地址的 Transfer；归集流水来自正确 Factory 的事件/对应转出。不要混记。
- 不只看当前余额判断付款，合法第三方也可能提前归集。
- 合约不决定分次付款、锁币、少付/超付/迟付规则。当前服务器在开单时固定一个认单 CA 和金额，同币分次到账按确认规则累计，不同币不能补足；接受迟付只通过管理认证 API 明确接受已确认快照，当前 UI 无接受按钮。
- 没有链上混付禁止、金额、过期、确认数、付款成功或自动退款字段；本轮没有新增。
- 固定 payout 和名单不防止网页展示攻击者地址；保护部署配置和收银台。
- 正常 token 仅一次转前余额查询并 SafeERC20 转账，不恢复余额差/清零比较，也不支持税币、rebasing、说谎代币。
- 相同 token CA 跨不同链也不等于同一业务资产配置，始终绑定 chainId。

## ABI、构建与授权边界

以当前源码构建生成的 Factory/implementation ABI 和规范字节码为接入依据；旧单币 Factory 不会因应用更新而升级，不能用当前 ABI 假定旧部署具有同一能力。部署或导入都必须核验真实链、规范代码和不可变字段。

`npm run build` 用于构建，自动化检查入口见[开发与隔离检查](DEVELOPMENT.md)，不是付款操作教程。本地或分叉检查不能证明实网兼容或独立安全审计完成。其他限制见 [安全说明](SECURITY.md)。

项目已选用 ELv2 作为自有部分许可方案；核心合约原 `UNLICENSED` 标识与固定编译输入本次未改，合约来源及覆盖范围仍待核查，详见[许可范围说明](LICENSE_SCOPE.md)。第三方组件原版权和许可继续适用；此接口文档不是额外的合约授权文书。
