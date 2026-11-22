# UPayNow Security Limits and Deployer Checks

[简体中文](SECURITY.md) | **English**

See [Installation](INSTALLATION.en.md) for deployment and the [Operations Manual](OPERATIONS.en.md) for routine management, backups, and unknown-transaction recovery.

## Current Product Boundaries

- A single merchant and process with persistent SQLite state, one instance per directory. This is not a multi-tenant, multi-role, highly available, or disaster-recovery platform. Admin access uses password sessions; the recovery key only sets or resets passwords. The separate API credential still grants broad business permissions but cannot access password-management or credential-viewing endpoints. It is not a least-privilege order token. There are no multiple roles, MFA, or API credential rotation UI. See [Authentication](AUTHENTICATION.en.md).
- The main management service also serves checkout and the API. Mobile deployment and collection have two separate restricted services with no admin sign-in or admin lists. Deployers must correctly map the three HTTPS origins and protect admin access. Do not work around access issues by allowing open CORS, disabling TLS verification, or proxying mobile domains to the admin port.
- RPC details, database data, notification secrets, and complete capability links are sensitive. RPC URLs can contain provider credentials in their path or query. Keep them out of screenshots, logs, public documentation, and QR codes. Treat them as server-side secrets and inspect API response boundaries even if the UI does not display them.
- Connecting a wallet does not give the server its private key. In normal operation, an external wallet confirms each deployment or collection transaction and pays gas. Do not configure or upload the merchant wallet's private key.
- Quick Tunnel is an optional temporary third-party access channel with no stability guarantee; the provider may see traffic. Deployers supply certificates, DNS, access control, and operations for fixed HTTPS entrypoints.

## Contract Immutability and Asset Limits

- The payout and supported CAs are immutable after construction. There are no admin, upgrade, pause, Hold, fee, or redirection interfaces. Adding tokens, changing wallets, or changing versions requires a new Factory; existing orders cannot be changed. A compromised wallet or issuer restrictions can continue affecting older orders; there is no admin rescue.
- Each Factory operates only on its own chain. The same CA on a different chain does not mean the same configuration. Checking that code exists and reading decimals does not certify asset authenticity or compatibility; name/symbol alone are not sufficient.
- The current contract uses a transient-storage guard and needs real target-chain support for instructions such as EIP-1153. Not all EVM chains are guaranteed compatible. The compiler settings are Solidity 0.8.38, optimizer 200, viaIR, and Cancun; verify chain compatibility independently.
- Standard collection reads the pre-transfer balance once and uses SafeERC20. It does not verify the merchant's net gain or that the final balance is zero. Fee-on-transfer, rebasing, and misleading balance or transfer semantics are unsupported. `Collected.amount` is the requested transfer amount, not a promise of net settlement.
- No supported CA can go through the wrong-token endpoint. Wrong-token or native-currency handling only transfers funds to the fixed payout; it is not a refund. Do not pay the Factory or implementation: neither has a balance-recovery endpoint. Pay only the correct asset to the matching order address.
- Anyone may pay gas to call collection but cannot choose another recipient. QR-code expiry only revokes the ability to start the action from the web page. It does not revoke downloaded calldata, broadcast transactions, or the contract's permissionless access.
- Batches reject empty arrays but guarantee neither a fixed count, a per-item gas cap, nor a gas reserve for the entire batch. Extreme gas use can affect later items or revert the whole batch. Simulate, leave headroom, split batches sensibly, and reconcile each (order, CA). The number of successful attempts is not the number of fully paid orders.
- A fixed payout cannot prevent a compromised checkout or service from showing an attacker's address. Protect release artifacts, admin permissions, and the business order mapping.

## Payment and Notifications

Recognize payment only from valid on-chain payment records for the exact asset. Current balances, collection events, and the outer transaction status do not substitute for those records. Reorganization handling has limited depth; beyond the saved anchors, history requires manual reconstruction. A confirmation count is not protocol finality. Do not treat RPC failures or a scanner that has not caught up as healthy verification.

Notification delivery is retried, not exactly once. The store verifies HMAC over `timestamp + "." + raw body` and checks the time window, using the `webhook.secret` for the order's deployment rather than always using the root secret. `X-Upaynow-Event` is the event ID, not the event type. Deduplicate by event ID, reject stale overwrites using stateVersion, and implement idempotent order fulfillment and reconciliation for payment.reversed. Automatic delivery makes at most eight attempts, and manual requeue preserves the event ID. A 2xx acknowledgment only means reliable receipt, not successful fulfillment or collection. UPayNow does not manage inventory, shipping, or refunds. Accepting a late payment accepts only the particular confirmed settlement snapshot; it does not override inventory decisions or reorganization handling. This is currently available only through the authenticated administration API, without a UI button. See the [Notification and Late-Payment API](../backend/README.en.md).

## Wallets and Unknown Outcomes

