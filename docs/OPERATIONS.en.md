# UPayNow Merchant Operations Manual

[简体中文](OPERATIONS.md) | **English**

Before installing, read [Installation and HTTPS Deployment](INSTALLATION.en.md). See the [Documentation Index](README.en.md) for other resources.

## Reading order

1. First use: Set your password, save your recovery key, prepare your wallet, and understand the active deployment.
2. Add a network and deploy a payment contract: Use built-in network and RPC presets and deploy or import your own contract.
3. Payments and order management: Connect your store, look up orders, and verify payment and notification outcomes.
4. Standard collection: Collect a single order or a batch and confirm in a desktop or mobile wallet.
5. Wrong-token and wrong-chain recovery: First determine whether recovery is possible, then follow the corresponding procedure.
6. Troubleshooting and routine maintenance: Diagnose issues, change your password, back up, restore, upgrade, and migrate.

Each procedure describes when to use it, what to prepare, where to click and what to enter, wallet and gas requirements, what success looks like, and what to do if something goes wrong.

## 1. First use

### 1.1 What to prepare

- Install and start UPayNow. A first installation requires Node.js 22.19 or a newer compatible version, npm, and a persistent data directory. The deployer configures the server; no separate frontend service is required.
- Make sure you are accessing your own instance. The local default is `http://127.0.0.1:8790`. If the deployer changed the port or uses a server HTTPS address, use the actual entry point rather than someone else's admin URL.
- Prepare a password manager or other protected storage for your password, recovery key, and store credential. Do not put them in a public repository or share screenshots.
- Prepare a compatible EVM wallet that you control and can sign with. Connecting a wallet does not require entering its private key or recovery phrase in UPayNow.

A new instance normally has no merchant contracts or orders. Built-in supported networks and RPC presets do not mean the service has already deployed a merchant payment contract for you.

### 1.2 Set the login password for the first time

**When to use:** You open your new instance and see “Set your login password”.

**Before you start:** Obtain the current recovery key for this instance. It comes from the instance's data directory; it is not a wallet recovery phrase, store API credential, or the key for another test instance.

If someone deployed it for you, obtain this instance's recovery key through a trusted channel. If you deployed it yourself, run this read-only retrieval command from the project root on the server or local machine. Replace the example path with the full path to your actual data root:

```sh
npm run recovery-key -- "/path/to/data-directory"
```

The command displays the key in the terminal. Do not include the output in chats, screen recordings, or shared logs. On macOS or Windows, you can instead copy it to the local clipboard without displaying it in plaintext:

```sh
npm run recovery-key -- --copy "/path/to/data-directory"
```

Linux does not currently support `--copy`. Running the clipboard command remotely over SSH does not copy the key to your computer's clipboard. Without a directory argument, the command reads `UPAY_DATA_DIR` from the process environment. If unset, it uses the project's `backend/state/` directory. If you run multiple instances, pass the directory explicitly to avoid retrieving the wrong key.

**Where to click and what to enter:**

1. Enter the “Existing recovery key” on the first-time setup page.
2. Enter “New password” and “Confirm new password”. Use 12–128 characters; the password cannot consist entirely of whitespace. Leading and trailing spaces are preserved, not trimmed.
3. Click “Set password and generate a new recovery key”.
4. On success, the page displays “Password set. Save your new recovery key”. Click “Copy” or “Download backup” and store the new key securely.
5. Check “I have securely saved the new recovery key” and click “Saved — back to password login”.
6. Log in with the password you just set.

**Wallet/Gas:** These are instance authentication operations. No wallet connection, on-chain transaction, or gas is required.

**What success looks like:** You can log in with your password, and the new recovery key has replaced the original key used for setup. Without a merchant deployment, you will see “Get Started with UPayNow”. Click “Add Chain” or open “Settings” first.

**If something goes wrong:**

- “The new passwords do not match”: Recheck both password fields, paying attention to spaces and your input method.
- Invalid recovery key: Confirm that the instance open in your browser matches the data directory read by the command, then retrieve its current key again. Do not delete `auth.json` to bypass verification.
- Retrieval reports `RECOVERY_KEY_UNAVAILABLE`: Confirm that the service started and generated its authentication file, the directory is correct, and your OS account can read it.
- The connection drops after you submit the password and you never see the new key: Try logging in with the new password first. If login succeeds, back up the recovery key again as described in Section 1.4. Do not delete files to reset the instance just because the response was lost.

### 1.3 Keep the three credentials separate

| Credential | Purpose | What not to do |
| --- | --- | --- |
| Login password | Routine merchant admin login and re-verification when changing a password or viewing a sensitive credential | Do not send it to customers' pages or use it as the store API credential |
| Recovery key | Set the initial password or reset a forgotten password | It cannot log in directly or serve as a Bearer credential for the business API |
| Independent API credential | Allows the store server to call UPayNow's business APIs | Do not give it to customer browsers, put it in frontend JavaScript, or use it as the login password |

The API credential is not limited to creating orders. It still has broad business-management permissions and must be kept as a sensitive server-side secret. Changing or resetting the password does not automatically rotate it. A password change does not secure an API credential that has already leaked.

### 1.4 Back up your recovery key again or view your API credential after login

**When to use:** You are logged in and want to save credentials again or prepare the API credential for a store integration.

**Before you start:** Have your current login password and a secure place to store the credentials.

**Where to click and what to enter:**

- To back up the recovery key, go to “Settings → Login Session → Back up recovery key”, enter your “Current password,” and click “Verify and view.”
- To view the store credential, go to “Settings → Separate API credentials → Verify password and view API credentials”, enter your “Current password,” and click “Verify and view.”
- In the dialog, use “Copy” or “Download backup”, then click “Close” after saving. The downloaded file contains sensitive plaintext. Do not leave it in a shared downloads folder or casually forward it.

**Wallet/Gas:** No wallet, transaction, or gas is required.

**What success looks like:** The dialog displays the selected current credential. Viewing, copying, and downloading do not rotate it. Closing the dialog clears temporary display on the page but does not clear the clipboard or delete a downloaded file.

**If something goes wrong:** If the current password is incorrect, re-enter it. If the session expired, log in again. If copying to the clipboard fails, select and save the key manually or download the backup. Do not submit it to an unfamiliar website just to copy it.

### 1.5 Prepare a desktop or mobile wallet

**When to use:** You are about to deploy a merchant contract or collect funds.

**Before you start:** Use a wallet you will control long-term and prepare the target network's native gas token. When creating the current same-address merchant contract, the signing wallet must match the fixed payout wallet you enter. Do not use an exchange deposit address you cannot sign for. Once you choose a payout wallet, the contract's collection destination cannot be changed.

Choose one of these three methods for your device. You do not need to configure them all.

| Method | Preparation and entry point | Reown Project ID required? |
| --- | --- | --- |
| Desktop browser wallet extension | Choose the browser wallet in the deployment or collection dialog, then authorize the account and network in the extension | No |
| WalletConnect | In “Settings → WalletConnect,” enter your own “Reown Project ID” and click “Save.” Then choose the WalletConnect connection in the relevant operation. | Yes, a 32-character hexadecimal Project ID you obtain yourself |
| Dedicated mobile deployment or collection entry | Create a mobile entry from the relevant task, open it where the mobile wallet can access the page, and review the current operation | No |

The WalletConnect card in Settings is optional. Not every merchant needs a Project ID. You can save one before configuring a chain. The dedicated mobile entry and the WalletConnect QR code use different mechanisms. See the deployment and collection sections for the respective mobile steps and buttons.

**Wallet/Gas:** Authorizing an account connection, switching networks, reviewing parameters, or opening a QR code does not send a transaction or complete deployment or collection. Only an on-chain transaction that you review and confirm for sending spends gas. Do not approve unrelated transfers or permissions.

**What success looks like:** The next operation's dialog can read the correct account and target network. If the wallet is on the wrong account or network, correct it before reviewing the parameters. Do not manually edit a pending transaction to bypass the page's checks.

**If something goes wrong:** If no extension is detected, check that your browser has a compatible EVM wallet. If WalletConnect reports a Project ID error, check the ID you saved. A connection timeout or cancellation does not mean a deployment or collection transaction was sent. If you already confirmed a transaction in the wallet, check the original task and wallet history. Do not infer that it is safe to resend from a connection error.

### 1.6 Which chain needs gas

The wallet that signs and sends the transaction pays gas, and the funds must be on the network where that transaction will execute. A balance of USDT or other payment tokens, or a same-named token on another chain, cannot pay gas on the current chain.

