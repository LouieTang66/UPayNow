# Standalone Public Contract Deployment Tool

[简体中文](README.md) | **English**

Directory: `ops-public-deployer/` in the project root. Run the commands below from the root of your checkout.

Only network operators should use this tool to predeploy the public root contract. Merchants do not need it to add a chain. See the [Merchant Guide](../docs/OPERATIONS.en.md) and [Multichain Deployment Guide](../backend/MULTICHAIN.en.md): merchants create v2 contracts on admitted networks and cannot bootstrap a missing public root through the regular admin console. The operator tool's advanced custom-chain support does not mean that a chain is admitted for merchant use.

```sh
# Run from the project root
npm ci                  # Skip if dependencies are already installed
npm run compile         # Verify and build the pinned release artifacts
node ops-public-deployer/server.cjs
```

Open **http://127.0.0.1:8807** (or use `PORT=8808 node ops-public-deployer/server.cjs` to set a different port). The tool listens only on localhost and neither modifies nor uses the regular backend data directory. No admin API key is required. Startup does not open a phone tunnel; clicking the QR deployment option opens the temporary tunnel. Do not expose the operator admin service to the public internet.

## Usage

1. Enter a custom positive integer Chain ID and an HTTPS RPC URL. The tool uses the same validation as the backend: no HTTP, username or password, or URL fragment; redirects are not followed. An RPC URL containing an API key is still visible in the local preview. Protect it accordingly.
2. Use the read-only preview to verify the RPC chain ID, official ERC-2470 runtime, and pinned public entrypoint runtime, and to view the bytecode hashes. The tool explicitly rejects a missing ERC-2470 deployment. It does not deploy ERC-2470 or automatically fund its deployment account.
3. If the correct public entrypoint already exists, no deployment is needed and the send button is disabled. An incorrect contract cannot be overwritten or bypassed.
4. Connect a browser extension wallet and switch to the target network. If the network is not already in the wallet, add it manually first. The tool needs no payout address, tokens, or private key; it neither signs nor broadcasts raw transactions via RPC. The backend reverifies the chain and code, uses ERC-2470 deployment calldata, applies the correct gas floor, and simulates with eth_call. The wallet account and chain ID are checked again before prompting for confirmation. The user's wallet pays gas.
5. The wallet's transaction hash is displayed as soon as it is available, and the tool immediately performs a read-only check of the chain ID and runtime. If the transaction is not yet included in a block, use read-only verification to query again; the tool never automatically resends a transaction. A successful check means the code matches on that RPC, not that the transaction is final. Verify the explorer transaction status, confirmations, and reorganization risk independently.

## Pinned Release Boundaries

- ERC-2470: `0xce0042B868300000d44A59004Da54A005ffdcf9f`
- Public root: `0x17F45EFf0a2cB4805180B62034F49c18d66e35EE`
- Release manifest: `../contracts/deterministic-v2-manifest.json`
- The tool reuses release, source, bytecode, and runtime verification from `backend/deterministic.cjs`. There is no configurable address, salt, or bytecode override. The API rejects all extra fields.
- The standalone admin service retains `/api/preview`, `/api/prepare`, and `/api/verify`, and adds the same-origin local endpoints `/api/phone`, `/api/phone/status`, and `/api/phone/close`. The mobile channel exposes only the endpoint for the current capability ticket and does not proxy the admin service. The regular backend rejects new bootstrap jobs even with an admin Bearer credential (403 `PUBLIC_BOOTSTRAP_OPS_ONLY`). Lookup, begin, refresh, attach, rejection, and mobile retry remain available for historical bootstrap jobs.
- New merchant jobs deploy only merchant contracts. A missing public entrypoint indicates that the network is not yet available. A custom address cannot bypass release validation.

## Unknown Outcomes and Limitations

Before invoking the wallet, the page saves a pending marker in browser localStorage. An existing marker blocks sending again, and the hash is also kept in that marker. After a refresh, reenter the original chain ID and RPC URL before running read-only verification. Explicit wallet rejection clears the marker; a timeout or connectivity loss does not clear it or retry. If the transaction definitively failed and the root was not deployed, first verify the wallet and on-chain records independently. Only then clear the corresponding `upay-ops-pending:` entry in browser developer tools and preview again. Pending markers are not shared across different browsers or RPC URLs; operators working concurrently must coordinate manually.

The tool supports browser extension wallets and **QR-code deployment on a phone**. Selecting the phone QR deployment option opens a dedicated temporary HTTPS tunnel on demand for five minutes. Scan with the wallet, connect, and confirm in the wallet's built-in browser. No Reown Project ID is required. The tool prefers an explicitly configured `cloudflared` binary or one on PATH. If absent, the tool downloads the pinned version from the official source and verifies its SHA256, so manual installation is not required by default. Use `UPAY_CLOUDFLARED` to set the path; an invalid explicit path does not fall back. See the [component guide](../backend/CLOUDFLARED.en.md) for component and cache rules. The phone can operate only on the fixed chain and public entrypoint for that job. It cannot call the admin API or change the RPC, bytecode, or payout wallet.

Mobile send status and hashes are persisted separately in `~/HermesData/upaynow-public-ops/` (configurable with `UPAY_OPS_DATA_DIR`), without using merchant backend data. Explicit rejection permits another confirmation prompt; an unknown result or known hash does not trigger an automatic resend. Closing or expiring the entry only closes the tunnel; it does not erase UNKNOWN. After expiry, run read-only verification on desktop and reconcile wallet records. A source update does not change an already open page; refresh the operator page.

The commands below are focused verification entrypoints. Code verification relies on the trusted RPC the operator selects. Cross-check with an independent RPC or block explorer before going live.

## Focused Tests (No Public RPC)

```sh
npm run build
node frontend-v2/test-public-live.mjs
node frontend-v2/test-deterministic-live.mjs
node --test backend/test/deployment-service.test.cjs backend/test/deployment-result-ack.test.cjs backend/test/crosschain-v2.test.cjs backend/test/ops-public-deployer.test.cjs
```
