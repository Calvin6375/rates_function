# Crossmint sandbox C2B funding

Crossmint Onramp is the USD card funding rail on the existing `createPayment` path. KES top-ups stay on Paystack. Crossmint does not replace the TruePay ledger. USDC is delivered to a TruePay-controlled collection wallet; SafariTap balance is the internal fiat ledger.

## Configuration

| Name | Where | Role |
|---|---|---|
| `CROSSMINT_SERVER_API_KEY` | Secret Manager | `sk_staging_…` with `orders.create` and `orders.read`. Never sent to Flutter. |
| `CROSSMINT_WEBHOOK_SECRET` | Secret Manager | Svix `whsec_…` from the Crossmint staging console. |
| `CROSSMINT_COLLECTION_WALLET` | Secret Manager | TruePay Base Sepolia address that receives USDC. |
| `CROSSMINT_USER_LOCATOR` | Function env | Crossmint user locator used to link the collection wallet, e.g. `email:ops@truepay.africa`. |
| `CROSSMINT_CLIENT_API_KEY` | Function env | `ck_staging_…` used only to build the documented WebView checkout URL. |
| `CROSSMINT_TOKEN_LOCATOR` | Optional env | Default `base-sepolia:0x036CbD53842c5426634e7929541eC2318f3dCF7e`. |
| `CROSSMINT_CHAIN` | Optional env | Default `base-sepolia`. Must match the locator prefix. |
| `FUNDING_USD_PROVIDER` | Function env | `crossmint` (default) or `paystack`. |

Staging API base is always `https://staging.crossmint.com/api`.

Webhook URL:

```text
https://us-central1-<project>.cloudfunctions.net/handleCrossmintWebhook
```

Subscribe to `orders.delivery.completed`, `orders.payment.failed`, and `orders.delivery.failed`.

## Routing

| Currency | Provider |
|---|---|
| `USD` | `FUNDING_USD_PROVIDER` (`crossmint` unless set to `paystack`) |
| `KES` and every other currency | Paystack |

`createPayment` ignores a client `provider` field. Set `FUNDING_USD_PROVIDER=paystack` to send USD through KES Paystack checkout.

## Flow

```text
createPayment (USD)
  → fundingOrders/{fund_...} status=pending provider=crossmint
  → PUT /2025-06-09/users/{locator}/linked-wallets/{address} (once)
  → POST /2022-06-09/orders (exact-in USD, card, collection wallet)
  → response checkout.orderId + checkout.clientSecret (+ WebView URL if client key is set)
```

The funding order is written before any Crossmint call. `clientSecret` is returned once and is not stored on the funding order.

Ledger credit happens only after `orders.delivery.completed` **and** GET Order shows `phase`, `payment.status`, and `delivery.status` all `completed`. `orders.payment.succeeded` is ignored. The ledger reference is `fund_crossmint_{orderId}`.

## Flutter

SafariTap (`pretium`) is on Dart `^3.1.4`. The official `crossmint_flutter` package requires Dart `^3.11.4`, so this path uses Crossmint’s documented WebView checkout URL:

`https://staging.crossmint.com/sdk/2024-03-05/embedded-checkout`

Do not credit the wallet because the WebView closed. Call `handlePaymentWebhook` / wait for the webhook.

## Smoke test

1. Set the secrets and env above. Deploy `createPayment`, `api`, `handleCrossmintWebhook`, `handlePaymentWebhook`, `reconcileFundingOrders`.
2. Register the webhook URL in the Crossmint staging console.
3. SafariTap USD top-up. Expect `provider: "crossmint"` and `checkout.orderId` / `checkout.clientSecret`.
4. Complete staging card `4242 4242 4242 4242`. Balance must not move on checkout close.
5. After delivery, one USD credit `fund_crossmint_{orderId}`. Replay does not credit again.
6. KES top-up still returns a Paystack `checkoutUrl`.

## Out of scope

Turnkey USDC deposits remain Avalanche Fuji. Crossmint onramp locators do not include Avalanche. Sweeping Base Sepolia USDC onto Fuji is not part of this rail.