| Currently supported network | Chain ID | Native gas token |
| --- | --- | --- |
| BNB Smart Chain | 56 | BNB |
| Arbitrum One | 42161 | ETH on Arbitrum |
| Base | 8453 | ETH on Base |
| Plasma | 9745 | XPL |
| X Layer | 196 | OKB |
| BSC Testnet | 97 | Test BNB (tBNB) |
| Ethereum Sepolia | 11155111 | Sepolia test ETH |

Fund the wallet according to the transaction's gas estimate. Fees vary by network and operation. For wrong-chain asset recovery, prepare gas on the chain that actually holds the assets, not the original order chain. The network and gas list does not mean your merchant contract supports arbitrary tokens.

### 1.7 Understand the active deployment at the top

**When to use:** The same backend manages multiple chains, or multiple deployments on one chain, and you need to know which payment setup you are viewing.

**Before you start:** Have at least one verified merchant deployment. If you do not have one yet, complete Section 2 first.

**Where to click and what to enter:** Switch with the deployment selector at the top of the admin interface. Every deployment has its own network, payment contract, fixed payout wallet, token configuration, orders, and tasks. Check the current contract and deployment ID, not just the network name.

**Wallet/Gas:** Changing the active deployment in the admin interface does not connect or switch your on-chain assets, send a transaction, or spend gas.

**What success looks like:** The Overview, Orders, Collection, Payment notifications, and Store integration pages show the selected deployment's data. Switching does not stop other deployments from scanning, move old orders to a new contract, or change an existing contract's payout wallet.

**If something goes wrong:**

- Switching discards unsubmitted deployment-related drafts such as test order inputs. Make sure you no longer need the draft.
- A collection or recovery already started is tied to the original deployment. Changing the selector cannot change the pending transaction's destination. Complete or safely exit the operation first. If the outcome is unknown, keep working with the original task.
- If you cannot find an order, first verify the selected deployment. Do not immediately recreate the order.
- If loading fails, check the backend error first. Do not delete historical deployments, databases, or incomplete tasks to “fix” the list.

### 1.8 First-use checklist

- You set your own login password and can log in again.
- You saved the new recovery key generated at first-time setup and know that the old key is no longer valid.
- You can distinguish the password, recovery key, and API credential. The store credential stays on the server.
- You chose a wallet method, and no one asked you to upload a private key or recovery phrase.
- You know which gas token the target chain requires and that the active deployment only changes the admin viewing context.

Next: Add a network and deploy your merchant payment contract.

## 2. Add a Network and Deploy a Payment Contract

### 2.1 Distinguish an admitted network from adding your own deployment

- **Open a new network:** The project maintainers verify chain compatibility and its public deployment entry point, then add the chain to the list of admitted networks.
- **Add a merchant deployment:** On an admitted network, the merchant uses their own wallet to deploy a merchant contract tied to a fixed payout wallet and token list.

Ordinary merchants follow the second workflow. Adding an RPC does not open a new chain, and changing the Chain ID does not bypass the list. If the public entry point is not ready, contact the maintainer instead of signing a public entry-point transaction based on older technical documentation.

### 2.2 Select a network and enter merchant parameters

**When to use:** You are adding a payment network for the first time, or creating a separate deployment for a new payment configuration.

**Before you start:** Choose the fixed payout wallet you can control long-term and verify the exact token contract addresses (CAs) on the target chain. Fund that same payout wallet with the chain's native gas asset. New deployments use the cross-chain same-address scheme, which requires the signing wallet to match the fixed payout wallet.

**Where to click and what to enter:** Click “Add Chain” from the first-run setup. If you already have a deployment, open “Chains and contracts” and click “Add Chain”. Complete the form as follows:

| Field | What to enter |
| --- | --- |
| Network | Choose the target network from the “Select an available network” dropdown |
| Display name | Filled automatically with the network; you can replace it with a name you recognize |
| Chain ID | Filled automatically and read-only for new deployments; no manual input needed |
| Native gas symbol | Filled automatically and read-only; no manual input needed |
| RPC | Use the built-in preset. Expand “Advanced: Custom RPC (HTTPS)” only if you need a different endpoint |
| Fixed payout wallet | Enter a wallet address you will control long-term and can use to sign this transaction. It cannot be changed after deployment |
| Supported token contract addresses (one per line) | Verify each full CA against the target chain. Enter one per line, not symbols such as USDT |
| Payment confirmations | Defaults to 12; allowed range is 1–256. Review the network and business needs; a low confirmation count is not a safety guarantee |

Tokens with the same name usually have different CAs on different chains. Do not copy a USDT address from another chain, and do not enter the native gas asset's zero address as a regular supported payment token.

**Wallet signing and gas:** Selecting a network and filling out the form sends no transaction. A custom RPC must use HTTPS and must not embed a username and password. A node URL containing a key may appear in records; do not share screenshots of it indiscriminately.

**What success looks like:** The network parameters are filled automatically and the fixed wallet and token details are complete. You can click “Validate Parameters”.

**If something goes wrong:** If the admitted network list fails to load, new deployments are disabled. Close and retry or check the service connection; do not handcraft a request to bypass the check. If RPC validation fails, check that the preset node is reachable first and use advanced settings only if necessary.

### 2.3 Validate, review, and deploy with a desktop wallet

**When to use:** All parameters are complete and you are ready to deploy the merchant contract.

**Before you start:** Close other unfinished wallet sending flows. Confirm that your fixed payout wallet has target-chain gas.

**Where to click and what to enter:**

1. Click “Validate Parameters”. The backend reads on-chain data, verifies the entry point and configuration, and creates a deployment record. It does not send a transaction.
2. In “Review Deployment Parameters”, verify the network, fixed payout wallet, full supported token CAs, decimal precision, payment confirmations, and expected Factory address. Matching names do not prove the CAs are correct.
3. If anything is wrong, click “Back to Edit” and validate again after the change. Do not try to fix it by editing the transaction in your wallet.
4. Click “Next: Select Wallet”.
5. For a browser extension, click “Deploy Merchant Contract”. For WalletConnect, choose “WalletConnect” and authorize the wallet connection.
6. In “Review and confirm deployment”, verify the network, sending wallet, fixed wallet, supported tokens, and that the stage is “Deploy Merchant Contract”.
7. Click “Confirm and pass to wallet”. In the wallet, verify the contract call, network, account, and fee before approving the send.
8. Wait for the backend to receive the receipt, reach the required confirmations, and verify the contract.

**Wallet signing and gas:** Connecting the wallet does not send a transaction. Step 7 hands the deployment to the wallet for sending. The signer must be the fixed payout wallet, and that wallet pays target-chain gas. Your wallet may separately request that you add or switch networks; that is not a second deployment transaction.

**What success looks like:** The record shows “Deployment successful · Added”, and its details say “Deployment successful”. Click “Switch to This Deployment” and verify the actual Factory, fixed wallet, and supported tokens in “Chains and contracts.” A transaction hash or a wallet message saying “Sent” does not mean a usable deployment has been registered.

**If something goes wrong:**

- “This same-address merchant contract already exists. Verify it, then use Import Existing Contract.”: verify the existing contract and use the import workflow instead of redeploying it.
- The wallet account is not the payout: switch to the correct account instead of editing the pending transaction's sender to force it through.
- The entry point is unavailable or the public entry point is not ready: this is a network admission issue for maintainers, not a request to have the merchant sign another public infrastructure contract transaction.
- The wallet confirmed but the page timed out: check the original record as described in section 2.6 rather than restarting the add-chain process.

### 2.4 Confirm the deployment with a mobile wallet instead

**When to use:** You need to sign the same merchant deployment transaction in a mobile wallet rather than a desktop extension.

**Before you start:** Complete parameter review, make sure the mobile wallet contains the correct fixed payout account with target-chain gas, and confirm the phone can reach the HTTPS entry point.

**Where to click and what to enter:** In “Select a Wallet to Confirm Deployment”, select “Scan with Mobile Wallet”. When preparing temporary access for the first time, the program may automatically download and verify a required component from its official source. Let it finish; ordinary users do not need to install cloudflared manually first.

Once the entry is ready, open it in the mobile wallet's built-in browser and verify the network, fixed wallet, and supported tokens. Click “Connect wallet” and then “Confirm deployment (send once)”. Check and send the transaction in the wallet's own confirmation screen. On desktop, use “View Deployment History” to verify the result. The full entry link shown on the page grants temporary access; do not share it publicly.

**Wallet signing and gas:** Generating the QR code and opening the page sends no transaction. The signing wallet account pays gas for the transaction it confirms. No Reown Project ID is required.

**What success looks like:** As with desktop deployment, rely on backend verification and addition to the deployment list. Temporary access lasts at most five minutes; its countdown does not measure transaction confirmation.

