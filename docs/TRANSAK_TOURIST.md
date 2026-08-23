# Transak Tourist Payments (C2B)

Transak collects international Visa/Mastercard payments for the TruePay Tourist (Flutter C2B) product. Card payments purchase **USDT into TruePay's treasury wallet**; the tourist wallet is credited from the **Fiat Ledger** after server-side verification. Merchant settlement later off-ramps USDT → KES → Daraja — Transak is **not** involved in merchant payouts.

## Architecture

```
Flutter C2B App
  → createPayment (callable)          ← same endpoint as Paystack / legacy IntaSend flow
  → c2bFundingBridgeService
  → fundingOrderService
  → fundingRailService
  → transakProvider.initializePayment()
  → Transak Widget (headless card session)

Tourist pays card
  → Transak purchases USDT
  → USDT arrives in TruePay Treasury Wallet (on-chain)
  → Transak Webhook (untrusted JWT)
  → handleTransakWebhook
  → fundingWebhookService.processFundingEvent()
  → transakProvider.verifyPayment()   ← server-side truth
  → transactionService.completeFundingOrder()
  → fiatLedger + walletAggregate + RTDB + timeline + notification

[Tourist spends from USD balance]
  → merchantSettlementService → off-ramp → KES Till → Daraja → Merchant
```

### Treasury model

```
Tourist Card
  → Transak Widget (credit_debit_card)
  → Transak purchases USDT
  → TruePay Treasury Wallet (custodial, on-chain)

Verified funding (server-side)
  → Fiat Ledger credit (USD)
  → Wallet Aggregate
  → RTDB projection
  → Tourist sees USD balance
```

**Customer balances are never sourced from blockchain.** The treasury wallet is TruePay-owned; tourists only receive internal ledger credits after verified funding.

### How Transak differs from Paystack

| Aspect | Paystack | Transak |
|--------|----------|---------|
| Card settlement | KES → Paystack split → KES treasury | USD card → USDT treasury |
| Funding order currency | KES (FX from USD at checkout) | USD (wallet currency) |
| Checkout | Paystack hosted checkout | Transak widget session URL |
| Webhook signature | HMAC-SHA512 (`x-paystack-signature`) | JWT in `data` field (Partner Access Token) |
| Provider reference | `fund_*` (Paystack reference) | `fund_*` (`partnerOrderId`) |
| Merchant settlement | Daraja from KES float | Off-ramp USDT → KES → Daraja (existing engine) |

## Sequence diagram — funding lifecycle

```mermaid
sequenceDiagram
  participant App as Flutter C2B
  participant CP as createPayment
  participant Bridge as c2bFundingBridge
  participant FO as fundingOrderService
  participant TK as Transak API
  participant TW as Treasury Wallet
  participant WH as handleTransakWebhook
  participant FWS as fundingWebhookService
  participant TS as transactionService

  App->>CP: amount, currency=USD
  CP->>Bridge: createC2bTopupCheckout (provider=transak)
  Bridge->>FO: createFundingOrder (USD, metadata.treasuryWallet)
  Bridge->>TK: GET /lookup/quote (partnerOrderId=fund_*)
  Bridge->>TK: POST /auth/session (widgetParams, treasury wallet)
  TK-->>Bridge: widgetUrl
  Bridge-->>App: orderId, invoiceId, checkoutUrl
  App->>TK: Tourist pays on Transak widget
  TK->>TW: USDT delivery
  TK->>WH: ORDER_COMPLETED webhook (JWT)
  WH->>FWS: processFundingEvent (after JWT verify + receipt)
  FWS->>TK: GET /partners/api/v2/orders?filter[partnerOrderId]=fund_*
  FWS->>TS: completeFundingOrder
  TS-->>App: Wallet credited (ledger; optional handlePaymentWebhook confirm)
```

## Flutter C2B integration (unchanged endpoint)

