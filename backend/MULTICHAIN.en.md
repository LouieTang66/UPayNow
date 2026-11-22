# Multiple chains, Factory deployment, and import

[简体中文](MULTICHAIN.md) | **English**

UPayNow is a self-hosted tool for a single merchant. One backend can manage multiple EVM chains compatible with the current contracts, including multiple distinct Factories on the same chain. A new instance has no connected deployments, payout wallet, or tokens. Choose new deployment networks from the service's supported list, not from arbitrary EVM chains. See the [User Operations Manual](../docs/OPERATIONS.en.md) for daily use and the [Installation Guide](../docs/INSTALLATION.en.md) for setup and the three HTTPS entry points.

## Add your own deployment

1. After logging in, open “Chains and contracts” and add a deployment.
2. Select a supported network to populate the default RPC, Chain ID, and native gas token symbol. You can change the display name. Only the advanced options allow a custom HTTPS RPC, and it does not bypass network eligibility or on-chain code verification.
3. Enter your own fixed payout address, the exact token contract addresses (CAs) you verified on that chain, and the confirmation count. Check for duplicates, chain membership, and token semantics.
4. Validate and review the summary. No transaction is sent at this point. Verify again after changing key parameters.
5. Only deterministic-v2 merchant contracts can be created now. The fixed payout account itself must sign and pay gas on the target chain. Call the verified public root. Choose an injected desktop wallet, optional WalletConnect, or the mobile deployment entry, then verify the same parameters and explicitly confirm. The backend does not sign on your behalf. WalletConnect requires your own Reown Project ID; save it in Settings even before you have a deployment. The dedicated mobile page does not need it and is a separate entry point.
6. The service registers the deployment only after the required confirmations and verification of the creation transaction, canonical Factory and implementation bytecode and immutable fields, payout, token list, and version. A wallet returning a hash does not mean deployment succeeded.

If you already own a canonical Factory, choose deterministic-v2 or legacy-v1 under “Advanced / Legacy compatibility,” and supply its address and correct start block. Import verifies the existing contract and sends no deployment transaction. Legacy remains supported for historical imports and recovery. You cannot create it, and importing it does not enable wrong-chain recovery. The current version verifies canonical code and immutable fields; a contract with the same name is not necessarily compatible.

The current wallet integration requires a verifiable sending transaction and does not promise support for deployments through internal calls or account abstraction. The target network must support the EIP-1153/Cancun instructions this contract requires. The payout and ordered token list are immutable. A given chain, payout, and pinned version have only one deterministic Factory, so redeploying cannot add, remove, or reorder tokens. A different payout can form another deployment. A new version requires separate release compatibility assessment and is not an ordinary token update in the current UI. Existing settings, orders, and addresses remain intact and cannot be redirected to a new Factory.

The operator predeploys and verifies the public root using the [Independent Operations Deployment Tool](../ops-public-deployer/README.en.md). The ordinary backend cannot create a bootstrap even with an administrator Bearer credential (403 `PUBLIC_BOOTSTRAP_OPS_ONLY`). If the public entry is not ready, stop merchant deployment. Do not ask the merchant to send a bootstrap transaction. Network allowlisting does not replace live on-chain code verification.

## Data isolation and selection

The root data instance ID is `legacy`, an internal identifier. It does not imply an existing chain or an old UI. New deployments are stored separately in `deployments/<uuid>/` within the state root. Each has its own SQLite database, scan cursor, notification secret, orders, and collection tasks. The registry and deployment tasks live in the root state.

Switching the current deployment changes only the management context. Other deployments continue scanning. Scanning and notifications run separately across chains. Keep the records of a failing deployment rather than deleting its historical database to mask the error. Restarting restores state and does not clear databases.

## API scope

Use a Bearer credential with full management access. `GET /api/deployments` returns `{deployments, defaultId}`. Get the ID from a verified deployment record; do not substitute chainId.

For management queries, collection, or notifications, select the deployment with `X-Upay-Deployment: <id>`. The `deploymentId` query parameter is also supported; avoid supplying both. Order creation JSON may include `deploymentId`, which must match the header if supplied. If unspecified, the request defaults to the root instance `legacy`. After creating a deployment, store and explicitly use its ID.

