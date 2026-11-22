# Encrypt backups and verify restores offline

[简体中文](OPS-BACKUP.md) | **English**

Run these commands on a supported Linux local filesystem with Node.js 22.19 or newer and util-linux `flock`. Start with a fresh test instance and synthetic data. These commands do not start or stop the application, connect to the network or a wallet, send callbacks, or perform production failover.

1. Identify the actual state root. Keep separate backups of the application version, deployment and environment settings, and the New API ledger.
2. Stop the application and every other writer, and keep them stopped for the entire backup. `--offline` confirms this prerequisite; it does not stop any process for you. The backup holds the root and deployment ownership locks until it finishes. It refuses existing locks rather than overriding them.
3. Use operator-owned, private directories (mode `0700`) outside the state tree for the archive, key, and restore scratch space. Do not use paths containing symbolic links.
4. Generate the key once. It is 32 random bytes, not a password. Keep it separate from the archive. Without it you cannot decrypt the backup.

```sh
npm run ops:backup -- keygen /private/key-store/upay.key
npm run ops:backup -- create --offline /absolute/test-state /private/archive/test.upaybak /private/key-store/upay.key
npm run ops:restore -- verify /private/archive/test.upaybak /private/key-store/upay.key /private/encrypted-scratch
```

The archive is authenticated and encrypted with AES-256-GCM and never overwrites an existing file. It includes the full state tree and any SQLite WAL and shared-memory files present, except for ownership locks, guards, and their temporary markers. Symbolic links, hard links, and special files are rejected, as are inputs exceeding 64 MiB, 10,000 entries, or 32 levels.

Both restore commands authenticate the archive before creating a new private scratch directory. They write **plaintext** there: use encrypted scratch storage. They check extracted bytes, run SQLite `quick_check` in read-only mode, and verify that registered deployment databases and authentication state are present. `verify` removes its scratch copy when it finishes; `extract` retains the copy in a fresh directory. A forced stop or power loss can leave private plaintext behind; inspect the scratch area after an interrupted run.

```sh
npm run ops:restore -- extract /private/archive/test.upaybak /private/key-store/upay.key /private/encrypted-scratch
```

Do not let a restore drill contact production RPCs, wallets, or callback endpoints. Production failover is a separate procedure: keep original writers offline, validate the matching version and deployment configuration, and reconcile payments and fulfillment recorded after the backup.
