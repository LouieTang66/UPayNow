# UPayNow pages, services, and authentication boundaries

[简体中文](INTEGRATION.md) | **English**

## Startup and routing

Run `npm ci && npm start` from the project root. A fresh instance has no registered deployment, Factory, payout, tokens, or orders. Sign in and add your deployment on a built-in admitted network. A network preset is not an existing merchant contract. Run `npm run build` to generate `frontend-v2/dist`. The respective backend services serve the console and public pages; a separate frontend server is unnecessary.

| Service | Route | Supported alias |
|---|---|---|
| Admin service | `/` | `/v2/` |
| Customer checkout (admin service) | `/pay/:token` | `/v2/pay/:token` |
| Dedicated mobile deployment service | `/d/:id#capability` | `/v2/d/:id#capability` |
| Dedicated mobile collection service | `/c/:id#capability` | `/v2/c/:id#capability` |

By default all three services listen on loopback only, on ports 8790, 8792, and 8791 for administration, deployment, and collection respectively. See the [installation guide](../docs/INSTALLATION.en.md) for fixed HTTPS origins and proxy configuration and the [merchant operations guide](../docs/OPERATIONS.en.md) for administration and recovery. A full mobile link must point to its dedicated service. Do not paste its path into the admin service or proxy a mobile domain to the admin port.

Static resources are under `/v2/assets/`. Each service exposes only the bundle and CSS needed for its role. Do not expose source code, source maps, databases, secrets, or runtime directories. Neither `/legacy/` nor the old static UI is a product entry point. Existing `/pay/`, `/d/`, and `/c/` routes do not require recreating orders or contracts.

## Admin sessions and store API

Prove ownership with the recovery key to set the first password. `GET /api/auth/status` exposes whether a password is set and its minimum length, not credentials. `POST /api/login` accepts the login password only and sets an HttpOnly, SameSite=Strict session cookie with Secure on HTTPS. `POST /api/auth/reset` handles initial password setup and password resets, rotates the recovery key, and signs out all sessions; it does not sign you in. Save the new recovery key returned at first setup too. Browser writes must be same-origin. The Host, Origin, and service role must agree. Do not add a CORS bypass.

The frontend does not persist the password, recovery key, or API credential. Admin requests authenticate with a cookie and are scoped to the deployment by `X-Upay-Deployment`; all `auth/*` routes are global and do not use that header. Clear stale sessions and in-flight UI state after changing the password or using recovery. The store server uses a separate Bearer API credential. It cannot be used for password or credential management and must not be given to customer browsers. See [API integration](../backend/README.en.md) and [authentication](../docs/AUTHENTICATION.en.md).

Changing a password does not rotate the recovery key. Neither changing nor resetting the password rotates the API credential. When viewing the credential or changing the password, an incorrect current password returns 401 `UNAUTHORIZED` without clearing a valid session. Only `SESSION_REQUIRED` denotes an invalid session. Authentication rate limiting returns 429 `AUTH_RATE_LIMIT`; do not integrate against the old frontend's `LOGIN_RATE_LIMIT`.

After creating an order, the production store API supplies the `/pay/:token` checkout. Settings also provides a utility for test or replacement orders. Accepting late payments requires the authenticated admin API and has no UI button. Treat payment recognition, a 2xx notification response, store fulfillment, and collection results as separate events.

## Mobile capabilities and recovery

A mobile service accepts only the short-lived capability for the currently approved action; it gains no admin role. The fragment can be moved into sessionStorage for the current tab and removed from the URL bar. Reload recovery remains subject to server expiry and revocation. Do not publicly share QR codes, full links, or stored data.

The service persists UNKNOWN before submission and registers the original transaction hash for verification when the wallet returns it. Timeouts, reloads, disconnections, and closed tunnels do not prove the transaction was not broadcast. Do not resend automatically. Registering the original hash, explicit wallet rejection, and accepting risk through manual closure are distinct actions. Manually calling `resolve` stops automatic observation of that wallet job; a manual outcome does not verify an on-chain receipt. Deployment, collection, and order payment states are independent. See [recovery boundaries](../backend/HANDOFF.en.md).

## Data and version boundaries

Rebuilding or replacing pages should not delete state, secrets, historical deployments, orders, or transaction hashes. It does not upgrade immutable on-chain contracts. Deployers handle backups, updates, proxies, and process supervision. No built-in operations service has been added, and two processes must not share one data directory.

Verify physical wallets, the WalletConnect relay, mobile wallet browsers, EIP-681, target chains, and real HTTPS independently. Frontend improvements do not remove outstanding backend concerns involving candidate transaction hashes, RPC secrets, deploymentId conflicts, or crash recovery. See the [security guide](../docs/SECURITY.en.md); these issues are not claimed fixed.

## Automated development checks

`npm run test:frontend-v2`, `npm run test:backend`, and `npm test` exercise the frontend, backend, and contracts, respectively. Use isolated data. These checks are not top-up or payment steps, and do not replace acceptance testing with physical phones, production TLS, mainnet, or an independent audit.
