# UPayNow Multi-CA Contract Interface (v3): One Address per Order

[简体中文](multi-ca-interface.md) | **English**

Repository: <https://github.com/LouieTang66/UPayNow>. This guide documents the current `ForwarderFactory` / `ForwarderImpl` source interfaces; it is not a UI design proposal. The v3 in the title means the multi-CA contract's `SALT_VERSION=3`, not the application's `deterministic-v2` deployment version. This guide is for developers integrating directly with contracts. Deployers should start with [Installation](INSTALLATION.en.md) and the [Operations Manual](OPERATIONS.en.md); stores should prefer the [Server API](../backend/README.en.md). No Factory, payout, or asset is preset. Interface examples do not replace actual deployment configuration. This guide does not establish mainnet acceptance or completion of a security audit.

## In Plain Language

A Factory takes the following at deployment:

```text
固定商户收款钱包
支持的 CA 列表，例如本链核实后的 USDT、USDC
```

That is, a fixed merchant payout wallet and a list of supported token contract addresses (CAs), such as the chain-specific addresses for USDT and USDC after verification.

Each order then gets a single payment address whether the customer chooses USDT or USDC. At collection, tell the Factory which token to collect for the order. That token goes directly to the fixed merchant wallet; other tokens stay put.

The contract does not set prices, look up USD exchange rates, add amounts across tokens, decide which token counts as payment, prevent a customer from sending a second token, or determine whether an order is paid in full. The merchant's backend still enforces the no-mixed-payment rule. If different tokens actually arrive on-chain, they can be collected separately without making the business payment valid.

## Allowlist Fixed at Deployment

```solidity
constructor(address payout_, address[] settlementTokens_)
```

- Payout cannot be the zero address, this Factory's address, an allowlisted token CA, or the implementation created by this Factory.
- The list cannot be empty or contain duplicates. Each entry must have code and cannot be the zero address or an ordinary wallet.
- Basic validation does not prove asset authenticity. Verify the exact chain ID, approved CA, and compatibility beforehand.
- The constructor sets the list. The contract offers no way to add, remove, or replace CAs later and has no admin or upgrade authority.
- A deployed Factory cannot add CAs, change payout, upgrade, or update existing orders. In deterministic-v2, the application allows only one Factory for the same chain, payout, and pinned version. Redeploying alone cannot add assets. A different payout can form a separate deployment identity. A new version needs a separate compatibility assessment. See the [Deployment Guide](../backend/MULTICHAIN.en.md).
- A Factory only works on its deployment chain and does not move assets across chains. Under strict conditions, deterministic-v2 can deploy a Factory at the same address on another chain and recover assets sent there by mistake. It is not bridging, automatic cross-chain collection, or recognition of the original order as paid. See [Cross-Chain Deterministic Deployment and Recovery](CROSSCHAIN-V2.md).

## Changes from Single-Token to Multi-Token

| Old single-token version | New multi-token version |
|---|---|
| Constructor `(payout, token)` | Constructor `(payout, [tokenA, tokenB, ...])` |
| `settlementToken()` | `getSettlementTokens()`, `isSupportedToken(token)` |
| `collect(orderHash)` | `collect(orderHash, token)` |
| `collectBatch([hashA, hashB])` | `collectBatch([{orderIdHash,token}, ...])` |
| `collectBatchItem(orderHash)` | `collectBatchItem(orderHash,token)`, still Factory-only |
| Collected without a CA | Collected with indexed token |
| CollectFailed without a CA | CollectFailed with indexed token |
| Order template fixes one token | Order template fixes only hub and payout; Factory validates the requested token |
| SALT_VERSION=2 | SALT_VERSION=3; address derivation does not include the selected token |

The argument shapes of `predictAddress(orderHash)`, `deploy(orderHash)`, and `collectWrongToken(orderHash,token)` are unchanged. They are functions on the new Factory. This does not mean an order has the same address across the old and new Factories or that the new ABI can control an old deployment.

## Factory Functions

### Queries: No On-Chain Gas for Read-Only Calls