**No Transak Flutter SDK required for checkout.** Open `checkoutUrl` in the device browser (`url_launcher`) — same pattern as Paystack.

### `createPayment` callable

Flutter sends `amount` (and optional `email`). When `FUNDING_DEFAULT_PROVIDER=transak`, the backend:

1. Creates a `fundingOrders` document in **USD**
2. Fetches a Transak quote (`partnerOrderId` = `fundingOrderId`)
3. Creates a widget session targeting `TRANSAK_TREASURY_WALLET`
4. Returns the legacy response shape:

| Field              | Value                                   |
|--------------------|-----------------------------------------|
| `orderId`          | Funding order ID (`fund_…`)             |
| `invoiceId`        | `partnerOrderId` (= funding order ID)   |
| `paymentId`        | Same as `invoiceId`                     |
| `checkoutUrl`      | Transak `widgetUrl` — **open this URL** |
| `amount`           | Requested USD amount                    |
| `currency`         | `USD`                                   |
| `paystackAmount`   | Same as `amount` (legacy field name)    |
| `paystackCurrency` | `USD`                                   |
| `status`           | `pending`                               |
| `provider`         | `transak`                               |

Optional: pass `transakAccessToken` if the Flutter app completed Transak OTP/KYC beforehand.

### REST alternative

`POST /funding/orders` with `{ "provider": "transak", "amount": 25, "currency": "USD" }`.

## Webhook lifecycle

1. Raw body preserved for JWT verification
2. JWT in `data` verified with `TRANSAK_WEBHOOK_SECRET` (fallback: `TRANSAK_SECRET_KEY`)
3. Receipt persisted in `webhookReceipts` (idempotency)
4. Event normalized to `NormalizedFundingEvent`
5. `fundingWebhookService.processFundingEvent()` — **never credits wallets directly**
6. Server-side `verifyPayment()` via Partners API (`filter[partnerOrderId]`)
7. Amount match check (±0.01)
8. `transactionService.completeFundingOrder()`
9. Timeline, metrics, notification, receipt update

### Webhook endpoint

Deploy as Firebase function `handleTransakWebhook`. Register the HTTPS URL with Transak after KYB approval.

## Ledger model

After **verified** successful funding:

```
transactionService.completeFundingOrder()
  → createTransactionRecord (type=funding)
  → walletService.creditUserFiat(userId, amount, USD)
  → fundingOrder.status = completed
  → paymentTimeline + notification
```

Idempotency key: `fund_transak_{orderId}`

**No parallel ledger logic.** Webhook handlers never append ledger entries.

## Off-ramp architecture (out of scope for this provider)

Transak funding stores treasury metadata on the funding order:

- `metadata.treasuryWallet`
- `metadata.cryptoCurrency` (default `USDT`)
- `metadata.cryptoAmount` (from quote)
- `metadata.quoteId`

The existing **Settlement Engine** later:

```
USDT Treasury → Off-ramp → KES TruePay Till → Daraja → Merchant
```

No changes to `SettlementProvider` or Daraja are required for Transak funding.

## Configuration

| Env var | Purpose | Default |
|---------|---------|---------|
| `TRANSAK_API_KEY` | Partner API key | — |
| `TRANSAK_SECRET_KEY` | Partner Access Token (API + JWT fallback) | — |
| `TRANSAK_WEBHOOK_SECRET` | Webhook JWT signing secret | Falls back to `TRANSAK_SECRET_KEY` |
| `TRANSAK_ENVIRONMENT` | `staging` or `production` | `staging` |
| `TRANSAK_API_BASE_URL` | Gateway base URL | Derived from environment |
| `TRANSAK_PARTNERS_API_BASE_URL` | Partners API base | Derived from environment |
| `TRANSAK_DEFAULT_FIAT` | Checkout fiat currency | `USD` |
| `TRANSAK_DEFAULT_CRYPTO` | Purchased crypto asset | `USDT` |
| `TRANSAK_DEFAULT_NETWORK` | Blockchain network | `ethereum` |
| `TRANSAK_TREASURY_WALLET` | Custodial wallet for USDT delivery | — |
| `TRANSAK_REFERRER_DOMAIN` | Approved referrer domain / app package | `truepay.africa` |
| `FUNDING_DEFAULT_PROVIDER` | `paystack` or `transak` | `paystack` |

