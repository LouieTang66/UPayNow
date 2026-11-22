# Development and Isolation Checks

[简体中文](DEVELOPMENT.md) | **English**

This guide is for maintainers, not for merchant installation or payment. For first-time use, see [Installation](INSTALLATION.en.md) and the [Merchant Operations Manual](OPERATIONS.en.md). The current root `package.json` is authoritative for commands.

## Before Running Commands

- Use Node.js 22.19 or a newer compatible release with `node:sqlite`, and install dependencies from the lockfile.
- Use a separate disposable test directory and local test chain. Confirm that commands will not read a merchant's real data directory or access production services.
- Do not run tests or cleanup against live state. Do not automatically connect wallets, use private keys, broadcast transactions to public networks, or open public tunnels.
- Verify source code, compiler inputs, the manifest, the ABI, and deployed bytecode separately. Test output is not production acceptance.

## Application Build and Targeted Tests

```sh
npm ci
npm run build
npm run test:backend
npm run test:frontend-v2
```

`npm run build` validates and compiles contract inputs and builds the frontend. It does not just build documentation. `test:backend` automatically runs `pretest:backend` first (compilation and frontend build). Frontend tests have no equivalent prebuild hook, so build before testing. These commands install dependencies or write build artifacts; listing them here does not mean they have been run. For small changes, prefer the relevant test files rather than rerunning the entire suite for a wording change.

The root commands `npm test`, `npm run test:crosschain`, and `npm run test:compat` are also development checks. Consult each script for its coverage and isolation requirements; there is no guarantee that a given run will pass. See [Frontend Development](../frontend-v2/README.en.md) for browser script entry points.

## Deterministic Contracts and Cross-Chain Tests

See the [Local Cross-Chain Contract Acceptance Guide](../test/fixtures/CROSSCHAIN.en.md) for specific isolation scenarios and commands. `npm run build:input` rebuilds the exported source inputs. Do not use it as a shortcut to bypass compiler validation, change the first line of the Solidity source, or update the pinned manifest.

The compiler/settings, salt, source inputs, canonical bytecode, and addresses bound to the current release must stay consistent. Do not change these release inputs or artifacts without designing a new version and independently validating it. A successful build does not mean old addresses can be upgraded in place.

Fork tests may access an external RPC. Public-network or mobile tests may create external resources or produce transaction requests. None are ordinary offline test defaults. Verify the target, credentials, data directory, and authorization first. Do not execute a script merely because the documentation lists it.

## Reporting Results

State what was actually run, its coverage, what it returned, and what was not run. Static source review, in-memory chain tests, browser tests, physical wallet tests, production HTTPS, and settlement on a real network are distinct kinds of evidence and cannot substitute for one another.

Report static documentation checks separately from application builds. A build was rerun for this change, but this does not claim that the entire suite was rerun or that real funds recovery, mainnet, or physical-wallet acceptance was verified again.

## Licensing and Distribution

Follow the [License Scope](LICENSE_SCOPE.en.md) and [Third-Party Notices](../THIRD_PARTY_NOTICES.en.md). If you produce an npm package, frontend bundle, binary, or container, verify the licenses and notices actually shipped rather than assuming the source repository's files were included.
