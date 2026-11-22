# Cross-chain deterministic deployments (v2)

[简体中文](CROSSCHAIN-V2.zh-CN.md) | **English**

This is the scheme used for all new merchant deployments, not an upgrade of existing on-chain contracts. Legacy CREATE deployments remain supported for historical import/recovery, with their original order hashes, payment accounting and immutable collection destinations; creating new legacy deployments is disabled. Existing addresses do not acquire recoverability by upgrading the application. Merchant procedures are in the [user operations guide](OPERATIONS.en.md); this document retains the technical deployment and recovery boundaries.

## Address construction

The legacy `ForwarderFactory` and `ForwarderImpl` money-moving contracts remain unchanged. A new `DeterministicDeployer` creates a merchant Factory through a CREATE3 pattern:

1. Use the canonical ERC-2470 SingletonFactory to deploy a version-pinned, constructorless deterministic deployer with a fixed salt.
2. That deployer creates a fixed-code CREATE2 proxy using a salt bound to the scheme version and merchant payout.
3. The proxy uses its first CREATE to instantiate the unchanged merchant Factory with that chain's approved token list.
4. The Factory creates its implementation as before and predicts per-order clones from the original order hash and payout.

The same verified bootstrap address, compiler outputs, version, payout and original order hash reproduce the same Factory, implementation and order address on supported compatible chains. The merchant transaction nonce and chain-specific token list do not determine these CREATE3 Factory addresses. Token whitelists remain constructor-fixed on each chain; CREATE3 avoids making those chain-specific constructor arguments part of the cross-chain Factory address.

Contract versions and bytecode must be pinned. Rebuilding with different settings or changing deployer/embedded Factory creation code can change the scheme's root address. Never advertise an arbitrary new build as compatible with previously issued v2 addresses.

## Trust and authorization

The canonical SingletonFactory address is `0xce0042B868300000d44A59004Da54A005ffdcf9f`. Its runtime must match the published ERC-2470 deployment exactly, not merely occupy the expected address. The official raw deployment transaction has hash `0x803351deb6d745e91545a6a3e1c0ea3e9a6a02a1a4193b70edfcd2f40f71a01c` (verify against the official ERC before relying on a copied value).

The deployment API must fail closed on an absent or counterfeit canonical factory. It must never silently fund the canonical deployer account or broadcast its raw transaction on a user's real network. A verified canonical factory is a chain prerequisite, not a promise that every EVM RPC is supported.

Bootstrapping the constructorless root is permissionless. Merchant Factory creation requires the transaction sender to equal the immutable payout; this prevents someone else locking the merchant's deterministic address to an unwanted token list. The fixed recipient cannot be changed by a front-runner, proxy caller or recovery operator. A payout which cannot send an appropriate wallet transaction (for example an exchange deposit address) is not suitable for this v2 deployment mode. Legacy deployments do not gain this restriction.

Factory reuse validates the complete existing identity and exact ordered token registry. A different list (including reordered entries) is a conflict, not permission to alter the constructor-fixed whitelist. In this v2 scheme there is one merchant Factory per payout, chain and pinned deployer version: changing the approved token list cannot deploy a second same-version Factory with the same payout. Preserve the old deployment. A different payout forms a different deployment identity; a different family/version requires separately reviewed release compatibility, not a current UI override. New legacy deployment is not an escape hatch. The creation proxy rejects callers other than its creating deterministic deployer. Failed creation rolls back proxy creation and its consumed flag.

## Application workflow

The merchant UI selects an admitted network and fills its default RPC, Chain ID and native gas symbol. An advanced HTTPS RPC override does not admit another network or bypass code verification. New-job requests accept only deterministic-v2 (omitting the scheme also creates v2); legacy-v1 is available only for historical import/recovery. The backend admission list is available at `GET /api/deployment-networks`.

Network operators predeploy and verify the public root with the [isolated public deployer](../ops-public-deployer/README.en.md). The ordinary backend rejects new bootstrap jobs, even with an admin Bearer, with 403 `PUBLIC_BOOTSTRAP_OPS_ONLY`. Historical bootstrap-job recovery paths remain available. Merchants do not bootstrap the root as a preliminary transaction: missing or invalid public code blocks merchant deployment. Admission policy and real-time chain/code verification are separate requirements; an arbitrary RPC or successful operator bootstrap does not itself open a network for merchants.