```text
payout() -> address
getSettlementTokens() -> address[]
isSupportedToken(address token) -> bool
predictAddress(bytes32 orderIdHash) -> address
computeSalt(bytes32 orderIdHash) -> bytes32
SALT_VERSION() -> uint8，当前为3
implementation() -> address
forwarderCodehash() -> bytes32
isForwarder(address forwarder) -> bool
```

The current `SALT_VERSION()` is 3. `getSettlementTokens` returns the full deployment allowlist; there is no singular settlementToken getter. Do not identify tokens by symbol/name alone. Always store the chain ID and exact CA in the backend.

`predictAddress` takes only the order identifier, not a token. The calculation includes the version, order hash, and payout; CREATE2 also binds the Factory and implementation. For the same deployed Factory and hash, choosing a different token for collection does not change the address.

An order address can receive tokens before deployment. At that point, isForwarder=false or no code does not make the payment invalid. The backend should set up monitoring and backfill before displaying the address.

### Standard Write Operations

```text
deploy(bytes32 orderIdHash) -> address forwarder
collect(bytes32 orderIdHash,address token) -> uint256 amount
collectBatch(CollectRequest[] requests) -> uint256 succeeded,uint256 failed
collectWrongToken(bytes32 orderIdHash,address token) -> uint256 amountSent
```

`CollectRequest` is:

```solidity
struct CollectRequest {
    bytes32 orderIdHash;
    address token;
}
```

- collect accepts only allowlisted CAs and checks before deploying the order forwarder. An unsupported token cannot count as normal settlement.
- Each collect call sweeps the full current balance of the specified token only, without moving other supported or wrong tokens.
- An empty balance is a successful attempt but emits no Collected event. Repeating collection cannot transfer the old balance again.
- collectBatch isolates each (order, CA) item. Different CAs for one order and duplicate entries are allowed; this does not authorize mixed payment in the business layer.
- An empty batch reverts. No fixed batch size, per-item gas cap, or overall gas reserve is guaranteed. Simulate, leave gas headroom, split batches, and reconcile items individually.
- succeeded is not the number of paid orders. Empty and duplicate items can count as successes. Outer status=1 does not mean every item succeeded.
- collectWrongToken rejects every allowlisted CA, not just one. The zero address means native currency; other unsupported tokens use the manual path.
- All entrypoints send funds only to payout. Callers cannot specify a recipient.

### Internal Batch Entrypoint

```text
collectBatchItem(bytes32 orderIdHash,address token) -> uint256 amount
```

Only the Factory itself can call it. A direct call from the backend or deployer returns OnlySelf. It is not a public backend API.

## Order Forwarder Interface

```text
hub() -> address
payout() -> address
sweepSettlementToken(address token) -> uint256 amount
sweepWrongToken(address token) -> uint256 amount
receive()：接收原生币的特殊入口
```

`receive()` is the special entrypoint for native currency. The two sweep methods allow only the fixed hub, which is the Factory that created the implementation. The Factory validates the allowlist before choosing the standard or wrong-token path. The forwarder template neither stores nor changes the list. It has no initializer, redirection, administrator, arbitrary call, or upgrade interface.

The backend should trigger writes through the Factory, not call an order forwarder directly. Do not pay the Factory or implementation: there is no recovery entrypoint for funds accidentally sent there.

## Reconcile Events by Token CA

```solidity
event ForwarderDeployed(bytes32 indexed orderIdHash, address indexed forwarder);
event Collected(bytes32 indexed orderIdHash, address indexed forwarder, address indexed token, uint256 amount);
event CollectFailed(bytes32 indexed orderIdHash, address indexed forwarder, address indexed token, bytes4 reasonSelector, uint256 returnDataSize);
event WrongTokenCollected(bytes32 indexed orderIdHash, address indexed forwarder, address indexed token, uint256 amountSent);
```

The backend records the order, exact CA, token amount in smallest units, transaction hash, log index, and block details separately. Do not add USDT units to USDC units or derive a common USD amount from these events.