Order-number idempotency is scoped per deployment. The store keeps the deployment ID, order UUID, reference, and returned checkoutPath. Public checkout uses a random token to find the associated order and is unaffected by the current admin selection. See [API Order Creation and Notifications](README.en.md).

## Deployment and import API

Creation task parameters: `name`, a supported `chainId`, `rpcUrl`, `payout`, `tokens` (the exact ordered array of CAs), and `confirmations`. You may explicitly pass `scheme: "deterministic-v2"`; omission also creates v2. The network list determines `nativeSymbol`. For import, also provide `factory`, the corresponding `scheme`, and `nativeSymbol`; you may specify `startBlock`. A new deployment gets its start block from the actual creation receipt.

- RPC must use HTTPS with normal certificate validation. Embedded usernames, passwords, and URL fragments are not allowed. Deployment RPC redirects are not followed.
- The confirmation count is 1–256. The token list must be nonempty and contain no duplicates. Token decimals must be in the range the service supports. A reachable RPC does not establish that a chain or token is safe.
- New deployments use the listed gas token name. For a custom historical import, verify and enter it yourself. The native gas token display assumes 18 decimals.

| Endpoint | Purpose |
|---|---|
| `GET /api/deployment-networks` | List currently supported networks for creation, with default RPCs and gas symbols |
| `POST /api/deployments/import` | Verify and import an existing canonical Factory |
| `POST /api/deployment-jobs` | Validate parameters and create a READY task. If a fully matching canonical Factory already exists, verify and register it as MINED. This endpoint does not broadcast. |
| `GET /api/deployment-jobs` / `GET /api/deployment-jobs/:id` | Look up tasks and continue on-chain verification if a candidate hash exists |
| `POST /api/deployment-jobs/:id/begin`, `{from}` | Persist UNKNOWN, then return the wallet call. For a new v2 deployment, from must be the payout address, to the verified root, no nonce is specified, and value is zero. Historical legacy creation tasks have no to. |
| `POST /api/deployment-jobs/:id/attach`, `{transactionHash}` | Verify the original transaction, receipt, and confirmations, and register the deployment |
| `POST /api/deployment-jobs/:id/cancel`, `{rejected:true}` | Register an explicit wallet rejection; this is not proof that nothing was broadcast |
| `POST /api/deployment-jobs/:id/handoff`, `{}` | Create a restricted mobile entry for the task |
| `POST /api/deployment-tunnel/close`, `{}` | Close the temporary mobile deployment tunnel without canceling UNKNOWN or signed transactions |

## Unknown outcomes and recovery

Connecting a wallet, opening a QR code, and validating parameters do not send a transaction. Explicit confirmation starts one sending flow. UNKNOWN does not mean failure. A timeout, disconnect, refresh, or tunnel closure does not prove a transaction was not broadcast. Keep the task ID and original wallet hash. Register that hash or refresh to keep verifying, rather than creating a new task and blindly resending. With the original authorization still valid, the same task, account, and parameters, and no known hash, among other restrictions, the mobile deployment page can explicitly prompt the wallet again. This is not automatic resending and does not establish that the first transaction was never broadcast.

Set `UPAY_DEPLOYMENT_ORIGIN` for fixed entry. This mode does not need cloudflared. Otherwise, a Quick Tunnel can start on demand for up to 300 seconds. If no usable component exists, it is downloaded automatically on demand from the official source at a pinned version and checked against SHA256. Ordinary startup neither downloads it nor opens public access. An invalid explicitly configured path returns an error rather than falling back. See the [Component Guide](CLOUDFLARED.en.md). Public access reaches only the dedicated deployment port, not the admin port. Even after deployment completes, expires, or is closed manually, preserve unknown tasks and verify their on-chain outcomes.

See the [Security Documentation](../docs/SECURITY.en.md) for historical review findings, including recovery from an incorrect candidate hash and RPC response boundaries. Do not claim that organizing the docs fixed those issues. The deployer must verify compatibility with the actual target chain, wallet, TLS setup, and devices. This is not a mainnet acceptance report.
