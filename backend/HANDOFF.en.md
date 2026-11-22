# Mobile capability links and exception recovery

[简体中文](HANDOFF.md) | **English**

Mobile collection uses `/c/:id#capability` and mobile deployment uses `/d/:id#capability`. Separate restricted services serve these routes. See [mobile collection](MOBILE-HANDOFF.en.md) and [deployment and import](MULTICHAIN.en.md) for the procedures. Neither is the customer checkout or the admin sign-in page.

See the [merchant operations guide](../docs/OPERATIONS.en.md) for the full first-user workflow. A dedicated mobile capability link differs from desktop WalletConnect, which needs your own Reown Project ID. You can save it before a deployment exists. Dedicated wrong-chain recovery does not support these mobile links; use an injected desktop wallet or desktop WalletConnect.

## Capability scope

- A collection ticket uses a random 256-bit bearer credential; the server stores a digest. The credential appears in the URL fragment, not the query string, and contains no admin credential or private key.
- The mobile page keeps the credential in sessionStorage for that tab and removes the fragment from the address bar to support reloads. This storage grants no permanent access: server expiry and revocation still apply. Close the session after using a shared device.
- Anyone with the full link can view and attempt the approved action. Do not share QR codes, full links, browser storage, or screenshots publicly.
- The server binds the chain, Factory, payout, and approved order and token scope or deployment parameters. The phone cannot substitute them. Its service does not provide admin sign-in, order lists, or other ordinary admin APIs.
- A collection ticket can bind at most one durable transaction job. The same sender may resume a PREPARED job that has not begun; refreshing does not create another job.

## States and recovery rules

1. **Not started:** A PREPARED job may be resumed or invalidated and released when allowed. Expiry and revocation prevent new prepare or begin operations.
2. **Starting submission:** The service persists UNKNOWN before passing the transaction to the wallet. Record rejection only if the wallet explicitly rejects it. A rejection report is not on-chain proof that nothing was broadcast.
3. **Unknown outcome:** UNKNOWN is not failure. A disconnect, timeout, reload, closed tunnel, or registration failure neither cancels nor resends automatically. Save the job ID, find the original wallet transaction hash, and register it for verification. Within the original approval and deadline, the mobile page lets the user explicitly bring up the wallet again only under restricted conditions, including the same job, sender, and approved scope, and no known hash. This does not create a second job or prove the first attempt was never broadcast.
4. **Submitted:** Verify the actual chain, account, target, calldata, value, original hash, and real receipt. A wallet-returned hash is not a successful receipt.
5. **Completed:** Check each item separately. Partial failure must not be displayed as complete success. Collection results do not replace payment status.

Collection administrators can create a ticket with `POST /api/handoffs`, inspect it with `GET /api/handoffs/:id`, revoke it with `POST /api/handoffs/:id/revoke`, and close a temporary tunnel with `POST /api/handoffs/tunnel/close`. Revoking an unstarted ticket is different from closing its window. Revocation cannot cancel an UNKNOWN or broadcast transaction.

With fixed HTTPS, a job already started may still accept the original hash and show its receipt under restricted rules after its ticket expires or is revoked. It may not start a new send. When a temporary tunnel closes, its old URL is no longer accessible. Recover from the admin console; a later tunnel does not revive the ticket.

## Web revocation is not on-chain cancellation

Anyone can pay gas to call the collection contract, but the funds go only to the fixed payout. QR expiry, website closure, or ticket revocation cannot take back already downloaded calldata or cancel a transaction the wallet has broadcast. Closing the tunnel cannot undo a deployment transaction either.

The balance at ticket creation is a snapshot. At execution, collection sweeps the entire current balance of the specified token contract address. Handle late deposits, payment recognition, inventory, and refunds in their own workflows. The gas payer for ordinary same-chain collection need not be the payout. New v2 merchant deployments and dedicated wrong-chain recovery require the payout wallet's signature.

After an explicit rejection, the collection task is observed for 64 more blocks. Rejection does not prove that nothing was broadcast. Manual admin resolve marks the job ABANDONED and stops automatic observation. A manual outcome is not verified on-chain and is not a successful receipt, payment status, or refund. Independently verify wallet and chain records first.

See [installation](../docs/INSTALLATION.en.md) for fixed and temporary HTTPS entry points, and [security](../docs/SECURITY.en.md) for outstanding review of historical candidate hash recovery, RPC confidentiality, and other risks. Updating this document does not eliminate those risks.
