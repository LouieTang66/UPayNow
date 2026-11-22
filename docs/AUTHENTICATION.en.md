# Passwords, Recovery Keys, and API Credentials

[简体中文](AUTHENTICATION.md) | **English**

These three credentials are independent:

- Password: Sign in to the administration console, change your password, and reauthenticate to view credentials.
- Recovery key: Set the initial password or reset a forgotten password. It cannot sign in or call business APIs.
- API credential: For store servers to call business APIs only. It cannot manage passwords or view credentials. It still grants broad business-management permissions, so keep it out of customer-facing pages and public repositories.

See [Installation](INSTALLATION.en.md) for first-time deployment, the [Operations Manual](OPERATIONS.en.md) for day-to-day setup, backups, and recovery, and the [Server API](../backend/README.en.md) for store integration.

## First-Time Setup

The service generates a random recovery key and a separate API credential for the instance and saves both in `auth.json` in the data directory. Setting the initial password requires proof of identity with the recovery key; the first visitor cannot claim the instance.

The deployer can explicitly retrieve the key from the project root. Use `UPAY_DATA_DIR` or specify the data directory on the command line:

```sh
npm run recovery-key -- /实际数据根目录
# macOS/Windows 直接复制到剪贴板，不显示明文：
npm run recovery-key -- --copy /实际数据根目录
```

On macOS and Windows, `--copy` copies to the clipboard without displaying the plaintext. The tool only reads local files; it does not change passwords or create credentials. Do not share plaintext output in chats or logs.

Open the administration console. Set and confirm your password (12–128 characters; spaces are preserved, but the password cannot consist entirely of whitespace). Save the new recovery key shown in the interface, then sign in with your password. Initial setup uses `POST /api/auth/reset`, which also rotates the recovery key. The original key is no longer valid afterward. Do not use either the recovery key or the API credential as your password.

## Changing and Resetting Your Password

Changing your password in Settings requires the current password. If you forget it, enter the recovery key and a new password on the sign-in page. Both operations sign out all sessions. A password change keeps the current recovery key; a reset generates a new one, which you must save. Neither operation affects the API credential.

In Settings, reauthenticate with your password to view, copy, or download the recovery key and API credential. The interface clears the values when closed. If a reset response is lost, try signing in with the new password to retrieve the recovery key, or have the deployer use the local tool above. Do not delete the authentication file to bypass verification.

An incorrect current password during reauthentication returns 401 `UNAUTHORIZED`; the existing session remains valid, and you can retry in the same dialog. A 401 `SESSION_REQUIRED` means you must sign in again. Sign-in, initial setup/reset, password changes, and credential viewing share an authentication rate limit by connection address: at most 10 attempts in 5 minutes. Exceeding it returns 429 `AUTH_RATE_LIMIT`, not `LOGIN_RATE_LIMIT` from the old frontend dictionary. Successful requests also count. Avoid repeated retries; concurrent load may return 503 `AUTH_BUSY`.

## Storage

`auth.json` stores a salted scrypt password record and both keys, but no plaintext password. It uses file mode 0600 and atomic replacement on updates. The service refuses to start with a corrupt authentication file and does not regenerate it automatically.

Sessions use an HttpOnly, SameSite=Strict cookie with Secure enabled on HTTPS. Sessions last eight hours, and a restart requires signing in again. Same-origin and Host checks, rate limiting, and concurrency checks remain in effect. The browser does not store passwords or keys in URLs, localStorage, or sessionStorage.

Back up the authentication file, database, deployment state, and task state together, and protect the backups as sensitive data.