**If something goes wrong:** Entry expiry or clicking “Close Access” does not cancel a transaction already confirmed by the wallet. Check the deployment record and original hash first. If only component download or startup failed and the transaction has not been handed off to the wallet, check the network and retry or choose a desktop wallet. Never bypass a component verification failure.

### 2.5 Import an existing compatible payment contract

**When to use:** A merchant contract already exists on the chain and needs to be registered in this instance, or the original deployment's management record needs to be restored.

**Before you start:** Have the actual network, original Factory address, original fixed payout, full supported token list in its on-chain order, and correct starting scan block. A similar name or ABI alone does not establish compatibility.

**Where to click and what to enter:**

1. Open “Add Chain” and expand “Advanced / Legacy Compatibility: Import Existing Contract”.
2. Check “Import Existing Payment Acceptance Contract”.
3. Under “Contract Version (Import Only)”, choose the actual version: the cross-chain same-address contract (deterministic-v2) or the legacy contract (legacy-v1, historical import only). Do not label a legacy contract as the newer version just to display recovery controls.
4. Verify the network and RPC, fixed payout wallet, and token list. Enter the “Existing Factory Address”. Imports support advanced custom network parameters but still require full on-chain verification.
5. In “Starting Scan Block (Optional)”, enter a valid block no later than the earliest payment event you need to recognize. The actual contract deployment block is usually the right starting point. A later block may miss past payments; an earlier block can make scanning take longer.
6. Click “Validate and Import”. Wait for registration and then verify the active deployment.

**Wallet signing and gas:** Import only reads and verifies an existing contract. It neither sends a deployment transaction nor requires deployment gas.

**What success looks like:** The instance shows that the deployment was imported and switches to it. Historical order records must still come from the original data backup. Importing a contract does not restore a lost order database.

**If something goes wrong:** If the version, fixed wallet, or token list does not match, check the actual on-chain records. Never edit the database to pass the checks. Network selection differs between fresh deployment and historical import. Being able to import on a network does not mean it is open for new deployments.

### 2.6 Deployment timeout, wallet rejection, or missing transaction hash

**When to use:** The window closed, connectivity dropped, the wallet explicitly rejected the request, or the record shows “Outcome unknown”.

**Before you start:** Keep the original deployment record ID and check the sending wallet for the original transaction. Do not create another record just to try sending again.

**Where to click and what to enter:** Open “Chains and contracts” → “Deployment History” and select the original record:

- **You have the original hash:** Click “Register original transaction hash”. Verify and enter the full hash, then click “Register and Verify”. Once a candidate hash is registered for the current deployment record, it cannot be freely replaced. Do not enter a customer payment hash or an unrelated transaction as a trial.
- **A hash is already registered:** Click “Refresh status” and wait for the receipt, required confirmations, and contract verification.
- **The wallet explicitly rejected the request and nothing was sent:** Only then select “Record Explicit Signature Rejection” and confirm in the dialog.
- **The record still says “Verified · Not sent”, and you know the request was not handed to the wallet:** Use “Continue Deployment” on the original record rather than creating a new one.

**Wallet signing and gas:** Registering a hash, refreshing, and registering a rejection do not send a new transaction or require gas. Reopening a truly unsent record still requires another review. Only the final send in the wallet uses gas.

**What success looks like:** The original record continues through verification to a definite result, preserving the full history.

**If something goes wrong:** A missing hash does not mean nothing was sent, and a timeout is not a rejection. If you registered the wrong deployment hash, do not delete the record. Find the actual creation transaction and contract information, verify them, and use the compatible contract import workflow; contact a maintainer if necessary. Once the transaction has definitively reverted on-chain, you can fix the problem and deploy again; do not treat an unknown result as a revert. A new-version deployment calls a public entry-point contract, so the wallet may label it a contract call, not “Create contract.” Find the original deployment call rather than looking only for a transaction with no recipient based on old instructions.

If the original mobile entry is still valid, no hash is known, and restrictions such as the original account are met, “Request wallet confirmation again” may appear. This explicitly opens another wallet prompt; it is not a read-only refresh and neither cancels the old prompt nor extends the entry deadline. First rule out a pending or already-sent original request. If you have the original hash, register it; do not approve both prompts.

### 2.7 Why you cannot edit the wallet or tokens directly

The fixed payout wallet and supported token list cannot be edited after they are written into the contract. Renaming a deployment in the dashboard also does not change the on-chain destination of funds.

With the current same-address scheme, the same chain, fixed payout wallet, and deployment version identify one merchant Factory. Changing only the token list cannot create a second contract for the same version. Deleting the dashboard record or clicking deploy repeatedly does not reset on-chain configuration.

If you need another configuration, plan a separate deployment first. For example, choose another fixed payout wallet you control and explicitly route new orders to the new deployment. Keep managing the old deployment and its historical orders. Do not repoint old orders' addresses, Factory, or payout destination to a new deployment.

**End-of-section checklist:** Select the correct network; confirm the normal workflow did not require manual RPC entry; verify that the merchant contract was checked and registered; review the fixed payout wallet, exact CAs, confirmation count, and deployment ID. Keep the original records of unknown deployment tasks for reconciliation.

### 2.8 Edit only the dashboard display name

**When to use:** Add an easy-to-recognize label to a registered deployment.

**Before you start:** Verify its network, Factory, and deployment ID so you do not edit another deployment with the same name.

**Where to click and what to enter:** In “Chains and contracts”, click “Edit Name” on the relevant deployment. Enter a “Display Name” in “Edit Deployment Name” and click “Save”. Names cannot be empty and may contain up to 128 characters. Duplicate names are permitted, so never substitute a name for the deployment ID.

**Wallet signing and gas:** This updates dashboard metadata only; it involves no wallet and no gas.

**What success looks like:** You see the “Name updated.” message, and the list and top selector update.

**If something goes wrong:** If saving fails, the original name is kept. Check the error and try again. Renaming does not change the chain contract, fixed payout wallet, token list, or historical orders; it is not a network migration.

## 3. Payments and order management

Recognizing payment, delivering a payment notification, fulfilling a store order, and collecting funds are four separate operations. Success in one does not mean that the others are complete.

### 3.1 Connect your store server first

**When to use:** On initial integration or when adding a payment option for another deployment.

**Before you start:** Verify the deployment and prepare the store backend and a public HTTPS origin for checkout. In “Current deployment” at the top, select the correct network and Factory. A chain can have multiple deployments; deploymentId is not the Chain ID. Open “Store integration” and record the current deploymentId, exact token contract address (CA), and decimals.

**Where to click and what to enter:** Go to “Settings → Separate API credentials”, click “Verify password and view API credentials”, enter your “Current password”, and click “Verify and view”. Give the credential to the person responsible for the store backend and store it in the server's secret configuration. Close the dialog to clear the displayed value. Do not put the credential in customer-facing web pages, apps, public repositories, or general logs. Do not substitute the login password or recovery key. The credential grants broad business-management permissions, not just the minimum permissions needed to create an order. Changing or resetting the password does not invalidate it.

The store server calls `POST /api/orders` and uses the independent API credential for Bearer authentication in the HTTP Authorization header. Specify the deployment ID in the `X-Upay-Deployment` header. Supply reference, token, amount, expiresInSeconds, and webhookUrl. Use a positive decimal string for amount, not a floating-point number or scientific notation, with no more decimal places than decimals. The expiry defaults to 1800 seconds and accepts 1–604800 seconds. Notifications are optional. To enable them, use your own HTTPS receiver and have the server operator add the exact domain to `UPAY_WEBHOOK_HOSTS`. Private-network targets and redirects are not accepted.

**Wallet/Gas:** Retrieving credentials and creating an order through the API require no merchant wallet signature or on-chain gas.

**What success looks like:** The API returns the actual order id, deploymentId, address, checkoutPath, and other fields. The store keeps those fields along with its merchant order number and the token. Production orders are created through the store API; the “Orders” page has no routine order-creation button. “Settings → Utilities” currently has “Create an Order Manually” for testing or making up a missing order. It is not a replacement for the store's production checkout and does not automatically reserve inventory.

**If something goes wrong:** reference is idempotent within a deployment. The original order is returned only if all parameters match, and different parameters cannot overwrite it. If a request times out, retry with the same reference and parameters or look up the order. Do not bypass an unknown outcome by using a new order number. If the deployment does not match, the CA is unsupported, or the notification domain is not allowed, correct the configuration before proceeding. Do not fabricate a successful order.

### 3.2 Give the customer the correct checkout link

**When to use:** The store has created an order and the customer is ready to transfer funds.