Collected.amount is only the amount requested for transfer. It does not guarantee an independently measured net receipt or prove payment in full. WrongTokenCollected must never serve as evidence of normal payment.

A failed single collection reverts the entire transaction and emits no CollectFailed. A failed batch item leaves a corresponding failure event only if the outer transaction ultimately succeeds. If the entire batch reverts, its logs are not retained.

If tokenA fails but tokenB succeeds on the same order, tokenB's deployment or registration of the forwarder can persist. Failure for tokenA does not imply that the address must have no code. Record failure by (order, CA, attempt).

## ethers Integration Example

This example is illustrative, without real configuration or secret keys. It is not a running production backend.

```js
// 业务订单映射必须保存；哈希规则固定且不重用。
const orderHash = ethers.id('upaynow:merchant-id:unique-order-id');
const address = await factory.predictAddress(orderHash);

// 商家后台开单时决定唯一认单币种与金额；当前收银台不切换订单币种。
// 等符合你的付款/确认策略后，只归集指定 CA。
const tx = await factory.collect(orderHash, USDT_CA);
const receipt = await tx.wait();
// 解析正确 Factory 的 Collected，核对 token/order/address。

// 同一 Factory 的批量输入：
const tx2 = await factory.collectBatch([
  { orderIdHash: ORDER_A, token: USDT_CA },
  { orderIdHash: ORDER_B, token: USDC_CA },
]);
const receipt2 = await tx2.wait();
// status=1 只代表外层成功，还要查逐项事件/结果。
```

Persist the business order mapping and keep hash rules fixed without reusing hashes. The backend sets the one accepted asset and amount at order creation; checkout does not change the order's asset. Collect only the specified CA once payment meets the confirmation policy. Parse Collected from the correct Factory and match token, order, and address. Use one Factory per batch and inspect each item's events or results even when status=1.

Two assets on the allowlist do not require both on each order. This change does not require the backend to add mixed-payment, swap, or foreign-exchange modules.

The SDK first returns a transaction object or hash. The receipt does not automatically contain the function's returned amount or counts. Simulation is only a preview; reconcile the receipt, events, and state on the valid chain.

## Backend Boundaries to Preserve

- Payment records come from Transfer events emitted by the exact token contract to the order address. Collection records come from the correct Factory's events or corresponding outgoing transfers. Keep them separate.
- Do not judge payment by current balance alone; a legitimate third party may have collected already.
- The contract does not decide installment payments, asset locking, underpayment, overpayment, or late payment rules. The current server fixes one recognized CA and amount at order creation and accumulates same-token transfers subject to confirmation rules. Other tokens cannot make up a shortfall. Explicit acceptance of a confirmed late-payment snapshot is available only through an authenticated admin API, with no UI button.
- The contract does not provide on-chain fields for mixed-payment prohibition, amount due, expiry, confirmations, payment success, or automatic refunds. None were added in this change.
- A fixed payout and allowlist do not stop a webpage from displaying an attacker's address. Protect deployment configuration and checkout.
- Standard collection checks pre-transfer balance once and uses SafeERC20. It does not restore balance-delta or zero-balance checks and does not support fee-on-transfer, rebasing, or dishonest tokens.
- The same token CA across chains does not identify the same asset configuration. Always bind it to chainId.

## ABI, Builds, and Licensing Boundaries

Integrate against the Factory/implementation ABI and canonical bytecode generated from the current source. Application updates do not upgrade an old single-token Factory. Do not assume that an old deployment supports the current ABI. For deployment or import, verify the real chain, canonical code, and immutable fields.

Use `npm run build` for builds. See [Development and Isolation Checks](DEVELOPMENT.en.md) for automated checks, not payment instructions. Local and fork tests cannot establish live network compatibility or a completed independent security audit. For other limits, see [Security](SECURITY.en.md).

The project has chosen ELv2 for its own material. The core contracts' original `UNLICENSED` label and pinned build inputs were not changed; their provenance and licensing coverage remain to be checked. See [License Scope](LICENSE_SCOPE.en.md). Third-party copyrights and licenses still apply. This interface guide is not a separate contract license.
