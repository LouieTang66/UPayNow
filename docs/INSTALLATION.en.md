# UPayNow Installation and Deployment

[简体中文](INSTALLATION.md) | **English**

Repository: <https://github.com/LouieTang66/UPayNow>. Obtain the source through an authorized access method and enter the project root. The instructions start from a clean instance and require no existing chain configuration or personal deployment data.

This guide is for deployers. See the [Merchant Operations Manual](OPERATIONS.en.md) for the console walkthrough and the [Documentation Index](README.en.md) for all guides.

## 1. Environment and Data Directory

Use Node.js 22.19 or a newer compatible release with `node:sqlite`, npm, and a local filesystem that can persist SQLite data and enforce file permissions. Some Node releases warn that SQLite is experimental.

Run under a dedicated service account. Before the first start, set `UPAY_DATA_DIR` to an absolute path for a protected persistent directory. Do not use a temporary or publicly served directory, unprotected removable media, or a directory shared with another instance. The default is `backend/state/`, relative to the project.

The service reads **process environment variables**. The repository's `.env.example` is a reference without real data and is not loaded automatically. Inject variables explicitly through the process manager, container environment, or shell. Configure merchant Factories, payouts, token contract addresses (CAs), and orders through the authenticated product workflow; they are not preset in the example. The application has presets for enabled networks and RPCs and fills in network parameters when you select a network. It does not provide merchant contracts or orders.

## 2. Install, Start, and Set the Initial Password

From the project root:

```sh
npm ci && npm start
```

First startup does not configure networks, deploy a Factory, or create orders. The service binds to local loopback `127.0.0.1` by default. Open `http://127.0.0.1:8790`, prove your identity with the deployer's recovery key, and set a password. Use only the password for regular sign-in. See [Authentication](AUTHENTICATION.en.md) for the read-only recovery-key tool and reset procedure. Startup logs do not expose credentials.

The password, recovery key, and store API credential are separate. The recovery key only sets or resets the password; it cannot sign in or act as a Bearer credential. The store API credential still grants broad business-management permissions and is not a least-privilege order-creation token. The data directory's `auth.json` is sensitive authentication state. Keep it out of chats, screenshots, tickets, public directories, and Git. Do not delete it as a substitute for recovery or rotation.

The root and each deployment have state including SQLite, notification secrets, and task records. New deployment subdirectories are stored under `deployments/<uuid>/`. Each deployment has its own `webhook.secret`; the store's verification service must securely obtain the matching deployment secret rather than always using the root secret. Do not give notification secrets to browsers.

## 3. Three Dedicated HTTPS Entrypoints

For external access, the deployer supplies DNS, trusted TLS certificates, and a reverse proxy. Use a distinct origin for each of the three roles. The reserved example domains below are not working services.

| Environment variable and example | Default local upstream | Role |
|---|---|---|
| `UPAY_PUBLIC_ORIGIN=https://merchant.example.com` | `http://127.0.0.1:8790` | Admin console, store API, and customer checkout |
| `UPAY_HANDOFF_ORIGIN=https://collect.example.com` | `http://127.0.0.1:8791` | Mobile page and restricted endpoints for this collection task |
| `UPAY_DEPLOYMENT_ORIGIN=https://deploy.example.com` | `http://127.0.0.1:8792` | Mobile page and restricted endpoints for this Factory deployment task |

Override ports with `UPAY_PORT`, `UPAY_HANDOFF_PORT`, or `UPAY_DEPLOYMENT_PORT`. Use bare HTTPS origins with no path, query, fragment, username, or password. Preserve the configured Host through the proxy. The Origin on browser write requests must match its entrypoint; do not weaken CORS or forge an origin to bypass checks.

Do not send mobile domains to the admin port or place admin credentials in mobile QR codes. The admin service also serves customer checkout and the API. If restricting network access to the admin surface, define precise proxy paths and access rules that preserve needed checkout and API access, and verify them yourself. There is no fourth built-in management isolation service. `/health` indicates only process liveness and configuration status, not whether chain scanning or payment verification is healthy.

Fixed HTTPS entrypoints do not need cloudflared. Without fixed mobile origins, the service prepares a Cloudflare Quick Tunnel only when a user creates a mobile entrypoint. It first checks an explicitly configured executable, then reuses an available system executable; if neither is available, it automatically downloads the pinned official Cloudflare release on supported platforms, verifies its SHA-256, and stores it in a component cache under the protected data directory. Ordinary users do not normally need to install it in advance. An invalid explicit `UPAY_CLOUDFLARED` path causes an error without silently switching to another executable. Nothing runs if verification fails. See the [Component Guide](../backend/CLOUDFLARED.en.md) for supported platforms, the pinned version, and errors.