**Before you start:** Verify the amount due, deployment, chain, and CA and confirm the order has not expired. Combine the checkoutPath returned at order creation with the public origin. Do not construct your own link using the order UUID as the payment token. If you open the admin interface on a local address, the copied link may also use that address. Do not give remote customers a 127.0.0.1 link; use the configured public HTTPS entry point for production.

**Where to click and what to enter:** The store displays the checkout link to the customer. To help manually, open “Orders”, use “Search by order number or payment address”, click the order row, and copy the link under “Payment Information → Checkout Link”. The customer does not need to log in to the admin interface or connect a web wallet. They can scan the displayed QR code or click “Copy payment address”, then choose the same chain and CA in their own wallet or withdrawal interface and enter the destination and amount due. A matching network name or token symbol is no substitute for verifying the Chain ID and CA.

**Wallet/Gas:** The customer confirms the payment in their own wallet and pays the transfer fee. The merchant does not need to sign a collection transaction at this point. Allow time for possible exchange withdrawal delays before expiry.

**What success looks like:** Checkout displays the amount due, network/Chain ID, token contract, amount received, and confirmed amount, and automatically refreshes the status. If the amount is sufficient but confirmations are outstanding, it displays “Payment received, awaiting network confirmation”. Do not pay again.

**If something goes wrong:** A transfer of the wrong token or on the wrong chain does not count toward payment for this order. Review it manually; do not credit its dollar value. If the page says “Payment status may be delayed” or “Unable to refresh the status right now”, check sync and the original transaction before asking the customer to do anything. Do not ask them to pay again. If the link is not found, check the full link and deployment; do not send admin credentials as a workaround.

### 3.3 Look up orders, short payments, installments, and overpayments

**When to use:** Routine reconciliation, when a customer says they paid, or when the amount received differs from the order amount.

**Before you start:** Obtain the merchant order number, original transfer hash, and deployment. First check for “Synced” at the top. If sync is behind, there is an on-chain sync error, or the instance is offline, stale status is not sufficient grounds for fulfillment.

**Where to click and what to enter:** Open “Orders”. Select “All / Paid in full / In Progress / Needs Verification / Expired” and filter by token as needed. Click the order row and compare “Amount Due”, “Confirmed”, and “Detected (Including Unconfirmed)”. Inspect amounts, times, and transaction hashes in “Payment records.” “Advanced” shows the order ID, CA, webhook URL, and state version. If you cannot find the order, switch to its original deployment first.

**Wallet/Gas:** Order lookup requires neither a wallet nor gas. Do not collect funds just to verify payment.

**What success looks like:** The backend aggregates qualifying on-chain Transfer events using the order's original CA, block time, and confirmation count. Payment need not arrive in a single transfer:

- **Awaiting payment:** No qualifying funds have arrived.
- **Partially paid:** The total received within the validity period is short. Ask the customer to make up the difference before expiry using the same chain and token. Qualifying transfers of the same token from different senders are still aggregated at the order address.
- **Confirming:** The qualifying detected amount is sufficient, but the confirmed amount is not. Wait for confirmation rather than asking the customer to pay the full order again.
- **Paid in full / Paid in full · Overpaid:** The confirmed total meets or exceeds the amount due. Reconcile overpayments manually according to your refund policy. Collection takes the entire balance of that CA and does not automatically refund the difference.

**If something goes wrong:** If an order remains underpaid at expiry, it becomes “Expired”. A separate unaccepted late transfer can produce a “Received after expiry” notice, but paid-in-full or confirming status takes precedence. Do not use a single status label to decide whether late funds exist. Validity is based on the block time of receipt, not a screenshot or the time the customer clicked Send. A full payment received before expiry can still qualify if it is confirmed later. A zero balance after collection does not mean the order was unpaid; collection also does not prove it was paid in full. The store handles inventory, reservations, fulfillment, and refunds.

### 3.4 Accept a late payment only after explicit verification

**When to use:** Funds arrived after expiry and the customer still wants to complete the purchase.

**Before you start:** Confirm the original chain, CA, amount, and hash with the customer. The store must check and reserve inventory first. If out of stock, arrange a refund or alternative manually; UPayNow does not reserve stock or refund on your behalf.

**Where to click and what to enter:** The order details can show “Received after expiry”. The current order drawer has no “Accept late payment” button. The store backend must call `POST /api/orders/:id/accept-late-payment` with the original authentication, the exact deployment, and a body of exactly `{}`. The service first synchronizes and verifies. First-time acceptance requires an expired order, a confirmed late payment in the original CA, and a sufficient confirmed total in the original token. A partial payment received before expiry may be combined with a late top-up.

**Wallet/Gas:** Acceptance is a server ledger operation; it sends no on-chain transaction and costs no gas.

**What success looks like:** The response contains order details. Verify `paid === true`, `syncHealthy === true`, PAID/OVERPAID, `latePaymentAccepted: true`, and the acceptance record. It accepts only the current snapshot of confirmed transfers, not any future late transfer. The original token, amount, address, and expiry are unchanged.

**If something goes wrong:** The order cannot be forced to paid if sync has not caught up, the late payment is unconfirmed, or the total is insufficient. Do not treat a timeout as a definite failure and release inventory without checking. Retry the idempotent endpoint or look up the order. A chain reorganization that removes an accepted transfer can still reverse paid status. Repeating acceptance does not automatically approve replacement transfers. Unaccepted late funds may be collected manually, but collection does not constitute acceptance of the payment.

### 3.5 Retry notifications and fulfill safely

**When to use:** Payment succeeded but the store has not updated, or notification delivery failed.

**Before you start:** Store the deployment's `webhook.secret` without its trailing newline. Do not mix secrets across deployments. At the receiver, retain the raw request bytes, validate the timestamp format and time window, and verify HMAC-SHA256 over `timestamp + "." + raw body`. Compare `X-Upaynow-Signature` in constant time, check that `X-Upaynow-Event` matches the event ID in the body, and verify that the event type is one of the agreed types.

**Where to click and what to enter:** Open “Payment webhooks” and check the order, event, status, attempt count, and next attempt. The service automatically attempts delivery up to 8 times. Once the receiver is available again, click “Requeue” for a notification marked “Pending delivery” or “Delivery failed”.

**Wallet/Gas:** HTTP notifications and requeueing require no wallet or gas.

**What success looks like:** “Delivered” means only that the receiver returned 2xx, not that fulfillment occurred. The store should durably persist the event before returning 2xx, deduplicate by event ID, and use stateVersion to prevent stale updates from overwriting newer ones. Verify the merchant order number, deployment, chain, Factory, CA, and raw amount. If necessary, look up the order from the server and check that both paid and syncHealthy are true. Use a database transaction or unique constraint to make fulfillment idempotent at the order level.

**If something goes wrong:** Requeueing preserves the event ID, but the timestamp and signature can change. Do not fulfill twice. A chain reorganization can produce payment.reversed and later a new payment.paid. On reversal, stop outstanding fulfillment and reconcile manually; goods already sent are not automatically recalled. Do not treat “Voided” as a new pending event. Reconcile orders periodically from the server; do not rely only on callbacks or customer screenshots.

### 3.6 Use utilities for a test order or to make up a missing order

**When to use:** To verify your payment setup, or to create a missing order after reviewing the business circumstances. This is not the store's normal checkout flow.

**Before you start:** Select the correct deployment at the top and verify supported tokens. Use a testnet for your first dry run.

**Where to click and what to enter:** Go to “Settings → Utilities” and expand “Create an Order Manually”. Enter a “Merchant order number” (such as an unused TEST-0001) and “Amount,” then select a “Token” for the current deployment and an “Expiry” of 30 minutes, 1 hour, or 1 day. Click “Create Order”. Once created, the order details open; use Section 3.2 to open checkout. “Clear” clears only the current form; it does not delete previously created orders.

**Wallet/Gas:** Creating the order sends no on-chain transaction. If an actual wallet payment is made later, the payer needs gas on that chain. This tool does not pay automatically.

**What success looks like:** “Order created” appears. The order belongs to the deployment you selected and has its own payment address and checkout link.

**If something goes wrong:** Switching deployments before submitting invalidates the unsubmitted draft. Fill it out again for the new deployment rather than carrying over the previous token and amount. If creation times out, look up the same order number first and follow the original-parameter idempotency rules. Do not create duplicates by choosing another number. Utilities do not reserve store inventory or take over automatic fulfillment from the normal store flow.

## 4. Standard collection

Collection transfers the balance of a specified token from an order address to the deployment contract's fixed payout address. It does not recognize an order as paid, fulfill an order, or issue a refund. Standard collection is scoped to one chain and one deployment at a time. There is no cross-chain collection queue or one-click collection grouped by wallet.

### 4.1 Verify the scope and fees before collecting

**When to use:** You have received funds and want to move them to the fixed payout wallet.

