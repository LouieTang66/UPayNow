# Third-Party and Distribution Notices

[简体中文](THIRD_PARTY_NOTICES.md) | **English**

The ELv2 license selected for the project's own components does not replace the licenses of the components below. See the [license scope](docs/LICENSE_SCOPE.en.md) for the historical license identifiers of the core contracts and the scope that remains to be verified. This document describes the principal components directly used or referenced in this repository. It is not a complete compliance inventory of all transitive dependencies, a legal opinion, or an independent security audit.

## WalletConnect / Reown

**Portions © 2025 Reown, Inc. All Rights Reserved**

This project uses WalletConnect through `@walletconnect/universal-provider`. The five installed and locked version 2.26.0 packages, `@walletconnect/core`, `sign-client`, `types`, `universal-provider`, and `utils`, include the same **WALLETCONNECT COMMUNITY LICENSE AGREEMENT** (marked Release Date: 20 August 2025), not the MIT License. The [full original text](licenses/WalletConnect-COMMUNITY-2.26.0.md) is included verbatim from the packages for that version and has not been replaced with this project's license.

Pay particular attention to the original terms:

- Section 2 sets out obligations relating to distribution notices, copies of the license, applicable logos and branding, and connectivity to the Reown network.
- Section 3 sets out commercial licensing thresholds. The text shipped with the packages lists 2,500,000 monthly RPC requests and 500 monthly active users (MAU), and reserves the upstream right to change those thresholds. This summarizes the terms shipped with that version, not current pricing for online services. It does not mean this project or any operator has exceeded a threshold or must pay immediately. The original text governs the definition of MAU for applications and wallets; storefront page views are not a substitute.
- Section 1's terms on SDK modifications are distinct from ordinary application development. Consult the original text; it should not be summarized as granting the upstream provider copyright over the entire application.

WalletConnect is an optional connection method in the UI, but the dependency is statically imported. Leaving the Project ID blank does not necessarily mean its code is absent from the build. This source repository includes the notice and full license text. Check standalone frontend bundles, installers, containers, websites, and other distributions against their actual contents for the applicable licenses, notices, and branding. Do not rely on this document to claim that all distribution obligations have been met or to circumvent upstream terms.

## OpenZeppelin Contracts

This repository retains some vendored OpenZeppelin Solidity files under the original [MIT LICENSE](contracts/lib/openzeppelin-contracts/LICENSE):

> Copyright (c) 2016-2025 Zeppelin Group Ltd

The original SPDX identifiers, copyright notices, version comments, and additional credit in Math.sol are retained in the source files. The last-updated comments differ across files; this notice does not assign a single release tag to the entire directory. This project's ELv2 does not cover or replace those MIT terms.

## Other Direct Runtime Dependencies

| Component | License and included text | Scope |
| --- | --- | --- |
| ethers | [Full MIT text](licenses/ethers-MIT.txt) | Retains Richard Moore's original copyright and license text. |
| qrcode | [Full MIT text](licenses/qrcode-MIT.txt) | Retains Ryan Day's original copyright and license text; it does not cover the transitive dependencies on that basis. |

The actual dependency versions are recorded in `package-lock.json`. Dependencies installed via npm retain the licenses shipped in their respective packages. If redistributing bundled JavaScript or dependency files, retain applicable notices and check the full dependency graph rather than a single field in `package.json`. Development tools and transitive dependencies use licenses other than MIT, including MPL, Apache, ISC, and BSD in the lockfile. This document neither relicenses them all under the permissive MIT License nor treats them all as this product's runtime code.

## cloudflared

The temporary mobile entry can fetch the official cloudflared component on demand. This independent component is covered by its upstream Apache-2.0 license and third-party notices. For the download source, pinned version, SHA256, and cache boundaries, see the [cloudflared component guide](backend/CLOUDFLARED.en.md). Ordinary startup does not automatically open a public tunnel; fixed HTTPS does not require this component.

No cloudflared binary was downloaded, bundled, or distributed as part of this update. If a distribution bundles one separately, include the LICENSE, NOTICE, and any other documents required for that release. This project's download documentation alone does not establish that distribution obligations have been met.

## ERC-2470 and Public Standards Code

Deterministic deployment uses the standard deployment transaction and runtime of the [ERC-2470 Singleton Factory](https://eips.ethereum.org/EIPS/eip-2470). The Copyright section of the standard waives the relevant rights under CC0; see the [original ERC-2470 text in ethereum/ERCs](https://github.com/ethereum/ERCs/blob/master/ERCS/erc-2470.md). This project's use of the standard does not imply ownership of the standard, the official SingletonFactory, or any third-party marks. Verifying the specification source and bytecode is not a substitute for checking authorization for the project's own core contracts.

## What This Document Does Not Cover Automatically

- It does not change any existing third-party SPDX identifiers, copyright notices, or licenses, or claim that any token, wallet, RPC or network service, or other component has been relicensed under ELv2.
- It does not accept service terms, assess commercial usage, obtain required commercial licenses, or pay for third-party features on behalf of operators.
- It does not establish that separately extracted npm packages, frontend bundles, binaries, or containers automatically carry all this repository's documentation and license materials. Recheck when packaging, bundling, or distributing them.