Firebase secrets (see `config.secrets`): `TRANSAK_API_KEY`, `TRANSAK_SECRET_KEY`, `TRANSAK_WEBHOOK_SECRET`.

## Provider selection

`FundingProviderRegistry` is implemented in `fundingRailService.js`:

```javascript
registerFundingProviders({
  paystack: paystackRail,
  transak: transakRail,
});
```

Set `FUNDING_DEFAULT_PROVIDER=transak` to route `createPayment` and `POST /funding/orders` through Transak. Paystack remains registered and fully functional when `FUNDING_DEFAULT_PROVIDER=paystack`.

## Metadata propagation

Every funding request carries:

| Field | Location |
|-------|----------|
| `fundingOrderId` | `fundingOrders.id`, `partnerOrderId` |
| `correlationId` | `fundingOrders.correlationId`, timeline events |
| `userId` | `fundingOrders.userId`, `partnerCustomerId` |
| `provider` | `fundingOrders.provider` |
| `product` | `metadata.product=tourist` |
| `environment` | `metadata.environment` (GCP project / staging) |
| `treasuryWallet` | `metadata.treasuryWallet` |

## Failure recovery

| Scenario | Recovery |
|----------|----------|
| Webhook missed | `reconcileFundingOrders` job (every 15 min) calls `verifyPayment` + `processFundingEvent` |
| Client redirect only | `handlePaymentWebhook` / `POST /funding/confirm` server-side verify |
| Duplicate webhook | `webhookReceipts` + completed order check → no double credit |
| Invalid JWT | 403, no ledger change |
| Amount mismatch | Verification fails, order stays pending/failed |

## Operational runbook

### Funding initialized but no webhook

1. Check `paymentTimeline` for `fund_*` order
2. Query Transak Partners API: `GET /orders?filter[partnerOrderId]=fund_*`
3. If `COMPLETED`, trigger `POST /funding/confirm` or wait for reconciliation job
4. Check `webhookReceipts` for duplicate/failed entries

### Webhook received but wallet not credited

1. Confirm JWT verification passed (no 403 in logs)
2. Check `funding.verification.failed` metrics
3. Verify amount match (USD order amount vs Transak `fiatAmount`)
4. Inspect `fundingOrders.failureReason`

### Switching providers

- **Paystack → Transak:** Set `FUNDING_DEFAULT_PROVIDER=transak`, configure Transak secrets, register webhook URL
- **Transak → Paystack:** Set `FUNDING_DEFAULT_PROVIDER=paystack` — no code deploy required beyond config

### Metrics tracked

- `funding.checkout.initialized` / `funding.checkout.failed`
- `funding.webhook.received` / `funding.webhook.duplicate`
- `funding.verification` (timing)
- `funding.completed` / `funding.failed`
- `funding.verification.failed`

## Files

| File | Role |
|------|------|
| `functions/services/funding/providers/transakProvider.js` | Transak API adapter |
| `functions/services/funding/transakRail.js` | Registry alias |
| `functions/http/transakWebhookHttp.js` | `handleTransakWebhook` |
| `functions/services/funding/c2bFundingBridgeService.js` | Provider-aware C2B bridge |
| `functions/services/funding/fundingRailService.js` | Provider registry |
| `functions/services/funding/fundingWebhookService.js` | Shared webhook orchestration |
| `functions/services/transactionService.js` | `completeFundingOrder` (unchanged) |

## Testing

```bash
cd functions
npm run test:funding
```

Covers: initialization, verification, webhook JWT, replay attacks, duplicate handling, metadata, treasury recording, and Paystack regression.