**Before you start:** Under “Current deployment” at the top, select the correct network, Chain ID, and Factory, and verify the “Payout wallet”. Handle different Factories on the same chain separately. Switching deployments clears your prior selections. Check sync status at the top and investigate errors before proceeding; stale offline data is not a current balance. Prepare a compatible wallet with the chain's native token for gas. Holding the order token does not give you gas.

**Where to click and what to enter:** Open “Sweep” and look for the “Ready to Sweep / Recovery / Sweep History” tabs. The standard flow does not accept arbitrary payout addresses, change payout, or ask for a private key or recovery phrase. Select only the orders to collect and the sending wallet.

**Wallet/Gas:** The sending wallet pays gas in the chain's native token. The fixed payout wallet receives the funds and need not be the same wallet. The standard collection contract allows other accounts to call it and pay gas, but funds still go exclusively to the fixed payout. The payout wallet does not have to sign. Do not apply the deployment or wrong-chain recovery signature restrictions to this flow. The admin backend does not hold private keys.

**What success looks like:** The deployment, chain, and destination match the merchant records, the wallet is on the correct network, and it has enough gas. The collection call targets the Factory, while funds ultimately go to the fixed payout. It is normal for the two addresses to differ.

**If something goes wrong:** Stop before confirming and investigate if gas is unavailable, the network or account changes, the deployment is unverified, or sync is still catching up. Do not fund each order address with gas. The sending wallet pays the fee. Neither the mobile entry nor WalletConnect can change the destination.

### 4.2 Collect one order, selected orders, or all fully paid orders

**When to use:** To settle one order, reconcile several orders, or collect from all fully paid orders in the current deployment.

**Before you start:** Normally prioritize PAID/OVERPAID. Review overpayments, late payments, and customer disputes first. Collection neither refunds automatically nor limits the transfer to the amount due.

**Where to click and what to enter:** Choose one path:

1. **Single order:** In “Orders”, click the row, then “Sweep This Order” at the bottom of the details. The order must be paid in full, not shown as collected, and have no transaction in progress.
2. **Selected orders:** In the “Orders” list, check the boxes to the left and click “Sweep N Selected Orders”. Filter to “Paid in full” first and check each order. This is a manually selected scope; do not assume it automatically excludes all underpaid or late orders. Verify the final selection count after changing filters so hidden selections do not carry over into the batch.
3. **All fully paid orders:** Go to “Sweep → Ready to Sweep” and click “Check Orders Available to Sweep”. The backend first syncs and then reads live balances without sending a transaction. In the preview, compare “Merchant Order Number / Amount Due / Current Balance (All Will Be Swept)” and verify the fixed payout wallet. If more than 2 minutes have passed, click “Check Again”. After checking, click “Sweep These N Orders”.

All three paths open “Start Sweep”. Verify the network, destination, order count, and tokens, then choose a wallet method. To qualify for the all-fully-paid path, an order must have a sufficient confirmed payment, no active lock, and a nonzero current balance of its CA. A fully paid late order can qualify if explicitly accepted. Do not rely solely on the abbreviated “within the validity period” text shown in the interface. The backend checks again during preparation, and the preview count may differ from the final task count.

**Wallet/Gas:** Selecting, syncing, reviewing, and opening the dialog cost no on-chain gas. Transaction fees come into play after handing off to the wallet and broadcasting. “Confirm” here means approving this collection batch, not performing a separate ERC-20 approve transaction.

**What success looks like:** Preview balances match expectations, and the summary shows the correct deployment, batch scope, and fixed payout. Execution collects the entire current balance of the relevant token, including overpayments and transfers that arrived after the preview. The preview is a snapshot, not a locked transfer amount.

**If something goes wrong:** “No orders available to sweep” may mean payment is not yet confirmed, balances have already been collected, or unresolved tasks have locked the orders. Check the order and “Recovery” first. A failed balance read is not a zero balance. Underpayments and late payments require a manual business decision; do not use manually selected bulk collection to override payment recognition. Other supported tokens, wrong tokens or native coins, and wrong-chain recovery are separate exceptions and should not be mixed with standard collection.

### 4.3 Confirm with a desktop wallet

**When to use:** Using a local extension wallet or connecting a wallet with WalletConnect.

**Before you start:** Install an EIP-1193-compatible wallet extension for local wallet use. Only for WalletConnect, go to “Settings → WalletConnect → Reown Project ID,” enter your own 32-character hexadecimal project ID, and click “Save”. This field can be left blank; the local extension and dedicated mobile scan flow do not need it. Do not enter API credentials or a wallet private key here.

**Where to click and what to enter:** In “Start Sweep”, click “Local Browser Wallet” or “WalletConnect”. Connect the account and switch networks as needed. For WalletConnect, scan the connection dialog's code to authorize the connection. When “Review and confirm sweep” appears, verify the network, sending wallet, fixed payout wallet, Factory, order count, and record ID. Click “Confirm and pass to wallet”. In the wallet's transaction confirmation, verify the network, contract, and fee, and confirm sending once.

**Wallet/Gas:** The connected account pays gas. A transaction value of zero does not mean there is no fee. The wallet may prompt you to switch or add a network; always verify its Chain ID. Do not export a private key.

**What success looks like:** When the wallet returns a hash, the backend registers and verifies it. “Original transaction hash registered; waiting for on-chain verification” means verification is pending. Even if shown as on-chain, check “Sweep History” for per-order results.

**If something goes wrong:** Before confirming, you can click “Cancel”. After you start, a network interruption, closed dialog, or account change will not recall a sent transaction. If there is a preparation record but nothing was sent, verify it in the recovery view before canceling. If the outcome is unknown, do not send the entire batch again. Recover the original task as described in Section 4.6.

### 4.4 Scan and confirm with a mobile wallet

**When to use:** Selecting orders on a computer and using a mobile wallet to pay gas.

**Before you start:** Use a mobile wallet with a built-in browser and have gas on the current chain. The “Mobile Access” must be available in Settings. The default temporary mode opens for up to 5 minutes. A fixed HTTPS option is also available, depending on the instance settings; it does not grant permanent admin authorization.

**Where to click and what to enter:** In “Start Sweep”, click “Scan with Mobile Wallet” and wait for the temporary HTTPS entry and QR code. Scan using the mobile wallet's built-in browser. On the phone, verify “Network”, “Fund destination (fixed)”, “Gas”, and “Orders in this batch”. Click “Connect wallet → Review transaction → Confirm sweep and pay gas”, then confirm the transaction in the mobile wallet. Do not use the customer's checkout QR code for collection.

On the computer, click “Revoke Access” to revoke the ticket and shut the tunnel. “Collapse (Access Remains Open Until Expiry)” only hides the dialog; it does not revoke the ticket. The “Close Now” button under “Mobile Sweep Access” on the Sweep page shuts the current temporary tunnel but does not cancel a transaction already sent.

**Wallet/Gas:** The wallet connected on the phone pays gas in the chain's native token. The backend does not access private keys. The mobile collection QR code is not a WalletConnect pairing code and does not need a Reown Project ID.

**What success looks like:** The phone shows that the batch was submitted or that collection completed or partially failed. Refresh the computer to see the same task and original hash. Go back to “Sweep History” on the computer to verify each order. Entry expiry only invalidates entry; it does not mean the transaction failed.

**If something goes wrong:** If starting the mobile entry fails before sending starts, switch to the local wallet. Once wallet confirmation has started, check the original task first. The link or QR code grants temporary, batch-specific access: whoever holds it can view and attempt to execute that batch. Do not publicly share screenshots, complete links, or browser storage. It does not grant an admin login. On a shared device, revoke the entry before closing the tab. Do not rely on closing the page to revoke access. Revocation of this temporary access cannot recall already-downloaded calldata or a broadcast transaction.

### 4.5 Verify each result, not just that the batch is on-chain

**When to use:** The wallet has returned a hash or the backend shows the transaction is on-chain.

**Before you start:** Keep the deployment, task ID, hash, and a record of the orders in the batch.

**Where to click and what to enter:** In “Sweep → Sweep History”, find the batch, review “Result”, “Orders”, and “Transaction”, and expand “Per-order Results”. Then review “Sweep History” in the individual order details. An outer transaction that succeeded on-chain does not replace per-item checks.

**Wallet/Gas:** Checking is free. A reverted transaction can still cost gas; funds not moving does not mean there was no fee.

**What success looks like:** For “Recorded on-chain · All succeeded”, verify each Collected event and the actual funds received at the fixed payout. For tokens with transfer taxes or special logic, event amounts do not guarantee the wallet's net receipt. For “Recorded on-chain · Some failed”, find the CollectFailed orders and their reason codes. “Swept”, “Sweep failed”, and “Executed · No balance” mean different things. No balance does not mean the amount due was transferred in this attempt.

