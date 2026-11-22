# UPayNow Store API and Payment Notifications

[简体中文](README.md) | **English**

Follow the [installation guide](../docs/INSTALLATION.en.md) to start with a blank instance and deploy or import your own Factory. Run `npm ci && npm start` from the project root. A blank instance has no configured deployments, assets, or orders. The product provides optional network presets. This is not a tutorial for local top-ups or testnet use. See the [Operations Manual](../docs/OPERATIONS.en.md) for routine operations, backups, and recovery.

## Authentication and deployment scope

The store **server** sends its separate API credential as `Authorization: Bearer <API credential>`. Retrieve it in Settings (设置) after reauthenticating with the current password. Neither the login password nor the recovery key works as a Bearer credential. The API credential grants broad business administration permissions, not least-privilege order creation, but cannot access password or credential-management endpoints. Never expose it to customer web pages. The admin console uses the password to establish an HttpOnly, SameSite=Strict cookie; browser write operations also require a same-origin Origin header. Neither changing the password nor resetting it with the recovery key changes the separate API credential. See [Authentication](../docs/AUTHENTICATION.en.md).

`GET /api/deployments` returns `{deployments, defaultId}`. The `id` of each configured deployment is not its chain ID: a chain can have multiple Factories. Explicitly send `X-Upay-Deployment: <id>` for every deployment-scoped request. The server also understands `?deploymentId=<id>`, but do not mix scope sources. The default is `legacy` if unspecified. This identifies the root data instance and does not imply it is configured or uses an older UI. The create-order body can include `deploymentId`; always match the request header. Order reference idempotency is scoped to the selected deployment.

Save the deployment ID, merchant order reference, service order UUID, asset, and returned `checkoutPath` in the store. Do not rely on the current admin selection when looking up orders.

## Creating orders through the API

```sh
# Inject these variables securely on the store server. BASE_URL is your admin/API HTTPS origin.
# Get DEPLOYMENT_ID and TOKEN_CA from the verified deployment details.
curl --fail-with-body "$BASE_URL/api/orders" \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "X-Upay-Deployment: $DEPLOYMENT_ID" \
  -H 'Content-Type: application/json' \
  --data "{\"reference\":\"$SHOP_ORDER_REFERENCE\",\"token\":\"$TOKEN_CA\",\"amount\":\"10.50\",\"expiresInSeconds\":1800,\"webhookUrl\":\"$WEBHOOK_URL\"}"
```

`amount` must be a positive decimal string. JSON floating-point numbers, scientific notation, and precision beyond the token's decimals are not accepted. `expiresInSeconds` defaults to 1800 and accepts 1–604800 seconds. `reference` is a nonempty merchant order reference of at most 128 characters. Within a deployment, the same reference returns idempotently only if the asset, original amount, expiry duration, and notification settings match. A conflict cannot overwrite an old order. After a network timeout, retry with the same reference and identical parameters. Do not create a new business order reference to bypass an unknown result.

Leave `webhookUrl` empty to disable notifications for that order. When enabled, it must be your own HTTPS URL, with a hostname exactly allowlisted by `UPAY_WEBHOOK_HOSTS`. Use comma-separated hostnames without a scheme, path, or spaces. The empty default permits no external notifications. Notification endpoints must not resolve to private addresses; HTTP redirects are not followed.

The response contains actual order details, including `id`, `deploymentId`, `address`, `chainId`, `factory`, `token`, `expectedUnits`, and `checkoutPath`. Append `checkoutPath` to your service's public origin and give the resulting URL to the customer. `/pay/:token` is the customer checkout route; never send admin credentials there. Use the store API for production orders. In the admin console, Settings → Utilities → Create an order manually (设置 → 辅助工具 → 手动创建一笔订单) is only for tests or making up a missed order. This guide does not provide a fabricated success response.

## Order lookup and idempotent fulfillment

- `GET /api/orders/:id`: store-server order lookup. `GET /api/orders` is the admin list.
- `GET /api/status`: scan position, synchronization errors, and configuration status for the current deployment.
- `GET /api/pay/:opaqueToken` and `GET /api/pay/:opaqueToken/qr`: public order payment details and QR code, with no admin privileges. Protect the complete payment URL as order information.
- `GET /health`: reports whether the process is alive and configured; it does not establish the health of payment verification.

