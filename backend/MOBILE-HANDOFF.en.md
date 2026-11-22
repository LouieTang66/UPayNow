# One-time mobile collection

[简体中文](MOBILE-HANDOFF.md) | **English**

New users should start with the [merchant operations guide](../docs/OPERATIONS.en.md). This is the dedicated mobile collection capability link, not desktop WalletConnect. Dedicated wrong-chain recovery is not available on this mobile entry point; use an injected desktop wallet or desktop WalletConnect.

## Workflow

1. In the admin console, view collectible orders for the current deployment. Preview and confirm the batch items.
2. Create the QR code for this mobile session and open the full link in the mobile wallet's in-app browser.
3. Verify the network, Factory, fixed payout, approved orders, and token contract addresses. The page displays balances as of link creation. Collection sweeps the entire balance of the specified token at execution, which may include later deposits.
4. Connect your own wallet and explicitly confirm one collection transaction. The wallet pays gas. For ordinary same-chain collection, this wallet need not equal the payout; funds still go only to the fixed payout. Do not confuse this with the payout-signature requirements for new v2 deployment or wrong-chain recovery. Opening the page, connecting an account, and generating a QR code do not send a transaction.
5. Save the original hash returned by the wallet and let the service verify the receipt. Check SUCCESS / PARTIAL_FAILURE / REVERTED for individual items; outer success is not proof that every item succeeded.

“One-click collection” targets fully paid orders. Manually selecting an order for collection does not prove it was paid in full. Desktop wallets, ordinary collection of other supported tokens, and explicitly confirmed wrong-token handling remain available. All funds can go only to the fixed payout.

## HTTPS access

Standard startup with `npm ci && npm start` uses ports 8790 for admin and 8791 for the dedicated collection gateway. Both listen only on loopback by default. A physical phone cannot reach the computer's `127.0.0.1`; a localhost QR code is not a phone-accessible URL.

A fixed HTTPS origin set with `UPAY_HANDOFF_ORIGIN` is recommended. Reverse proxy it to the local dedicated collection port, preserve Host, and require an exact Origin match. Do not proxy a mobile domain to the admin service. See [installation](../docs/INSTALLATION.en.md) for the three entry points.

Without a fixed mobile origin, a user-confirmed Cloudflare Quick Tunnel can be created on demand. The service first tries an explicitly configured executable, then cloudflared on PATH. Otherwise it downloads the pinned official version and verifies SHA256; manual installation is not normally required. An invalid explicit path errors without silently falling back; see the [component guide](CLOUDFLARED.en.md). Normal startup does not download the component or open public access. A temporary entry lasts up to 300 seconds; refreshes or visits do not extend it. Stop on setup failure rather than displaying a bogus usable link. Availability is not guaranteed and the third-party tunnel provider may see traffic. Fixed HTTPS does not need cloudflared. Set an executable path with `UPAY_CLOUDFLARED`.

A temporary tunnel may close after the receipt is confirmed, at timeout, upon revocation or rejection, or when closed manually. Dismissing the QR window does not revoke the ticket. Closing the tunnel cannot cancel an on-chain transaction or an UNKNOWN job. Fixed HTTPS keeps the endpoint online, but tickets still expire independently.

## Credentials and permissions

The link's fragment carries a short-lived bearer capability for this task, not an admin password. Someone holding the full link can view the approved collection and try to pay its gas. Do not publicly share the QR code, full link, or logs. The dedicated service does not offer admin sign-in, order lists, or general configuration. It requires no Reown Project ID and does not disclose merchant private keys to the phone.

Approval is bound to the network, Factory, payout, orders, and tokens, which the phone cannot replace. Ticket expiry restricts web initiation only; it does not change the permissionless contract or revoke downloaded calldata or broadcast transactions.

Disconnects, timeouts, a closed tunnel, and a missing hash leave the outcome unknown. UNKNOWN is not failure and does not trigger automatic resend. Find the original transaction in the wallet and register it for recovery from the admin console. The mobile page can explicitly prompt the wallet again only under restricted conditions, such as the original approval still being valid, the same job, and no known hash. This does not prove that nothing was broadcast. Explicit rejection retains observation for 64 blocks. Manual admin resolve stops automatic observation and does not confirm the transaction on-chain. See [handoff and recovery rules](HANDOFF.en.md). Verify the physical wallet, in-app browser, TLS, network, and EIP-681 QR behavior on your devices. Automated page tests are not physical-phone or mainnet acceptance.