**If something goes wrong:** With partial failure, funds remain at the affected order addresses. Diagnose the issue, reread balances, and retry only the necessary items. Do not resend the entire batch as if none of it ran. Successful collection does not update inventory or mean the order was paid in full or the notification was delivered.

### 4.6 Signature rejection, UNKNOWN, and manual recovery

**When to use:** A hash does not arrive, the page disconnects, mobile entry expires, or RPC does not return a receipt for an extended period.

**Before you start:** Preserve the original task. Look for the original transaction in the sending wallet and the correct chain's block explorer. The backend persists UNKNOWN before handing off to the wallet. UNKNOWN proves neither failure nor broadcast.

**Where to click and what to enter:** In “Sweep → Recovery”, act on the evidence:

- **Original hash available:** Click “Register original transaction hash”, enter 0x followed by 64 hexadecimal characters, click “Register and Check”, then “Refresh status”. This registers the hash without resending. The backend verifies chain, sender, Factory, and calldata. If the original hash was stored locally, click “Retry registering original hash stored on this device”.
- **PREPARED, verified not started:** When available, click “Cancel Unsent Preparation Record”, then review again.
- **Wallet explicitly rejected and there is no hash:** When eligible, click “Record Explicit Signature Rejection” and confirm twice. A timeout or disconnect is not a rejection. The service still observes for about 64 blocks after registration and may detect a late original transaction.
- **“Request wallet confirmation again” on mobile:** This is an explicit way to resume the same approved task, not a guarantee of automatic retransmission. First rule out an outstanding confirmation in the original wallet or an existing transaction. If there is a hash, register it. Do not create another batch or confirm both old and new requests. A delayed hash can still arrive; retain all wallet evidence.
- **Automatic verification is impossible:** Use “Update Status Manually” only as a last resort. Choose “Manually Confirmed Successful”, “Manually Confirmed Failed / Not Executed”, or “Manual Resolution Only; Result Still Unverified”. Enter a justification of at least 4 characters, check the risk acknowledgment, and click “Confirm Change”

**Wallet/Gas:** Registration, refresh, and manual closure send no transaction and cost no gas. Requesting wallet confirmation again and confirming it can create a transaction and incur fees.

**What success looks like:** The original hash enters verification when registered; rely on the actual per-order receipts for the outcome. A manual result is explicitly labeled with a manual note, not as backend-verified on-chain success. The original record and hash are retained.

**If something goes wrong:** A manual result unlocks only the task's orders without changing payment status. In the current implementation, it also ends automated monitoring of that task, and automatic refresh does not overwrite the manual result. Do not assume every closure continues monitoring: rejection monitoring differs from a manual status change. If the original transaction still executes, sending again after unlock may waste gas. When the evidence is insufficient, leave UNKNOWN in place and reconcile. An unresolved task locks only the orders it involves; it does not require stopping the entire deployment or other chains.

## 5. Wrong-token and wrong-chain recovery

### 5.1 Locate the asset before choosing what to do

Recovery does not retroactively record a payment. A normal payment must use the order's specified chain, token contract address (CA), and order address, and must meet the amount, confirmation, and expiry rules. Successful collection does not mean the order was paid. Keep the original order, the customer's transaction hash, the actual Chain ID, the receiving address, the asset CA, the original amount, and a block explorer link. Do not ask the customer to send another payment to “activate recovery.”

Look up the transaction on the chain that actually received it, confirm that it succeeded, and verify the full receiving address. Then check the balance for the exact token CA or native asset at that address, and confirm the fixed payout wallet and target deployment. Token names, icons, wallet valuations, and customer screenshots do not establish that a CA is correct. Normal payment scans do not list every unsupported token or native transfer; an asset can exist on-chain even if the order page does not show it. Malicious tokens may also report false balances.

| What actually happened | Which action to use | Payment status and limits |
|---|---|---|
| Correct chain and order address, but the wrong token was sent | If the token is supported by this deployment, use “Sweep Other Supported Tokens”; otherwise use “Sweep Wrong Token / Native Token” | Does not change the order currency or combine different assets toward the amount due |
| Correct chain and order address, but a native asset such as ETH or BNB was sent | Enter the zero address in the wrong-token flow and collect manually | A native asset does not count as payment for an order that specified an ERC-20 |
| Wrong chain, but the address text matches the original order address | Use “Wrong-chain Recovery” only if the deterministic-v2 same-address requirements below are met | Upgrading the software does not grant v2 recovery to legacy deployments; success is not guaranteed |
| Entirely different address | UPayNow cannot take assets from an arbitrary address belonging to someone else; contact the party or platform that actually controls it | No universal recovery, transaction reversal, or destination change |
| Frozen, blacklisted, non-transferable, or malicious token | Its balance may be readable even if it cannot be transferred; check restrictions with the issuer first | UPayNow cannot unfreeze it; repeated attempts may only burn gas |

### 5.2 Wrong tokens, other supported tokens, and native assets on the correct chain

**When to use it →** The funds are at the original order address on the current deployment's chain. Recovery does not require marking the order as paid. Do not create another order in an attempt to get the same address.

**Prepare →** Sign in, select the correct deployment, and open the order details. Check the chain, order address, fixed payout wallet, and asset CA; look up the balance with a block explorer or trusted read-only tool. Check whether the asset is on the deployment's supported list, not just whether it is the order's payment token. If a collection task is already in progress for this order, reconcile the original transaction as described in section 6 first.

**Click / enter →** Expand “Advanced” in the order details:

- Supported token other than this order's payment token: click “Sweep Other Supported Tokens”, select the exact token under “Token”, and click “Next”.
- Unsupported token: click “Sweep Wrong Token / Native Token” and enter the full “Token Contract Address”. After verification, check “I confirm that I want to call this contract and understand that the balance it reports may not be trustworthy.”, then click “Next”.
- Native asset: use the same flow and enter `0x0000000000000000000000000000000000000000`, not the CA of a wrapped token. For wrapped tokens such as WETH, use their own contract address.

The “Sweep Wrong Token / Native Token” dialog does not have a “Check balance first” button. Verify the asset externally using a read-only tool; this dialog does not identify tokens for you. The backend requires explicit wrong-token confirmation. Assets on the supported list cannot go through the wrong-token contract call; go back and select the appropriate flow.

**Signing / gas →** In “Start Sweep”, choose “Scan with Mobile Wallet”, “Local Browser Wallet”, or “WalletConnect”. WalletConnect requires your own Reown Project ID. Verify the network and fixed payout wallet in the summary. The local flow then shows “Review and confirm sweep”; the wallet is prompted to send only after you click “Confirm and pass to wallet”. For mobile, explicitly confirm on the mobile page. Connecting an account, querying balances, and preparing a transaction do not transfer funds. The sending wallet pays gas in the chain's native asset; the order balance does not pay gas automatically. Preparation estimates gas but does not guarantee that the final transaction will succeed.

**Result →** The contract collects the entire transferable balance of the asset at execution time directly to the deployment's fixed payout. You cannot enter a customer refund address or specify a partial amount here. Check “Sweep → Sweep History”, the transaction receipt, and the amount actually received by the payout wallet. Fee-on-transfer tokens and malicious balance reports can make the event amount differ from the net amount received; do not settle accounts based only on the displayed amount. These manual actions neither change the original order's payment currency nor treat the wrong token as a successful payment.

**If something goes wrong →** Stop and recheck if the address format is wrong, a supported token was entered in the wrong-token flow, or a balance query or estimate fails. A native asset transfer may also fail if the payout address rejects it. If the mobile entry fails, you can use the local wallet instead. Closing a QR code, losing the network connection, or letting the entry expire cannot revoke an already-sent transaction. If the outcome is unknown, find the original hash before attempting another collection.

### 5.3 Wrong-chain, same-address recovery: all requirements must be met

1. Both the source and target must be registered and usable `deterministic-v2` deployments on different Chain IDs. Their payout, Factory, and deterministic deployer must match.
2. Keep and use the **original order orderHash**. Do not open a new order, substitute a UUID, or derive a new hash from the order number. The system compares the implementation contract and predicted order address on both chains against the order address saved on the source.
3. Both chains must use compatible pinned versions, compiled bytecode, and address derivation. The system verifies the official ERC-2470 entry point runtime, the pinned deployer, Factory and implementation bytecode and immutable fields, and the token registry. Adding an RPC, both chains being EVM networks, or seeing the same textual address is not proof. The chain must also support the current contract instructions.
4. **The target merchant deployment must be complete and verified.** A ready public entry point does not mean the merchant Factory has been deployed. If there is no matching target, first use “Chains and contracts” to complete a valid deployment or import. New merchant deployments are currently available only on admitted networks; ordinary merchants are not asked to broadcast the public entry point transaction manually to bypass that restriction.
5. There must be a transferable balance at the exact target-chain CA, and the token must not be frozen or block the transfer. The active wallet must actually control the target's fixed payout and be able to sign, with sufficient gas on the target chain. The same textual smart contract wallet address does not show that control is the same on another chain. Exchange deposit addresses are generally unsuitable for this mode; do not assume they are compatible.

