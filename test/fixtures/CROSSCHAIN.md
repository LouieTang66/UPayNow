# 本地跨链合约验收

**简体中文** | [English](CROSSCHAIN.en.md)

以下是维护者的隔离测试入口与场景说明，不是主网部署步骤。构建命令会写入本地输入或产物，执行前先阅读[开发与隔离检查](../../docs/DEVELOPMENT.md)。

```sh
npm run build:input
npm run compile
node test/crosschain.cjs
npx hardhat run --no-compile test/self-hosted.cjs
npm run test:compat
```

- 两个独立 Hardhat/EDR provider，chainId 31337 / 31338，Cancun，无公网 RPC、无 fork、无真实交易。不同钱包 nonce 和不同链内代币地址。
- `erc2470.json` 原始交易来自官方 [ERC-2470 Deployment Transaction](https://eips.ethereum.org/EIPS/eip-2470#deployment-transaction)（当前仓库随附交易 fixture，不依赖未跟踪的本机备份）。测试解析交易恢复 sender/hash/address，从官方 initcode 的 `0x20` 偏移提取 `0x134` 字节 runtime，并在两链真实广播原始交易后比对 runtime。没有 setCode、重编译仿制 SingletonFactory 或伪造官方代码。
- 原始交易的 funding 仅发生在测试内存 EVM，随后实际执行 singleton.deploy(rootInitCode, fixedSalt)。官方函数失败返回零地址而不 revert，gas estimation 可能接受内层 OOG，必须提供足够 gas 并在 receipt 后验证目标 runtime，不能只看 receipt.status。
- 根部署 salt 为 `keccak256(UTF8("upaynow:deterministic-deployer:v2"))`，与产品 deterministic-v2 命名一致；根字节码/编译配置或 salt 变化会改变地址，不能当作升级。
- Factory salt 为 `keccak256(abi.encode(keccak256(UTF8("upaynow.factory.create3.v1")), payout))`，不含链 ID、caller 或 tokens。代理地址由固定 initcode CREATE2 得出，Factory 为代理首次 CREATE（nonce 1）。
- `DeterministicDeployer` 无构造参数：`predictFactory(address payout) view returns(address)`、`deploy(address payout,address[] tokens) returns(address factory)`；创建事件 `FactoryDeployed(address indexed payout,address indexed factory)`。部署需 payout 自己发交易，智能钱包需由钱包合约调用。完全相同且有序的 tokens 允许幂等复用；增减/替换/重排均拒绝。历史直接部署的兼容路径保留；这不表示普通商户 UI 仍提供旧模式新建。
- `CrosschainPayout.sol` 是合约钱包重复调用测试夹具，不进入 production 编译输入。测试中的根地址 impersonation 仅用于探测代理第二次 CREATE 被拒绝，不参与部署或收款成功路径。
- Factory/Impl 沿用自部署产品初始快照 `f041097efa20831c57df07a0678c6eeedc7d0814` 的源码基线（该历史对象不包含在本仓库当前 Git 历史中）。本地测试以 `test/crosschain.cjs` 固定的 creation/runtime 哈希核查兼容性，不依赖读取该历史 Git 对象；这是构建基线，不是原始版权或授权证明。订单盐版本仍为 3。跨链同址仅针对同一个新 CREATE3 Factory、payout 与 orderHash；不迁移或保留此前随机地址旧 Factory 的订单地址。
- B 链在 Factory 和订单均未部署前，先用真实 mock ERC20.transfer 向订单地址付款，后部署并 collect / collectWrongToken。wrong-token 归集不是已付款判定；两链各自保有余额、交易与支付账目，不能因地址同名合并。
- 旧资金逻辑依赖 EIP-1153：只允许支持 Cancun 瞬态存储的目标链。Shanghai 负向回归必须在构造器 TLOAD 失败。