Recognize payments from ERC-20 Transfer records for the exact chain and token, required confirmations, and canonical-chain scanning. Do not add transfers across different token contracts. Keep `paid`, `syncHealthy`, business status, notification status, and collection status distinct. A zero current balance does not mean unpaid, and a successful collection does not mean the order was paid in full. Anyone may trigger a valid collection to the fixed payout.

**The store owns inventory, reservations, deductions, shipping, and refund policy.** At a minimum, fulfillment should:

1. Validate the callback signature and time window. Persistently deduplicate by event ID and use order `stateVersion` to prevent stale events from overwriting newer state.
2. Check the order reference, deployment, chain, Factory, token, original amount, and the store's own amount due. If needed, look up the order server-side and verify `paid === true` and `syncHealthy === true`.
3. Use a business database transaction and unique constraint, or an outbox, to make inventory and fulfillment actions idempotent per order. Retrying the same event, recognizing a new payment generation, or repeating order lookup must not trigger repeat shipping.
4. Handle `payment.reversed`: stop unexecuted fulfillment and reconcile under store policy. The notification does not automatically undo delivery of goods already sent.

There is no exactly-once network delivery guarantee. A fixed confirmation count is not protocol finality. Do not treat a customer's “Paid” declaration as payment evidence.

## Signed notifications

`payment.paid` is generated when payment is recognized, and `payment.reversed` when a reorganization invalidates a recognized payment. The payload includes `id`, `type`, `orderId`, `reference`, `paymentGeneration`, `stateVersion`, `chainId`, `factory`, `orderAddress`, `token`, `expectedUnits`, `confirmedUnits`, `status`, and `latePaymentAccepted`. Integer unit fields are strings, not floating-point values or equivalent US dollar amounts across assets. The payload does not contain `decimals`; get it from verified deployment token information or the order details.

| HTTP header | Meaning |
|---|---|
| `X-Upaynow-Event` | Stable event ID, not event type |
| `X-Upaynow-Timestamp` | Unix timestamp in seconds for this attempt |
| `X-Upaynow-Signature` | Lowercase hexadecimal HMAC-SHA256 |

The exact signed input is `timestamp + "." + raw request body`. The secret is the contents of `webhook.secret` in the **order's deployment** state directory, with the trailing newline removed. Deployments have separate secrets: do not always use the root secret. Retain the original bytes before JSON reserialization, validate the time window and format, and compare signatures in constant time before running business logic. Match the event ID with the payload's event type; do not rely on headers alone.

Return 2xx only after reliably receiving the event; the service then marks it DELIVERED. There are at most eight automatic attempts. Failed deliveries can be requeued from the notifications list without changing their event ID. A retry can use a fresh timestamp and signature, but the body and event identity do not create a new fulfillment. The service may cancel queued events that are no longer valid. Reconcile periodically rather than assuming callbacks can never be lost.

## Explicit merchant acceptance of late payments

Endpoint: `POST /api/orders/:id/accept-late-payment`, with an empty object `{}` as its only accepted body. Use an admin session or the separate API credential and the exact `X-Upay-Deployment`. This is not a public customer endpoint, and the admin UI currently has no late-payment acceptance button. The endpoint does not take an amount, asset, paid flag, or inventory decision field.

```sh
curl --fail-with-body -X POST "$BASE_URL/api/orders/$ORDER_ID/accept-late-payment" \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "X-Upay-Deployment: $DEPLOYMENT_ID" \
  -H 'Content-Type: application/json' \
  --data '{}'
```

If a customer wants an expired order processed, the **store server** first looks it up and checks and reserves inventory. Explicitly accept only if stock is available; otherwise handle it manually. UPayNow does not manage stock reservations, shipping, or refunds.

The service first performs bounded synchronization and verifies sync health, contract identity, and the canonical-chain anchor. First-time acceptance applies only to expired orders with a confirmed late transfer in the original token and enough confirmed funds overall. An on-time partial payment may be counted with a confirmed late top-up, but other assets cannot make up the difference. An ordinary order already paid in full returns its existing state without recognizing a new payment.

HTTP 200 returns full order details and `deploymentId`. The store still checks `paid === true` and `syncHealthy === true` and fulfills idempotently:

