# UPayNow documentation

[简体中文](README.md) | **English**

Start with installation, then follow the relevant merchant workflow. The API and contract references are for integration developers and maintainers.

## Merchants and deployers

- [Installation and HTTPS deployment](INSTALLATION.en.md): prerequisites, persistent data, first start, the three access points, shutdown, and backups.
- [Merchant operations guide](OPERATIONS.en.md): first-time password setup, adding networks, deployments, orders, desktop and mobile collection, wrong-token and wrong-chain recovery, and maintenance.
- [Authentication](AUTHENTICATION.en.md): the login password, recovery key, separate API credential, and forgotten passwords.
- [Security boundaries and production checks](SECURITY.en.md): server and wallet protection, confirmations, unknown transactions, token limits, and consistent backups.
- [Feedback and contact](../README.en.md#feedback-and-contact): general questions, network requests, and commercial licensing. Report vulnerabilities privately as described in the [security reporting policy](../SECURITY.en.md).

## Store integration developers

- [EPay compatibility for New API](EPAY.en.md): enablement, gateway and callback configuration, sandbox verification, and reconciliation.
- [Store API, signature verification, retries, and late payments](../backend/README.en.md): create and look up orders, select deployments, process payment notifications, and explicitly accept late payments.
- [Frontend and service boundaries](../frontend-v2/INTEGRATION.en.md): public and admin pages, APIs, and the dedicated mobile entry points.
- [Frontend usage and development](../frontend-v2/README.en.md): pages, builds, and development checks.

Payment recognition, notification delivery, store fulfillment, and collection are separate states. Match orders against the correct deployment and on-chain payment record, verify notification signatures, and make fulfillment idempotent. A wallet screenshot, balance, HTTP 2xx response, or successful collection is not proof of fulfillment.

## Deployment and recovery reference

- [Multichain merchant deployments](../backend/MULTICHAIN.en.md): merchant configuration, deterministic deployment, legacy imports, and record verification.
- [Mobile collection and configuration](../backend/MOBILE-HANDOFF.en.md): temporary access, fixed HTTPS, sessions, and sending.
- [Collection handoff and job recovery](../backend/HANDOFF.en.md): restricted permissions, original transaction hashes, unknown outcomes, and separation between mobile and admin services.
- [cloudflared component](../backend/CLOUDFLARED.en.md): on-demand verified downloads, caching, and troubleshooting.
- [Same-address cross-chain deployment and recovery](CROSSCHAIN-V2.md): scheme versions, entry points, original order identity, target deployment, and fixed destination.
- [Multi-token contract interface](multi-ca-interface.en.md): token support, wrong-token balances, and per-item batch results. This is not a substitute for the merchant guide.

## Developers and network operators

- [Development and isolated checks](DEVELOPMENT.en.md): builds, focused tests, pinned release inputs, and what each kind of test does and does not verify.
- [Public deployment tool](../ops-public-deployer/README.en.md): preflight checks and public bootstrap before admitting a network. This is not a first-time merchant setup step.
- [Deterministic cross-chain development tests](../test/fixtures/CROSSCHAIN.en.md): isolated cross-chain test scenarios.

## Licensing and versions

- [Elastic License 2.0](../LICENSE): the project's chosen source-available license, not an OSI-approved open-source license.
- [License scope and outstanding checks](LICENSE_SCOPE.en.md): project-owned code, core contract identifiers, and authorization scope.
- [Third-party and build licensing notices](../THIRD_PARTY_NOTICES.en.md): third-party licenses and deterministic build notices.
- [Changelog](../CHANGELOG.en.md): repository changes, including unreleased work.