Persist the intent before handing off to the wallet. UNKNOWN means the transaction might already have been sent. A disconnect, reload, tunnel closure, timeout, or missing hash does not prove nothing was broadcast; do not resend automatically. Recording an explicit signing refusal is not on-chain proof of non-broadcast either. Keep the task ID, record the original wallet transaction hash, and check the actual chain state. Manually calling `resolve` releases the wallet task lock and stops automatic observation for that task. The recorded manual outcome does not prove on-chain success or cancel a transaction.

Wallet deployment currently targets ordinary EVM accounts submitting transactions directly. New deployments are deterministic-v2 merchant deployments on allowlisted networks. The fixed payout wallet calls the verified deterministic deployment entrypoint, and its wallet request includes `to`. The operator predeploys the public entrypoint outside the merchant's add-network flow. Existing legacy-v1 deployments can be verified and imported, but creating new legacy-v1 deployments is not supported. Selecting a preset network fills in the RPC without removing the need to verify the chain and code. Not all smart-account or account-abstraction deployments are guaranteed. Deployers must verify injected wallets, WalletConnect, mobile wallet browsers, and EIP-681 scanning on their own devices and target networks.

For ordinary collection, another wallet may pay gas while the recipient stays fixed. Dedicated wrong-chain recovery requires the payout wallet to sign and pay gas on the target chain. There is no wallet grouping or cross-chain collection queue; verify each task by chain and deployment.

## Cross-Chain Deterministic Deployment and Recovery

- New deployments require verifying the target chain's canonical ERC-2470 runtime code and the runtime code of the currently pinned deployer. Code at the expected address is not necessarily correct. A working RPC cannot make a chain with no public entrypoint supported.
- Merchant Factories are reproduced with CREATE3; the on-chain token allowlist remains fixed. Only the fixed payout wallet can initialize its merchant Factory, preventing someone else from locking in bad settings first. Exchange deposit addresses and other payouts that cannot send deployment transactions are unsuitable for this mode. The public deployer has no admin, fee, or redirection interface.
- A matching address requires the same deployer version, payout, and original order hash. Updating the build, changing code, or regenerating orders may change addresses. Do not rewrite old Factories or orders or claim they automatically gain new recovery capabilities.
- Recovery must be bound to the original order and a separate verified deployment scope. Read the selected token CA or native balance on the target chain and confirm each transaction. These tasks are isolated from source-chain recognition, statistics, and notifications. Recovery is not source-chain payment success, a bridge, or an automatic refund.
- Recovery cannot bypass token freezes, transfer restrictions, incompatible chain instructions, or a target-chain payout the merchant does not control. The same textual smart-wallet address on another chain does not establish the same control. Collection event amounts do not represent the merchant's net settlement.
- Recovery tasks are persisted and use the target deployment's concurrency controls, unknown-hash reconciliation, and reorganization checks. Switching chain or current deployment must not change an approved task's scope. Do not bypass an unknown outcome by creating another task.

See [Cross-Chain Deterministic Deployment and Recovery](CROSSCHAIN-V2.md) for the design and local acceptance requirements.

## Recovery and Privacy Boundaries to Check Before Launch

Verify the installed version and actual deployment for each issue below. Normal startup and passing automated tests do not establish coverage of all failure windows.

- **Candidate hash recovery:** Confirm how a mistaken candidate hash can be corrected after recording it for a deployment task, and what limits apply. Do not wipe the database or redeploy to bypass an unknown outcome.
- **Mobile RPC privacy:** Check whether the mobile API returns a complete RPC URL containing credentials. Not showing it in the UI does not mean the server omitted it.
- **Deployment scope consistency:** Check deploymentId conflicts across header, query, and body consistently. Integrators should use one scope source; match header and body for order creation if both are used.
- **Unexpected exit recovery:** Specifically verify owner.lock, database consistency, and recovery of UNKNOWN tasks. A normal restart is not proof of safety in every crash window.

Without targeted review, do not characterize these boundaries as all broken or all resolved in the current release. Include unverified areas in launch decisions.

## Deployment and Authorization Responsibilities

Use protected persistent storage for the data directory and restrict service-account privileges. Do not treat a hot copy of one WAL-mode database file as a complete backup. Include keys, all deployment subdirectories, orders, and unknown tasks in a consistent backup. Deployers are responsible for certificates, upgrades, RPC failover, backups, and recovery drills; these are not built-in operations features.

The project selected ELv2 and includes the root LICENSE, but the core contracts still carry their original `UNLICENSED` label. Their provenance and licensing coverage are pending verification; the repository has not been established as fully relicensed. See [License Scope](LICENSE_SCOPE.en.md). Preserve OpenZeppelin and other third-party SPDX identifiers, copyright, and licenses. See [Third-Party Notices](../THIRD_PARTY_NOTICES.en.md) for WalletConnect's community license and other distribution obligations. Contract inputs, on-chain code, and third-party licensing were not changed.
