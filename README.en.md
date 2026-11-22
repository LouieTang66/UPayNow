<div align="center">

<img src="frontend-v2/brand/upaynow-b-coin.svg" width="104" height="104" alt="UPayNow Logo">

<h1>UPayNow</h1>

<p><a href="README.md">简体中文</a> | <strong>English</strong></p>

<p><strong>Source-available · Self-hosted · Non-custodial crypto payment gateway</strong></p>

<p>
Accept token payments across multiple EVM chains, with a unique address for every order.<br>
Your server does not store wallet private keys. Contract deployments and fund collection require approval from your own wallet.
</p>

<p>
<a href="#quick-start">Quick start</a> ·
<a href="docs/INSTALLATION.md">Installation</a> ·
<a href="docs/OPERATIONS.md">Merchant guide</a> ·
<a href="backend/README.md">API integration</a> ·
<a href="docs/SECURITY.md">Security</a>
</p>

</div>

## Why UPayNow?

### Keep signing keys off your server

Unlike systems that require a server-held hot wallet for automatic signing, UPayNow asks your external wallet to approve contract deployments and fund collection. The server manages orders and detects payments; it does not hold your signing private keys.

### One address per order, simpler payments

Each order has its own payment address. Customers do not need to submit a transaction hash or use an amount with a special identifying suffix. They transfer the order amount, and the system detects the payment automatically.

### The collection destination is fixed by the contract

A deployed contract's collection destination cannot be changed, and a caller cannot substitute another address when collecting funds. The destination is not merely an editable field in the dashboard configuration.

### Accept payments for your business without running a payment platform

Manage multiple supported EVM chains from one merchant dashboard and integrate with your existing store through the API. There is no need to build a multi-merchant registration, fund-splitting, or settlement system first.

## Payment flow

1. **The store creates an order**  
   The store creates a payment order through the API. UPayNow returns a dedicated payment address and checkout page.

2. **The customer pays**  
   The customer transfers the specified token and amount on the network shown at checkout. No transaction-hash submission is required.

3. **The system confirms and notifies**  
   UPayNow detects the on-chain payment, verifies the amount, waits for the required confirmations, and sends a signed payment notification to the store. The store verifies the notification before fulfilling the order.

4. **The merchant collects funds when needed**  
   The merchant can collect from a single order or in batches. Their own wallet approves the transaction and pays the network Gas fee, transferring funds to the payout wallet fixed by the contract.

```text
Create order → Pay → Confirm on-chain → Notify store → Fulfill order
                            │
              Funds remain at the order address
                            ↓
          Merchant approves collection when needed
                            ↓
                    Fixed payout wallet
```

Payment confirmation and fund collection are independent. The store can process confirmed orders without waiting for collection to finish.

## EPay compatibility

UPayNow offers an opt-in EPay-compatible entry point for USDT checkout while retaining one address per order. Prices must already be denominated in USDT; the adapter does not convert currencies. The current target is the New API top-up flow in legacy MD5 mode; this does not add Alipay, WeChat Pay, or universal EPay compatibility. See the [EPay setup guide](docs/EPAY.md).

## Quick start

### 1. Install and start

Install Node.js 22.19 or a later compatible version, along with npm. Obtain the source and run these commands from the project root:

```bash
npm ci
npm start
```

The default administration URL is `http://127.0.0.1:8790`. On first startup, use the instance-generated recovery key to set your administrator password. Use that password for subsequent logins.

### 2. Configure a payment network

Open **链与合约** (chains and contracts), click **添加链** (add chain), and select an available network. RPC, Chain ID, and the native Gas token symbol are filled in automatically; you do not need to enter them manually. Enter your fixed payout wallet and the exact token contract addresses, then review the required payment confirmations. Custom RPC configuration is optional and available in advanced settings.

Use the fixed payout wallet to approve deployment of the merchant contracts and pay the network Gas fee. The shared deployment entrypoint is prepared by the maintainer; merchants do not need to deploy it separately. You may also import existing contracts that have been verified as compatible with the current version.

### 3. Integrate your store

Use separate API credentials to create payment orders, direct customers to the checkout page, and configure a payment-notification URL. The store should verify notification signatures before fulfilling orders.

### 4. Verify your first payment

Test the complete order creation, payment, notification, and collection flow on a testnet before connecting production business operations.

Before production deployment, follow [Installation and HTTPS deployment](docs/INSTALLATION.md) to configure persistent data storage and access. See the [Merchant guide](docs/OPERATIONS.md) for step-by-step instructions, [Authentication](docs/AUTHENTICATION.md) for password setup and recovery, and the [API documentation](backend/README.md) for store integration. Other technical guides are listed in the [Documentation index](docs/README.md). These detailed guides are currently in Chinese.