Legacy orders do not get these guarantees. Existing Factory contracts cannot be upgraded. Creating a v2 deployment only affects new deployments and new orders; it cannot rewrite an old order's deployment to “upgrade” its recovery eligibility.

### 5.4 Use the “Wrong-chain Recovery” screen

**When to use it →** The asset was sent to the same address on the wrong chain, every condition above is met, and the source order record still exists.

**Prepare →** Open the original order details on the source deployment, confirm that the target deployment is registered, and have the target-chain CA ready. Use the zero address for the native asset. Make sure you have access to the target payout wallet and the network is available.

**Click / enter →** Click “Wrong-chain Recovery” at the bottom of the order details. When no target matches, the screen says “No Matching Deployment on the Target Chain”; it does not deploy automatically across chains. Under “Target Chain (Registered Same-address Deployment)”, choose the chain that actually received the asset, enter “Target Chain Asset CA (Zero Address for Native Token)”, then click “Read-only Query and Review”. Check the original order, target chain, matching order address, asset CA, balance, and fixed payout wallet. If decimals cannot be read, the balance is displayed in raw units; do not read it as ordinary human-readable units. The next wallet connection step appears only if the balance is greater than zero.

**Signing / gas →** Click “Connect Local Wallet and Review Recovery” or “WalletConnect”. The dedicated mobile QR flow is not supported for wrong-chain recovery. Use the target deployment's fixed payout wallet, verify the target chain and Factory, then click “Confirm and pass to wallet”. Explicitly approve in the wallet and pay target-chain gas. The process repeats its queries and checks and locks the original order and target deployment. Switching the managed deployment, wallet account, or network midway blocks sending; do not try to fix the network by switching it mid-flow. Close the flow and verify again.

**Result →** The funds stay on the **target chain** and are only collected into its fixed payout wallet. This does not bridge them back to the source chain, automatically refund the customer, create a new invoice, mark the source order as paid, or trigger its payment-success webhook. The merchant decides separately how to refund or apply a credit after reconciling the funds. Handle the customer's order fulfillment separately.

**If something goes wrong →** Do not force a transaction through a zero balance, deployment mismatch, failed bytecode or entry-point check, signer other than the payout account, insufficient gas, or token transfer rejection. If a previous attempt is UNKNOWN or already has a registered hash, switch to “Sweep → Recovery” on the **target deployment**, then register and refresh the original transaction. Do not recreate the task on the source deployment. Keep the task ID, original hash, target CA, and verification records for troubleshooting.

## 6. Troubleshooting and routine maintenance

### 6.1 The customer sent funds but the order is still unpaid

**When to use it →** The state is WAITING, PARTIAL, CONFIRMING, EXPIRED, or LATE_PAYMENT, or the customer's screenshot disagrees with the dashboard.

**Prepare →** Get the original order, real transaction hash, Chain ID, full receiving address, CA, amount, and time. Look at the actual transaction receipt, not just a wallet debit. Payment and collection have separate states: collecting the balance does not erase payment records, and leaving it uncollected does not prevent a valid payment from being confirmed.

**Click / enter →** Select the correct deployment and open the order details. Check the specified currency, amount, transfer records, validity period, and confirmations. If CONFIRMING, wait for confirmations; if PARTIAL, check for a shortfall. Transfers received after expiry do not automatically become normal payments. A confirmed late payment that meets the total amount due must be explicitly accepted by the merchant through the late-payment flow; collecting a wrong token cannot record it as paid. For the wrong chain or wrong token, see section 5. Do not edit the `paid` value in the database.

**Signing / gas →** Looking up orders, scanning, and checking payments require no wallet signature or gas. Do not use another payment as a troubleshooting step.

**Result →** The payment state changes only when qualifying transfers of the specified CA arrive on the specified chain, cover the amount due, and satisfy confirmation rules. A balance query is not a substitute for the payment ledger. Normal scanning only looks for Transfer logs within the deployment's supported-token list and cannot promise to identify all wrong tokens or native assets.

**If something goes wrong →** If the overview shows “On-chain sync issue”, the operator should check the chain's RPC, scan cursor against the latest block, latest sync, and error codes. An `ok` from `/health` only proves the process is alive, not that payment scanning works. A deep reorganization beyond retained checkpoints raises `DEEP_REORG_MANUAL_RESCAN_REQUIRED`. Preserve the data and have a maintainer plan a rescan; do not arbitrarily reset cursors, delete orders, or fabricate payment success.

### 6.2 Payment was confirmed, but the store did not receive a notification

**When to use it →** The dashboard marks the order paid but the store has not updated, or “Payment webhooks” shows pending or failed delivery.

**Prepare →** Confirm that a `webhookUrl` was set when creating the order. Find the deployment and event ID. Have the operator check the store's HTTPS, DNS, TLS, receiving route, exact host allowlist `UPAY_WEBHOOK_HOSTS`, and webhook signing secret for that deployment. Do not point a production webhook at a local address to bypass security checks.

**Click / enter →** Open “Payment webhooks” and check the order, event, number of attempts, and state. After fixing the receiving endpoint, click “Requeue” for a PENDING or FAILED entry. This keeps the original event ID and resets the retry counter; it does not mark delivery as successful. Delivered entries have no requeue button.

**Signing / gas →** The backend signs the HTTP webhook. No on-chain wallet or gas is needed. The store must use the deployment's `webhook.secret` to verify the timestamp and signature over the raw request body; it is not a login password, recovery key, or API credential.

**Result →** The record becomes FAILED after up to eight automatic delivery attempts. “Delivered” only means the store returned 2xx; it does not mean the order was fulfilled. The store should deduplicate by event ID, check order status, and fulfill idempotently. Reorganizations may produce a reversal and a new payment confirmation. Do not fulfill an order again for each notification.

**If something goes wrong →** A timeout can occur after the store has already processed the event, so a requeued event can arrive again. Do not delete the notification table, recreate events, or place replacement orders in bulk. Restoring an old backup can also deliver earlier events again; reconcile with the store first.

### 6.3 RPC, wallet disconnection, and UNKNOWN

**When to use it →** Sync errors, upstream errors, a wallet prompt with no result, or a collection marked UNKNOWN or SUBMITTED.

**Prepare →** Record the deployment ID, task ID, wallet account, network, original hash, and error code. Have the operator check HTTPS RPC reachability, rate limits, and the real Chain ID; renaming the network does not get it past verification. The interface does not provide a general repair button for rewriting any existing deployment's RPC live. The operator should repair the server configuration for the deployed version rather than editing SQLite directly.

**Click / enter →** Under “Sweep → Recovery”, click “Refresh status” first. If there is no hash, find the original transaction in the sending wallet or block explorer. Click “Register original transaction hash”, enter the full hash beginning with `0x`, and choose “Register and Check”. The backend checks the sender, Factory, calldata, and network; you cannot close a task with an arbitrary hash for an incoming payment. If the local browser still has pending registration data, use a recovery control that is actually shown, such as “Retry registering original hash stored on this device”. This registers a transaction; it does not resend it.

Use “Cancel Unsent Preparation Record” only while a task is PREPARED and has not been handed to the wallet. Use “Record Explicit Signature Rejection” only when the wallet explicitly rejected the request and you confirmed nothing was sent; complete both confirmations. The backend keeps watching for about 64 blocks. A timeout, connection loss, page closure, or temporary entry expiry is not evidence of a wallet rejection.

**Signing / gas →** Refreshing, registering, recording a rejection, and manually closing a task do not send a new transaction or require gas. They cannot undo a transaction that was signed or broadcast. Find the original transaction; do not sign again just to release a lock.

**Result →** Usually you wait for the backend to verify the original receipt. A successful batch transaction does not mean every item succeeded. Check “Per-order Results” in “Sweep History”, paying special attention to `CollectFailed` and the net amount received by the payout wallet. An UNKNOWN task locks only the orders it involves; there is no need to stop handling all other orders.

