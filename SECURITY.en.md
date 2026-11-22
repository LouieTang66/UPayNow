# Reporting a security issue

[简体中文](SECURITY.md) | **English**

Please do not post exploitable vulnerabilities, real credentials, or complete instance backups in public GitHub issues. Contact us privately:

- Email: hi@louie66.com
- Telegram: @Louie_66

## What to include

- The version or commit, installation method, and affected page or endpoint.
- The impact, prerequisites, minimal steps to reproduce, and expected versus actual behavior.
- Redacted error codes or logs. If necessary, include a public on-chain transaction hash, chain ID, or contract address.
- Whether the original wallet request is still active, a transaction hash has already been recorded, or a job is in the UNKNOWN state.

Redact passwords, recovery keys, API credentials, notification secrets, cookies, wallet private keys and seed phrases, tokens embedded in RPC URLs, and mobile entry QR codes and full links. Do not upload these to public paste sites.

## If something goes wrong

Preserve the original order, deployment, job, and transaction evidence. Do not delete authentication files, clear the database, recreate the order identity, or retry a transaction just because it timed out. Changing the login password does not rotate the separate API credential. A credential leak and an abnormal wallet transaction must be addressed separately; a changed password does not resolve both risks.

Keeping signing keys off the server does not remove the need to protect the server, checkout, API, and notifications. See [security boundaries](docs/SECURITY.en.md) for production checks and the [merchant operations guide](docs/OPERATIONS.en.md) for procedures.

This policy does not promise a bug bounty, a fixed response time, or a third-party security audit.
