# License Scope and Provenance Review

[简体中文](LICENSE_SCOPE.md) | **English**

## Selected License

UPayNow has selected the [Elastic License 2.0 (ELv2)](../LICENSE) for its own code and documentation that the project is authorized to license. ELv2 is source-available, not an OSI-approved open-source license. The official text governs restrictions concerning hosted or managed services, license keys, copyright notices, and other matters. Separate commercial authorization does not waive the independent terms of third-party components.

The root LICENSE does not give the licensor third-party rights it did not already hold. It does not relicense OpenZeppelin, WalletConnect, ethers, qrcode, cloudflared, or other third-party components under ELv2. The [third-party notices and accompanying texts](../THIRD_PARTY_NOTICES.en.md) apply separately.

## Core Contracts: Provenance and Coverage Remain to Be Verified

The three current core source files and their corresponding exported compiler inputs retain `SPDX-License-Identifier: UNLICENSED`:

- `contracts/src/DeterministicDeployer.sol`
- `contracts/src/ForwarderFactory.sol`
- `contracts/src/ForwarderImpl.sol`

`UNLICENSED` is not The Unlicense and does not put the work in the public domain. The addition of the root LICENSE **does not resolve the original provenance, relicensing rights, or ELv2 coverage of these contracts**. Until the scope is clear, do not infer full permission to use, modify, deploy, or redistribute the product's core contracts based solely on the root license. This is an authorization review to complete before public release, not an install step that the current product can work around.

The current self-hosted Factory and Impl match the historical product baseline. Code snapshots, subsequent rewrites, Git commit attribution, block explorer verification, and functional differences cannot by themselves establish the full chain of original authorization. Confirm coverage from the actual sources and contributions. A gap in the evidence does not establish infringement, and differences in implementation do not establish that every line is original.

Until provenance and coverage are verified, this document does not create authorization on behalf of third parties or declare that the core contracts have been relicensed in their entirety under ELv2. The license choice for the application and its documentation is separate from verification of the original rights to the core contracts.

## Why Not Change the First Line of the Solidity Files?

The published deterministic deployment scheme relies on pinned source inputs, compiler and configuration, salt, canonical bytecode, and manifest. Source-file headers form part of the exported inputs. Do not edit Solidity files, rebuild standard-json, recompile, or replace release artifacts just to make the wording consistent without first checking compatibility.

This update only organizes documentation and license text. It does not modify the contracts, their compiler inputs or configuration, the manifest, existing deployments, or on-chain code. Keeping the old identifier does not confer open-source rights. Where explicit authorization is needed, verify provenance first and then document it without disrupting existing deployments.

## Third-Party Components and Distributions

Even if all the project's own core components are ultimately confirmed to fall within ELv2, third-party files, libraries, standards code, and binaries retain their original licenses. In particular, WalletConnect 2.26.0 ships under a community license with distribution, network, and commercial threshold terms. It is not MIT-licensed or authorized for unrestricted commercial use at no charge.

This repository includes the license texts and required explanatory notices for its current direct runtime dependencies. That does not mean that every frontend bundle, npm package, container, or bundled binary automatically includes all licenses, NOTICE files, and applicable branding materials. Check the actual contents when building or separately distributing those artifacts. This update did not change packaging configuration, purchase any licenses, or replace any components.
