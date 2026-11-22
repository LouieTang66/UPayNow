# Operating UPayNow

[简体中文](OPS.md) | **English**

## Start and stop the service

Use a dedicated service account, private persistent local storage, and one writer per data directory. Build the application and configure HTTPS using the [installation guide](INSTALLATION.en.md), then use a process supervisor. The [example systemd unit](examples/upaynow.service) is a template; adjust the paths, account, and environment file and verify it on a test host before installing it. Build new versions before switching them into service. Do not download dependencies or compile the application on every automatic restart. Stop older instances using the same state directory before adopting the new locking mechanism.

Automatic recovery requires a supported Linux local filesystem (ext, XFS, Btrfs, or tmpfs), system flock, and the same boot and PID namespace. Do not keep production state on tmpfs, which does not survive reboot. Verify legacy, previous-boot, or ambiguous locks manually. Never remove or replace the persistent `owner.guard` file.

Send SIGTERM and wait for the process to exit before servicing its data. For a restart loop, check the service log, free disk space, and state directory permissions. Do not delete a lock or start another copy when you cannot rule out a live writer. Automatic restart is not high availability. Do not let two instances process the same store orders.

## Monitoring and incident response

Monitor both external HTTPS reachability and merchant-side scan progress and payment notification queues. A successful public `/health` response shows that the process is reachable, not that it recognized payments or notified the store. Monitor process outages and certificate expiration externally; a stopped process cannot send its own alert.

An authenticated administrator can open `GET /api/ops/status` on the same origin as the admin console. It returns 200 if no issues are detected, 503 if degraded, and 401 without a session. It summarizes scanner and callback conditions by deployment. Do not issue a merchant API key to an external monitor for this endpoint.

The service checks every 15 seconds. It writes `upay.ops.alert` to standard error on a new issue and `upay.ops.clear` on recovery, without repeating the same active incident. Route standard error into journald or a local log monitor. Telegram, email, and other external destinations are not configured by default. Thresholds include no healthy scan in 60 seconds, a lag of at least 20 blocks, at least 25 pending callbacks, or a callback pending more than 120 seconds. A new instance without a configured deployment does not raise these alerts.

Prioritize persistent scanner errors or lag, long-pending callbacks, exhausted deliveries, and orders requiring manual reconciliation. For EPay, use the order reference to check the on-chain receipt, UPayNow, and New API records as described in the [integration guide](EPAY.en.md). If a customer has paid but their balance has not been credited, do not bulk resend callbacks or roll back one database to retry. Keep credentials, signatures, full callback URLs, and customer data out of monitoring and logs.

## Backups, recovery, and upgrades

Follow [Encrypt backups and verify restores offline](OPS-BACKUP.en.md). The tool runs during a quiescent maintenance window; it does not install a production schedule.

Back up the complete UPayNow state, including the root and per-deployment databases and settings. Do not copy a single SQLite file while it is being written. Back up the New API ledger, pinned release, and external deployment configuration separately. Encrypt backups and store decryption material separately. Periodically decrypt and check a copy in isolation. A restore drill must not use the active state directory or send real payment notifications.

Before restoring an older snapshot, pause new orders and reconcile payments, fulfillment, and notifications recorded since the snapshot. Confirm that no orders were missed before resuming. A process that starts successfully is not proof that the ledgers agree. See the [merchant operations guide](OPERATIONS.en.md).
