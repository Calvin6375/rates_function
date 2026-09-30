# Crossmint sandbox C2B funding

Crossmint Onramp is the USD card funding rail on the existing `createPayment` path. KES top-ups stay on Paystack. Crossmint does not replace the TruePay ledger. USDC is delivered to a TruePay-controlled collection wallet; SafariTap balance is the internal fiat ledger.

## Configuration

Staging names stay as they are. Production uses **new** `_PROD` secrets and env vars. Do not overwrite staging values.

| Name | Where | Role |
|---|---|---|
| `CROSSMINT_ENVIRONMENT` | Function env | `staging` (default) or `production`. |
| `CROSSMINT_SERVER_API_KEY` | Secret Manager | Staging `sk_staging_…` (`orders.create`, `orders.read`). |
| `CROSSMINT_WEBHOOK_SECRET` | Secret Manager | Staging Svix `whsec_…`. |
| `CROSSMINT_COLLECTION_WALLET` | Secret Manager | Staging Base Sepolia collection address. |
| `CROSSMINT_USER_LOCATOR` | Function env | Staging locator, e.g. `email:ops@truepay.africa`. |
| `CROSSMINT_CLIENT_API_KEY` | Function env | Staging `ck_staging_…` for the WebView URL. |
| `CROSSMINT_TOKEN_LOCATOR` | Optional env | Default `base-sepolia:0x036CbD53842c5426634e7929541eC2318f3dCF7e`. |
| `CROSSMINT_CHAIN` | Optional env | Default `base-sepolia`. |
| `CROSSMINT_SERVER_API_KEY_PROD` | Secret Manager | Production `sk_production_…`. |
| `CROSSMINT_WEBHOOK_SECRET_PROD` | Secret Manager | Production Svix `whsec_…`. |
| `CROSSMINT_COLLECTION_WALLET_PROD` | Secret Manager | Production Base collection address. |
| `CROSSMINT_CLIENT_API_KEY_PROD` | Function env | Production `ck_production_…`. |
| `CROSSMINT_USER_LOCATOR_PROD` | Function env | Optional; falls back to `CROSSMINT_USER_LOCATOR`. |
| `CROSSMINT_TOKEN_LOCATOR_PROD` | Optional env | Default `base:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. |
| `CROSSMINT_CHAIN_PROD` | Optional env | Default `base`. |
| `FUNDING_USD_PROVIDER` | Function env | `crossmint` (default) or `paystack`. |

Staging API: `https://staging.crossmint.com/api`. Production API: `https://www.crossmint.com/api`. Checkout hosts match the key prefix (`staging.crossmint.com` vs `www.crossmint.com`).

Create production secrets **before** the next function deploy (Firebase binds both sets):

```bash
PROJECT=truepay-72060

gcloud secrets create CROSSMINT_SERVER_API_KEY_PROD --project="$PROJECT" --replication-policy=automatic
gcloud secrets create CROSSMINT_WEBHOOK_SECRET_PROD --project="$PROJECT" --replication-policy=automatic
gcloud secrets create CROSSMINT_COLLECTION_WALLET_PROD --project="$PROJECT" --replication-policy=automatic

printf '%s' 'sk_production_REPLACE' | gcloud secrets versions add CROSSMINT_SERVER_API_KEY_PROD \
  --project="$PROJECT" --data-file=-
printf '%s' 'whsec_REPLACE' | gcloud secrets versions add CROSSMINT_WEBHOOK_SECRET_PROD \
  --project="$PROJECT" --data-file=-
printf '%s' '0xYOUR_BASE_MAINNET_WALLET' | gcloud secrets versions add CROSSMINT_COLLECTION_WALLET_PROD \
  --project="$PROJECT" --data-file=-
```

Grant the functions runtime access (same members as the staging Crossmint secrets), then set env on `createpayment` and `api`:

```bash
gcloud run services update createpayment --project="$PROJECT" --region=us-central1 \
  --update-env-vars="CROSSMINT_ENVIRONMENT=production,CROSSMINT_CLIENT_API_KEY_PROD=ck_production_REPLACE,CROSSMINT_USER_LOCATOR_PROD=email:ops@truepay.africa"

gcloud run services update api --project="$PROJECT" --region=us-central1 \
  --update-env-vars="CROSSMINT_ENVIRONMENT=production,CROSSMINT_CLIENT_API_KEY_PROD=ck_production_REPLACE,CROSSMINT_USER_LOCATOR_PROD=email:ops@truepay.africa"
```

Also set `CROSSMINT_ENVIRONMENT=production` on `handlecrossmintwebhook`, `handlepaymentwebhook`, and `reconcilefundingorders`. Register a **new** webhook in the Crossmint production console on the same URL. Leave staging keys in place.

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

`https://staging.crossmint.com/sdk/2024-03-05/embedded-checkout` in staging, or `https://www.crossmint.com/sdk/2024-03-05/embedded-checkout` in production.

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