Normal service startup does not download components or automatically expose a public tunnel. After component preparation and a successful tunnel connection, temporary mobile sessions last up to five minutes. Expiry does not cancel a signed transaction. Temporary tunnels have no persistent availability guarantee, and the third-party provider may see traffic. For production, deployers can configure fixed entrypoints and verify access boundaries independently. A QR code containing `127.0.0.1` is not reachable from a separate phone.

## 4. Add Your Own Network and Factory

After signing in, go to “Chains and Contracts” → “Add Network” and select an enabled network. The application fills in the RPC, Chain ID, and native gas symbol; the latter two are read-only when creating a configuration. Leave the default RPC unless you need a different node, in which case use “Advanced: Custom RPC (HTTPS).” Enter your own fixed payout and exact token CAs, verified separately on each chain, and check the payment confirmation threshold. No payout address is preset or recommended. Validation and preview do not send transactions.

- **New deployment:** Create a deterministic-v2 merchant deployment only on an enabled network whose public entrypoint is ready. The project operator prepares that entrypoint; it is not a separate transaction ordinary merchants must sign. Connect a desktop wallet, use WalletConnect, or open the restricted mobile deployment page. Check the network, payout, and CAs before confirming. The signing account must equal the fixed payout and pay gas on that chain. The service registers the Factory only after verifying the original deployment call, confirmations, canonical bytecode, and immutable fields.
- **Import:** Enter your own compatible Factory and the correct starting block for scanning, then verify its on-chain identity. The import itself incurs no deployment gas. Similar contract names or ABIs do not establish compatibility.

A new merchant deployment calls the existing fixed public entrypoint from the payout account. The transaction has a `to` address; it is not a direct contract-creation transaction with no recipient. The service can still verify historical legacy deployment tasks and import existing contracts; it does not allow new legacy deployments. Arbitrary smart accounts and exchange deposit addresses are not guaranteed to support the required signing. The target chain must actually support the instructions used by the current contracts, including EIP-1153/Cancun. Being EVM-compatible or having a working RPC is not sufficient on its own. Native gas currency display assumes 18 decimals; this is not applicable to arbitrary non-EVM chains.

Payout and supported CAs are immutable after deployment. The Factory address is fixed for a given chain, payout, and deployment version; changing only the token list cannot create another Factory. Plan an independent deployment for a different configuration, for example using another fixed payout wallet you control, and retain the original deployment and its orders. A connected wallet, an open QR code, or a reachable RPC does not prove deployment success. A timeout or disconnect leaves the task UNKNOWN. Find and record the original wallet transaction hash before recovering, rather than redeploying blindly. See [Merchant Manual, Section 2](OPERATIONS.en.md#2-add-a-network-and-deploy-a-payment-contract) for the exact controls and recovery steps.

## 5. Store Integration and Collection

Set an accurate `UPAY_WEBHOOK_HOSTS` domain allowlist. On the store server, keep the separate API credential, deployment ID, and matching notification secret. See [Store Integration](../backend/README.en.md). Orders are created through the store API. Customers receive only randomized payment links, not admin credentials.

Payment and collection have separate states. The store verifies signatures, deduplicates notifications, looks up orders, and fulfills them idempotently. The merchant reviews the collection preview and confirms in their own wallet, paying gas. Errors, reorganizations, late payments, and wrong-token transfers are not automatically successful payments.

## 6. Stop, Back Up, and Recover

Stop gracefully through the process manager or send SIGTERM/SIGINT. Never run two instances against the same state directory. An abnormal exit may leave `owner.lock`; verify that the associated process has stopped before the deployer handles the stale lock. Do not remove a running instance's lock.

The deployer is responsible for backups, monitoring, updates, certificate renewal, and recovery drills. Back up the **entire state root and every deployment subdirectory**, including configuration, keys, orders, notifications, and unknown tasks. Use a consistent SQLite backup mechanism, or stop the service gracefully before copying the entire state. Hot-copying only `merchant.sqlite` does not ensure that WAL data is preserved. Backups contain sensitive credentials; encrypt them and restrict access.

During recovery, preserve keys and original transaction records and verify on-chain state before handling UNKNOWN tasks. Do not wipe the database to hide a problem or reassign old orders to a new Factory. Keep a restorable backup before upgrading. An application upgrade does not upgrade immutable on-chain contracts. See [Security](SECURITY.en.md) for other limits.
