# 第三方与发行声明

**简体中文** | [English](THIRD_PARTY_NOTICES.en.md)

项目自有部分选用的 ELv2 不替代以下组件的许可。核心合约的历史标识和待核查范围见[许可范围说明](docs/LICENSE_SCOPE.md)。下表说明本仓库当前直接使用或引用的主要组件；它不是所有传递依赖的完整合规清单，也不是法律或独立安全审计结论。

## WalletConnect / Reown

**Portions © 2025 Reown, Inc. All Rights Reserved**

本项目通过 `@walletconnect/universal-provider` 使用 WalletConnect。当前安装/锁定的 `@walletconnect/core`、`sign-client`、`types`、`universal-provider`、`utils` 五个 2.26.0 包随附相同的 **WALLETCONNECT COMMUNITY LICENSE AGREEMENT**（文本标注 Release Date: 20 August 2025），不是 MIT。完整原文随附于 [licenses/WalletConnect-COMMUNITY-2.26.0.md](licenses/WalletConnect-COMMUNITY-2.26.0.md)，从该版本安装包逐字复制，未替换为本项目许可。

需要特别留意原文：

- 第 2 条规定分发通知、许可副本、适用 logo/branding 和 Reown 网络连接等义务。
- 第 3 条列出商业许可阈值，随包文本写有月 RPC 2,500,000、月 MAU 500，并保留上游变更阈值的权利。此处转述的是该版本随包条款，不是对当前在线服务报价的确认，也不表示本项目或任何部署者已超额或必须立即付款。应用/钱包的 MAU 定义以原文为准，不能直接拿商城页面浏览量代替。
- 第 1 条关于 SDK 修改的条款与普通应用开发不同，应按原文判断，不能概括为上游取得整个应用的版权。

WalletConnect 是界面中的可选连接方式，但依赖被静态导入；未填写 Project ID 不等于产物一定不包含其代码。当前源仓库已补通知和完整文本；独立前端 bundle、安装包、容器、网站及其他发行物仍须按实际内容核对许可、通知和适用 branding 是否随附。不得以本文件声称已完成全部发行义务，或规避上游条款。

## OpenZeppelin Contracts

本仓库保留部分 vendored OpenZeppelin Solidity 文件，适用原 [MIT LICENSE](contracts/lib/openzeppelin-contracts/LICENSE)：

> Copyright (c) 2016-2025 Zeppelin Group Ltd

源文件的原 SPDX、版权、版本注释及 Math.sol 中的额外 credit 均保留。不同文件的 last-updated 注释并不一致，本说明不把整个目录擅自标成某个统一发行 tag。本项目 ELv2 不覆盖或替换这部分 MIT 条款。

## 其他直接运行依赖

| 组件 | 许可及随附文本 | 边界 |
| --- | --- | --- |
| ethers | [MIT 完整文本](licenses/ethers-MIT.txt) | 保留 Richard Moore 的原版权与授权文本。 |
| qrcode | [MIT 完整文本](licenses/qrcode-MIT.txt) | 保留 Ryan Day 的原版权与授权文本；不因此覆盖其传递依赖。 |

实际依赖版本以 `package-lock.json` 为准。经 npm 安装取得的各依赖保留其随包许可；若重新分发合并 JS 或依赖文件，应保留适用声明并按完整依赖图核对，而不是只检查 `package.json` 的一个字段。开发工具和传递依赖包含不止 MIT 一种许可；例如锁文件还含 MPL、Apache、ISC、BSD 等。本文件不把它们统一改写为宽松 MIT，也不把它们都错误地当作本产品运行时代码。

## cloudflared

临时手机入口可按需下载官方 cloudflared，属于独立组件，适用其上游 Apache-2.0 及第三方声明。下载来源、固定版本、SHA256 和缓存边界见 [cloudflared 说明](backend/CLOUDFLARED.md)。普通启动不会自动打开公网隧道；固定 HTTPS 不需要此组件。

本次没有下载、预置或分发 cloudflared 二进制。若发行物另行预置，应随附对应发行版本要求的 LICENSE/NOTICE 等文件；不能仅凭本项目已写下载说明就认定分发义务完成。

## ERC-2470 与公开标准代码

确定性部署使用 [ERC-2470 Singleton Factory](https://eips.ethereum.org/EIPS/eip-2470) 的标准部署交易和 runtime。标准原文的 Copyright 部分将相关权利以 CC0 放弃，来源见 [ethereum/ERCs 的 ERC-2470 原文](https://github.com/ethereum/ERCs/blob/master/ERCS/erc-2470.md)。本项目引用该公开标准，不表示拥有该标准、官方 SingletonFactory 或第三方标志；规范来源和字节码核验也不能替代自有核心合约的授权核对。

## 不自动覆盖的事项

- 不改变原有第三方 SPDX、版权或许可，也不宣称任意 token、钱包、RPC、网络服务或组件被 ELv2 重新授权。
- 不代替部署者接受服务条款、判断商业用量、取得必要商业许可，或为第三方功能支付费用。
- 不证明单独抽取的 npm 包、前端 bundle、二进制/容器已经自动携带本仓库全部文档和许可；打包、预置或分发时应重新核验。
