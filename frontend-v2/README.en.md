# UPayNow user interface

[简体中文](README.md) | **English**

This package provides the UPayNow admin console, customer checkout, and mobile wallet confirmation pages. Repository: <https://github.com/LouieTang66/UPayNow>. Pages use real data from same-origin services. Do not substitute fabricated orders, balances, or success states for API errors.

## First use

Run `npm ci && npm start` from the project root. Follow the [installation guide](../docs/INSTALLATION.en.md) to configure a persistent data directory, login password and recovery key, and required HTTPS origins. A fresh instance has no registered deployments, Factory, payout, tokens, or orders. Built-in network presets are not predeployed merchant contracts. After signing in, add your network and confirm the Factory deployment with your own wallet, or import an existing compatible Factory.

A standalone frontend server is not needed. The backend serves the admin pages, and each dedicated service serves its own wallet deployment or collection pages. See [service and access boundaries](INTEGRATION.en.md) for routes and permissions, and the [merchant operations guide](../docs/OPERATIONS.en.md) for walkthroughs and recovery.

## Pages and features

- **Overview:** Orders, payments, and items needing attention for the current deployment.
- **Orders:** Order lookup, payment history, original amount and token contract address, checkout links, and related collection records. Amounts in different tokens are not aggregated into USD.
- **Sweep:** Collectible funds, exception recovery, and collection history. Preview a batch and confirm it on mobile or with a desktop wallet. Collection of other supported tokens and explicitly confirmed wrong-token handling remain available.
- **Payment webhooks:** Check delivery and requeue eligible notifications. A displayed success does not prove the store fulfilled the order.
- **Chains and contracts:** Add or import your own Factory, inspect on-chain identity and deployment records, and change the display name without changing the contract. New merchant deployments use deterministic-v2 on admitted networks only. Selecting a network fills its preset RPC. The operator predeploys the public entry point, which is verified; the signing wallet must be the fixed payout. The fixed payout and token list are immutable after deployment. Redeploying on the same chain with the same payout and version cannot add tokens. A different payout creates a separate deployment; retain the old one. Historical contracts can be imported after verification.
- **Store integration:** The store server creates orders through the API, verifies signatures, deduplicates notifications, and fulfills orders idempotently. See [store integration](../backend/README.en.md). Do not provide admin credentials to customer-facing pages.
- **Settings:** Password, recovery key, separate API credential, and wallet connection. Optional WalletConnect requires the deployer's own Reown Project ID; injected wallets and dedicated phone pages do not. “Utilities → Create an Order Manually” is for testing or one-off replacement orders. Create regular production orders through the store API.

The deployment selector sets the active admin context. Switching does not stop scanning other deployments, rewrite original orders, or change a Factory or payout. Collection stays bound to the deployment selected when it started. Switching networks must not redirect the funds.

`/pay/:token` is the customer checkout. It shows the payment network, token contract address, amount, order address, QR code, and verification status. The UI has no button for accepting late payments. The store backend can explicitly accept a confirmed payment snapshot via the API; see [late payment handling](../backend/README.en.md#explicit-merchant-acceptance-of-late-payments). The mobile deployment and collection pages can confirm only the currently approved action and do not grant admin rights. Verify the network and payment details before explicitly confirming in the wallet and paying gas.

## Wallets and security

Payment and collection statuses are shown separately. An outer batch success does not prove each item succeeded. Connecting a wallet, opening a QR code, and previewing do not send a transaction. A timeout, disconnect, or closed tunnel leaves the outcome unknown. Find the original hash and resume verification rather than resending automatically. Manually recording an outcome stops automatic observation of that wallet job; it is not on-chain verification. A full mobile link carries short-lived authority and must not be shared publicly.

Another wallet may pay gas for ordinary collection; funds still go only to the fixed payout. Dedicated wrong-chain recovery requires the target-chain payout wallet to sign. Operations are scoped to a chain and deployment. There are no wallet groups or cross-chain collection queues.

Sign-in uses an HttpOnly server session. The frontend does not persist passwords, recovery keys, or API credentials. The short-lived mobile capability can be stored in the current tab's sessionStorage for reload recovery, but is not permanent. The server controls expiry and invalidation.

The frontend does not replace server-side verification of assets and chain identity, the store inventory system, or fulfillment transactions. Outstanding backend review items are listed in the [security guide](../docs/SECURITY.en.md).

## Development: build and checks

Run `npm run build` from the project root. Production services mount the generated `frontend-v2/dist` directly. The frontend bundles its wallet adapter separately. `npm run test:frontend-v2` runs frontend regression checks.