**If something goes wrong →** If RPC data remains unreliable, check the wallet, block explorer, and receipts yourself, then choose “Update Status Manually”. Select “Manually Confirmed Successful”, “Manually Confirmed Failed / Not Executed”, or “Manual Resolution Only; Result Still Unverified”. Provide at least four characters of evidence, acknowledge the risk, and click “Confirm Change”. This only records a manual outcome and unlocks the task. **It is not on-chain verification and does not change the order's payment state.** Automatic observation of this task stops; do not expect the software to correct a manual result later. Keep the hash, evidence, and history and use caution when deciding whether it is safe to try again.

### 6.4 Change or recover a password

**When to use it →** Routine password changes or inability to sign in. This does not recover wallet private keys.

**Prepare →** Have the current password or a valid recovery key for this instance ready. If the key was lost, verify the real data root as described in section 1.2. On macOS or Windows with a supported system clipboard, run `npm run recovery-key -- --copy "/path/to/actual/data-root"` from the project root. On a Linux server without a desktop clipboard, use `npm run recovery-key -- "/path/to/actual/data-root"` and read and store the output securely in a controlled terminal. Do not put plaintext in logs, screen recordings, or support tickets. Do not run the command against an unverified data directory.

**Click / enter →** If signed in, open “Settings” → “Change password”, enter the current password, new password, and confirmation, then click “Change password and log out”. If you forgot your password, choose “Forgot password” on the sign-in page, enter the existing recovery key, new password, and confirmation, and choose “Set password and generate a new recovery key”. New passwords must be 12–128 characters and cannot be entirely whitespace or directly reuse other credentials; leading and trailing spaces are preserved. Save the new recovery key, acknowledge that you saved it, and choose “Saved — back to password login”.

**Signing / gas →** No wallet signature or gas.

**Result →** Both changing and resetting the password invalidate all browser sessions and require signing in again. Only a reset also rotates the recovery key, immediately invalidating the old one. Neither action changes the independent API credential. For routine key backup, open “Settings” → “Back up recovery key”, re-enter the current password, and copy or download the key. This is not a complete data backup.

**If something goes wrong →** If a reset response was lost, first try signing in with the new password to retrieve the new key, or have the operator read it with the local tool. If you hit `AUTH_RATE_LIMIT`, stop repeated attempts. Preserve the environment if the authentication file is corrupted or storage fails. Do not delete `auth.json` to “restore sign-in”: it may generate a different identity and break the existing store credentials. Changing the password also does not remedy a leaked API credential.

### 6.5 Make a complete, consistent backup and restore it safely

There is no one-click backup or restore in the dashboard. An authorized operator performs these steps on the server.

**When to use it →** Routine backup, migration, preparation for an upgrade, or disaster recovery.

**Prepare →** Confirm the data root from the actual startup arguments and process environment. The program's `dir` option takes priority, followed by `UPAY_DATA_DIR`; the project path `backend/state` is used only if neither is set. Back up the entire data root, including `auth.json`, the root database, deployment registry, every `deployments/<uuid>/` directory, deployment databases, `webhook.secret`, other secrets, orders, scan checkpoints, webhooks, UNKNOWN tasks, and deployment tasks. Separately record the application version, dependency lockfile (`package-lock.json`), contract build artifacts and pinned-version manifest, and actual runtime environment configuration. `.env.example` is reference material only; editing a `.env` file does not automatically inject it into the service process.

**Click / enter (server operations) →** Prefer a maintenance window. Have the operator stop services normally, confirm all writers have stopped, and then take a full snapshot. Online backups must use a consistency mechanism such as SQLite backup and keep the root registry, all child databases, and authentication and secret files at compatible points in time. Copying live files one by one is not a consistent full-instance snapshot. SQLite uses WAL: do not take only `merchant.sqlite` while ignoring `-wal` or `-shm` files when transactions may still be pending. Do not manually delete those files to “repair” the instance. Encrypt backups, restrict access, record the time and version, and practice a restore in isolation.

**Signing / gas →** No on-chain signature or gas is required. Backups contain admin and notification secrets; protect them as sensitive, funds-related material.

**Result →** Before restoring, preserve the affected environment and current data. Restore the entire matching snapshot to a controlled directory, and check permissions, version, deployments, and which secrets belong to each deployment. Verify database integrity and records first in an isolated environment that does not send production store notifications. Keep the rehearsal copy away from production callback URLs and never share its data directory with the original instance. Before reconnecting to production, reconcile the time difference, original on-chain transactions, and orders already fulfilled by the store. Preserve the original Factory, payout, order hashes, and unknown tasks. Do not point old orders at a new contract.

**If something goes wrong →** `owner.lock` protects against simultaneous use; it is not junk. If you see `STATE_DIRECTORY_LOCKED`, check the holder process, PID, and real directory first. An operator should handle a leftover lock only after confirming a crash and that no writer remains. Do not delete authentication files, locks, or task tables to “clear” faults. A successful restore does not roll the wallet or blockchain back to the snapshot time; later on-chain transactions may already have taken effect.

### 6.6 Upgrades, rollback, migration, and support

**When to use it →** Updating the version, changing servers, or getting help with an issue you cannot resolve.

**Prepare →** Get the current release from an authorized, verified source. Do not overwrite production using a historical repository URL in an old install guide. Back up the code version, build outputs, dependency lockfile, complete state, and actual environment. Confirm compatibility of Node and SQLite, database formats, and pinned contract versions.

**Click / enter (server operations) →** The operator should arrange the switch using the instance's real process management setup. Test the new version on an isolated copy first. Do not “roll back” by opening a new-format production database directly with the old program. If necessary, restore a consistent pre-upgrade snapshot that matches the old version, then reconcile any intervening orders, transactions, or notifications. End writes from the old instance before migrating. Never let two instances write the same directory at once. Also avoid separate copies scanning the same business activity and sending duplicate notifications.

**Signing / gas →** Software maintenance does not require a wallet signature, and upgrading the software does not upgrade immutable on-chain contracts. If redeployment is needed, review it separately as an operation involving funds.

**Result →** After going live, verify every deployment's Factory and payout, order count, sync, notifications, and UNKNOWN tasks. Confirm store idempotency and the correct signing secret before resuming business. The operator is responsible for routine certificate renewal, disk space, protected backups, and restore drills.

**If something goes wrong →** If temporary mobile access fails, the current implementation first looks for an explicitly configured or system `cloudflared`. If none is present, it downloads the pinned version from the official release source and verifies it on demand on supported platforms. Preinstalling it is not a default requirement. Normal startup does not download it or open public access. Handle invalid configured paths, checksum or download failures, cache permissions, and unsupported platforms according to the reported error; do not disable verification. Fixed HTTPS does not need this component. When seeking help, share only the version, deployment ID, Chain ID, error codes, redacted logs, and necessary transaction hashes or CAs. Redact passwords, recovery keys, API credentials, cookies, webhook secrets, tokens embedded in RPC URLs, QR codes, and temporary entry links.

For help, see [feedback and contact](../README.en.md#feedback-and-contact) in the README. Report security issues privately first and do not publish sensitive data. Even public transaction hashes, addresses, and deployment information should be shared only when necessary to troubleshoot.

## Appendix: glossary

| Term | Meaning in this guide |
| --- | --- |
| Network / chain | The network where an asset actually resides. Tokens with the same name on different networks are not the same balance |
| Chain ID | Numeric identifier for an EVM network, not a merchant deployment ID |
| RPC | The node service UPayNow uses to communicate with a chain. Ordinary merchants use the preset for their selected network; advanced settings are for cases where a different node is needed |
| CA | Token contract address. Identify a token by verifying its network and full CA, not just its name or icon |
| Factory | Merchant payment contract that fixes the payout wallet and supported currency list, and manages the corresponding order payment addresses |
| payout | The contract's fixed ultimate payout wallet, not the per-order address a customer sends payment to |
| Deployment ID / deploymentId | Backend identifier for a specific merchant deployment. The store must use the correct deployment ID when creating an order, not its Chain ID |
| Order address | Payment address assigned to a specific order. Customers should pay the address shown at checkout, not send funds directly to a Factory or payout wallet |
| orderIdHash / orderHash | Original order identity hash used to derive the order address. It is not the customer's transaction hash, and it cannot be replaced arbitrarily for wrong-chain recovery |
| Transaction hash / txHash | Identifier of an on-chain transaction. Customer payments, merchant deployments, and collections are different transactions; do not mix their hashes when registering one for recovery |
| Gas | Fee paid by the wallet sending the transaction in the native asset of the chain where it actually runs |
| Webhook / payment notification | Signed HTTP notification from UPayNow to the store. Its secret is not an API credential, and successful delivery does not mean the order was fulfilled |
| UNKNOWN / unknown outcome | The original transaction's final outcome has not been determined. This is not failure and does not mean you can safely send again |