Deterministic calls have a `to` address: operator bootstrap calls the verified singleton; merchant creation calls the verified deterministic root and requires `from == payout` plus gas on that chain. Existing legacy creation transactions have no `to`. Wallet intent validation distinguishes these cases rather than disabling recipient validation. Exact network, sender, value, calldata, target and receipt/block verification remain mandatory. UNKNOWN is not failure and does not trigger automatic resend. The dedicated mobile deployment flow permits a restricted, explicit wallet re-prompt for the same approved job/identity before its original deadline when no hash is known; it is not proof that the original attempt was never broadcast.

Merchant creation supports injected desktop wallets, desktop WalletConnect, or a dedicated mobile capability link. WalletConnect requires the merchant's Reown Project ID, which can be saved before any deployment exists; the dedicated phone entry does not require it. Fixed HTTPS phone origins need no cloudflared. Temporary entries prepare the pinned, checksum-verified official component on demand and do not open on ordinary startup; see [component details](../backend/CLOUDFLARED.en.md).

Successful root bootstrap is not a merchant deployment and must not register an empty Factory. Successful merchant deployment requires the expected event, runtime, immutable payout/implementation/codehash, whitelist and sufficient confirmations before registration.

## Wrong-chain recovery

Preserve the original order hash; do not create a replacement invoice with a new random UUID. A recovery preview requires separately registered deterministic-v2 deployments on different chain IDs; revalidates canonical code and immutable fields on both chains; checks matching payout, Factory, deployer and implementation; and verifies both predictions against the original order address. Public-root readiness alone is insufficient: the target merchant deployment must also be registered and verified. The preview queries the explicitly selected target-chain CA (zero address for native asset), not a symbol or RPC label as proof of identity.

Recovery jobs are durable, target-chain-scoped collection tasks, not new invoices. They must not alter the source order's paid status, emit a payment-success webhook, silently auto-accept another asset or invent a cross-chain bridge. Funds are swept to the fixed payout on the target chain. The merchant subsequently decides how to refund or account for recovered assets.

Dedicated recovery requires the target payout wallet to sign and have target-chain gas. It supports desktop injected wallets and desktop WalletConnect, but not the dedicated phone handoff flow. This stricter sender rule does not apply to ordinary same-chain permissionless collection, whose gas payer need not equal payout. After an unknown recovery outcome, select the target deployment's collection recovery view and reconcile the original transaction rather than starting another attempt. For external-wallet collection jobs, explicit rejection retains observation for 64 more blocks; administrator manual resolve marks ABANDONED and ends automatic observation without on-chain verification or payment confirmation.

The recovery UI must freeze the target deployment and original order identity throughout wallet approval. Changing wallet network or deployment selection must not redirect the transaction. A missing hash remains an unknown outcome requiring reconciliation, not evidence that sending again is safe.

## Acceptance requirements

The following is an acceptance checklist, not a report that these tests were executed or passed during this documentation update.

Use two independent local EVM chains with distinct chain IDs, distinct merchant transaction nonces and different approved token CAs. Bootstrap the same pinned deterministic deployer, demonstrate equal Factory/implementation/order addresses, transfer a real test token into the target-chain counterfactual address before code exists, then execute deployment and recovery to the fixed payout.

Also cover unauthorized configuration/creation, proxy access, repeated deployment, mismatched token reuse, unsupported/counterfeit bootstrap code, cancellation/unknown transaction persistence, chain/scope changes, no source payment/webhook changes, and all legacy contract/backend regressions.

Installing canonical bytecode as a local test fixture is not evidence that a live chain has it. State fixture boundaries and separately verify real-chain prerequisites before offering a chain as supported. No live-network deployment or transfer is authorized by local tests.

## Limits

Recovery requires a compatible supported chain and a transferable asset; freezes, malicious token behavior and unavailable signing wallets can prevent success. Equivalent textual addresses are not proof that the merchant controls a contract wallet deployed differently on another chain. The payout's control on the target chain must be established where it is not an ordinary EOA.

Existing factories are not upgradeable. Keep their records and address algorithms intact. Switching to the new scheme is a new deployment and new-order decision, not a rewrite of old orders or balances.