- The status is `PAID` or `OVERPAID`; `latePaymentAccepted: true` indicates explicit acceptance.
- `latePaymentAcceptance` stores `acceptedAt`, the verified block and hash, the accepted `depositIds`, and `confirmedUnits`. Original asset, amount, address, and `expiresAt` do not change.
- `receivedAmount` / `confirmedAmount` include accepted funds. `lateAmount` is the amount not yet accepted; `lateReceivedAmount` retains the history of all late funds received.
- Acceptance and the payment outbox are persisted in the same transaction. Repeat or concurrent calls keep the original record and do not produce duplicate events for the same payment generation. Network delivery can still be retried and the store must deduplicate.

Acceptance applies only to the current snapshot of confirmed events, not to future transfers. A reorganization that invalidates these deposits still emits `payment.reversed` and revokes paid status. A repeated acceptance may then return `PAYMENT_NO_LONGER_CONFIRMED`; replacement transfers are not automatically accepted.

Main rejection codes: 401 `UNAUTHORIZED`; 404 `ORDER_NOT_FOUND` / `DEPLOYMENT_NOT_FOUND`; 400 `ACCEPT_LATE_PAYMENT_BODY_MUST_BE_EMPTY`; 409 `ORDER_NOT_EXPIRED`, `NO_CONFIRMED_LATE_PAYMENT`, `PAYMENT_NOT_FULLY_CONFIRMED`, `SCAN_NOT_READY`, `SCAN_REORG_RETRY`, and `PAYMENT_NO_LONGER_CONFIRMED`. An RPC or storage failure is not successful acceptance.

A timeout or disconnect **does not prove failure or justify releasing inventory**. Retry the idempotent endpoint, or look up the order and reconcile acceptance, paid status, and sync health before acting. The endpoint does not send on-chain transactions, spend gas, or replace the store's inventory transaction.

## Administration and collection API index

| Endpoint | Use |
|---|---|
| `POST /api/login` / `/api/logout` | Admin session; login requires a same-origin Origin header |
| `POST /api/scan` | Bounded synchronization; periodic background scanning is also available |
| `POST /api/collect-all/preview` | Preview collection for fully paid orders |
| `POST /api/collect-all` | Accept a collection task for fully paid orders |
| `POST /api/collect` | Manually request standard or wrong-token collection |
| `GET /api/jobs` | Collection jobs and receipts |
| `POST /api/jobs/:id/reconcile` | Reconcile with `{ "transactionHash": "<original transaction hash>" }`, without rebroadcast |
| `GET /api/notifications` | Notification status |
| `POST /api/notifications/:id/retry` | Requeue a retryable notification; body `{}` |
| `GET/POST /api/wallet/config` | Wallet connection configuration |
| `POST /api/wallet/prepare` | Prepare a wallet collection job |
| `POST /api/wallet/jobs/:id/begin`, `attach`, `cancel`, `resolve` | Record intent before sending and recover the original transaction |

Standard manual collection takes `{ "orderIds": ["<order UUID>"] }` and defaults to the token CA used to recognize each order. Pass `token` explicitly to collect another supported CA without changing the order's payment asset. Wrong-token collection uses `wrongToken` and `confirmWrongToken:true`; it cannot be combined with normal `token`. Use the zero address for a native asset. All funds go only to the fixed payout. Another wallet can pay gas for ordinary collection. Dedicated wrong-chain recovery requires the payout wallet on the target chain to sign. Operations are scoped to each chain/deployment, with no wallet grouping or cross-chain collection queue. In external-wallet mode, confirmation continues in the frontend wallet flow. An HTTP 202 does not mean the transaction was broadcast or succeeded. Outer batch success does not guarantee per-item success.

For unknown transactions, record and verify the original hash before acting; do not resend blindly. Manually calling wallet-task `resolve` records an outcome that was not verified on-chain, unlocks the job, and ends that job's automatic observation. It does not establish on-chain success or cancel a sent transaction.

Use the [Multichain Deployment API](MULTICHAIN.en.md) for new Factories. `POST /api/config` only initializes an unconfigured root instance; it cannot overwrite existing deployments. See the [Mobile Handoff Guide](HANDOFF.en.md) for phone capabilities and UNKNOWN recovery.

## Developer automation checks

Run `npm run test:backend` for backend regression checks, `npm run test:frontend-v2` for the frontend, and `npm test` for contracts. These are not merchant operating steps. Isolate tests from merchant state; local results do not establish acceptance on a physical wallet or mainnet. See the [Security Guide](../docs/SECURITY.en.md) for limitations.
