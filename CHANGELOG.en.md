# Changelog

[简体中文](CHANGELOG.md) | **English**

## 0.2.0 (unreleased)

### Features

- Add an opt-in EPay-compatible entry point, initially targeting the legacy MD5 top-up flow in New API. Existing on-chain payment matching, per-order addresses, and the native API remain unchanged. Orders must already be priced in USDT; there is no currency conversion.

### Fixes

- The backend continues to check the chain when a collection outcome is unknown and never resends automatically. Desktop and mobile distinguish orders awaiting verification from orders with no balance and allow unrelated orders to be collected.
- EPay stops sending callbacks at the attempt limit. If the final delivery outcome is unknown, the order moves to reconciliation. Admins can filter and page through orders, copy the merchant reference, and record their findings without changing funds or delivery state.

### Documentation

- Refresh the product README to describe source availability, self-hosted, non-custodial payments, one address per order, and supported networks.
- Add a complete merchant operations guide and documentation index covering first use, deployment and import, orders, desktop and mobile collection, wrong-token and wrong-chain recovery, and routine maintenance.
- Update installation, network presets, deterministic merchant deployment, authentication, and store integration. The standard workflow does not require entering an RPC URL or installing cloudflared in advance.
- Distinguish payment, notification delivery, fulfillment, and collection. Clarify how to handle UNKNOWN outcomes, explicit wallet rejection, manual resolution, and recovery on the target chain.
- Add the official Elastic License 2.0 text and third-party and build licensing notes. Retain existing third-party notices and deterministic build inputs.
- Add a private security reporting channel and GitHub issue templates.
- Add Chinese and English editions of the project documentation and link between them.