## Supported networks and network requests

The following networks are currently available in UPayNow:

| Network | Gas token | Type |
| --- | --- | --- |
| BNB Smart Chain | BNB | Mainnet |
| Arbitrum One | ETH | Mainnet |
| Base | ETH | Mainnet |
| Plasma | XPL | Mainnet |
| X Layer | OKB | Mainnet |
| BSC Testnet | tBNB | Testnet |
| Ethereum Sepolia | ETH | Testnet |

### Candidate networks

The following networks are candidates for future support. UPayNow compatibility verification and enablement have not been completed for them:

- Ethereum Mainnet
- OP Mainnet (Optimism)
- Polygon PoS
- Avalanche C-Chain
- Linea
- Scroll

Support for other EVM networks can also be requested and must be confirmed individually. Non-EVM networks such as Tron and Solana are outside the scope of this type of network expansion.

**Address: 0x90995627e0c94e4b81dA4B2A377eAe4455FD7887**  
**Contact: email: hi@louie66.com Telegram: @Louie_66**

If you need a compatible network that is not yet available, contact me to request support. Once compatibility has been confirmed, you can send a small amount of the target network's native Gas token to the donation address above and provide the network name and transaction hash. I will manually complete the adaptation and enable the network.

## Security and backups

### Keep control of your wallet private keys

UPayNow does not require you to upload wallet private keys or seed phrases. Contract deployment and fund collection are approved through your own wallet. Keep your wallet and its backups secure.

### Separate administration credentials from wallet private keys

The administrator password is used to sign in to the dashboard. The recovery key is used for initial password setup or password resets. Separate API credentials are used for store integration. Do not expose these credentials in customer-facing pages, public repositories, or screenshots.

### Back up the complete instance

Regularly make consistent backups of the full data directory and runtime configuration, including authentication files, per-chain deployment records, orders, and task data. Store backups outside the server.

The recovery key is not a substitute for business-data backups. Copying a single database file while it is being written is not a complete backup either.

### Protect the server and checkout pages

Keeping wallet private keys off the server does not eliminate the need for server security. Configure HTTPS, restrict access to the administration interface, and protect checkout pages against payment-address tampering.

See [Security](docs/SECURITY.md) for deployment requirements and security boundaries.

## Feedback and contact

- **Bugs and usage questions:** Open a [GitHub Issue](https://github.com/LouieTang66/UPayNow/issues) with the version, target network, reproduction steps, and redacted errors or screenshots.
- **Security vulnerabilities:** Report them privately through the contact details below. Avoid publishing exploitable details.
- **Network requests and commercial licensing:** Contact the author to discuss your needs.

**Contact: email: hi@louie66.com Telegram: @Louie_66**

## Support the author

If UPayNow is useful to you, or you like the project, you are welcome to support the author with a donation of any amount. Every contribution is appreciated.

These addresses are for supporting the author. They do not mean UPayNow supports business payments on the corresponding networks.

| Network / address format | Donation address |
| --- | --- |
| EVM | `0x90995627e0c94e4b81dA4B2A377eAe4455FD7887` |
| Tron | TQc2u13KdjJA1m4VGsn16XAGmwAnb66oeQ |
| Solana (SOL) | BQeqxtjf6zjpNgRFQ7jphMKzj5VUrTYWgnXFCSrPZhbe |
| Bitcoin (BTC mainnet) | bc1q6nxwksk8567slqamprwkgm6uwk90s6ysc2xsvu |

## License and commercial licensing

UPayNow uses the [Elastic License 2.0 (ELv2)](LICENSE) for the project's own components. It is source-available software, not open source as defined by the OSI.

Provided you have the necessary authorization for the relevant code and comply with the license terms, you may use, copy, modify, and distribute that software, including self-hosting it for your own business.

Without separate authorization, you may not provide the software to third parties as a hosted or managed service where the service provides access to any substantial set of the software's features or functionality. This restriction applies whether or not you charge for the service. Contact the author for a separate commercial license if you intend to offer such a service.

**Contact: email: hi@louie66.com Telegram: @Louie_66**

Third-party components remain subject to their respective licenses, and their existing copyright and license notices must be preserved. See [Third-party and build licensing notices](THIRD_PARTY_NOTICES.md). WalletConnect 2.26.0 has a separate community license and must not be treated as MIT-licensed or as permitting unrestricted free commercial use. A separate commercial authorization from this project does not waive third-party terms. This is a summary; the applicable license texts govern the full rights, restrictions, and obligations.

Portions © 2025 Reown, Inc. All Rights Reserved
