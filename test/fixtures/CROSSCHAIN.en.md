# Local Cross-Chain Contract Acceptance Tests

[简体中文](CROSSCHAIN.md) | **English**

These are isolated test commands and scenario notes for maintainers, not mainnet deployment steps. The build commands write local inputs or artifacts; read [Development and Isolation Checks](../../docs/DEVELOPMENT.en.md) first.

```sh
npm run build:input
npm run compile
node test/crosschain.cjs
npx hardhat run --no-compile test/self-hosted.cjs
npm run test:compat
```

- Two independent Hardhat/EDR providers use chain IDs 31337 and 31338 under Cancun. No public RPC, fork, or live-network transaction is involved. Wallet nonces and on-chain token addresses differ between the chains.
- The raw transaction in `erc2470.json` comes from the official [ERC-2470 Deployment Transaction](https://eips.ethereum.org/EIPS/eip-2470#deployment-transaction). This repository includes the transaction fixture, so it does not depend on an untracked local backup. The test parses the transaction to recover the sender, hash, and address, extracts the `0x134`-byte runtime at offset `0x20` of the official initcode, and compares the runtime after broadcasting the actual raw transaction on both local chains. It neither uses setCode, recompiles a lookalike SingletonFactory, nor fabricates the official code.
- Funding the raw transaction occurs only in the in-memory test EVM. The test then executes singleton.deploy(rootInitCode, fixedSalt). The official function returns the zero address rather than reverting on failure, and gas estimation can accept an out-of-gas failure in the inner call. Supply sufficient gas and verify the target runtime after obtaining the receipt; receipt.status alone is insufficient.
- The root deployment salt is `keccak256(UTF8("upaynow:deterministic-deployer:v2"))`, matching the product's deterministic-v2 naming. Changes to the root bytecode, compiler configuration, or salt change the address and are not an upgrade.
- The Factory salt is `keccak256(abi.encode(keccak256(UTF8("upaynow.factory.create3.v1")), payout))`, with no chain ID, caller, or tokens. The proxy address derives from CREATE2 with fixed initcode. The Factory is the proxy's first CREATE (nonce 1).
- `DeterministicDeployer` has no constructor arguments. Its interfaces are `predictFactory(address payout) view returns(address)` and `deploy(address payout,address[] tokens) returns(address factory)`; its creation event is `FactoryDeployed(address indexed payout,address indexed factory)`. The payout itself must send the deployment transaction. A smart wallet must call from its wallet contract. Precisely the same tokens in the same order allow idempotent reuse; adding, removing, replacing, or reordering tokens is rejected. Compatibility with historical direct deployments is retained. This does not mean the regular merchant UI can still create a legacy deployment.
- `CrosschainPayout.sol` is a smart-wallet fixture for testing repeated calls. It is excluded from production compiler inputs. Impersonating the root address in the test only checks that the proxy refuses a second CREATE; it does not form part of any successful deployment or collection path.
- Factory and Impl use the source baseline from initial self-hosted snapshot `f041097efa20831c57df07a0678c6eeedc7d0814`. That historical object is not present in this repository's current Git history. Local tests verify compatibility using the pinned creation and runtime hashes in `test/crosschain.cjs`, without reading that historical Git object. The snapshot is a build baseline, not proof of original copyright or authorization. The order salt version remains 3. Identical cross-chain addresses are limited to the same new CREATE3 Factory, payout, and orderHash. The scheme does not migrate or preserve order addresses from an old Factory with a previously nondeterministic address.
- On chain B, before either the Factory or the order clone is deployed, the test pays the order address via an actual mock ERC20.transfer, then deploys and calls collect / collectWrongToken. Wrong-token collection does not establish payment. Both chains keep separate balances, transactions, and payment ledgers even when addresses have the same text.
- Legacy fund logic depends on EIP-1153. Only use target chains with support for Cancun transient storage. The negative Shanghai regression must fail at constructor TLOAD.
