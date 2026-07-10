# Paystack Tourist Payments (C2B)

Paystack collects international card payments for the TruePay Tourist (Flutter C2B) product. After funding, merchant settlement runs through Daraja — Paystack is **not** involved in merchant payouts.

## Architecture

```
Flutter C2B App
  → createPayment (callable)          ← same endpoint as legacy IntaSend flow
  → c2bFundingBridgeService
  → fundingOrderService
  → fundingRailService
  → paystackProvider.initializePayment()
  → Paystack Hosted Checkout (split_code attached)

Tourist pays card
  → Paystack Webhook (untrusted)
  → handlePaystackWebhook
  → fundingWebhookService.processFundingEvent()
  → paystackProvider.verifyPayment()   ← server-side truth
  → transactionService.completeFundingOrder()
  → fiatLedger + walletAggregate + RTDB + timeline + notification

[Tourist pays merchant from USD balance]
  → merchantSettlementService → Daraja B2B → Merchant
```

### Split payment treasury model

```
Tourist → Paystack Checkout → Transaction Split (split_code)
  → TruePay Tourist Subaccount → Settlement Bank Account
  → Safaricom Merchant Float → Daraja B2B → Merchant
```

The backend attaches `PAYSTACK_SPLIT_CODE` on every initialize request. Paystack owns split percentages; the backend never calculates them.

## Sequence diagram — funding lifecycle

```mermaid
sequenceDiagram
  participant App as Flutter C2B
  participant CP as createPayment
  participant Bridge as c2bFundingBridge
  participant FO as fundingOrderService
  participant PS as Paystack API
  participant WH as handlePaystackWebhook
  participant FWS as fundingWebhookService
  participant TS as transactionService

  App->>CP: amount, currency=USD
  CP->>Bridge: createC2bTopupCheckout
  Bridge->>FO: createFundingOrder
  Bridge->>PS: POST /transaction/initialize (split_code, metadata)
  PS-->>Bridge: authorization_url, reference
  Bridge-->>App: orderId, invoiceId, checkoutUrl
  App->>PS: Tourist pays on hosted checkout
  PS->>WH: charge.success webhook
  WH->>FWS: processFundingEvent (after signature + receipt)
  FWS->>PS: GET /transaction/verify/:reference
  FWS->>TS: completeFundingOrder
  TS-->>App: Wallet credited (via webhook; optional handlePaymentWebhook confirm)
```

## Flutter C2B integration (unchanged endpoint)

**No Paystack Flutter SDK.** Checkout opens in the **device browser** (`url_launcher` external / in-app browser) — same pattern as IntaSend today. No embedded WebView.

### External browser + return flow (implemented)

```
createPayment → open checkoutUrl in browser
  → tourist pays on Paystack
  → Paystack redirects to hosted return page (api)
  → page deep-links to truepay://payment/callback?reference=fund_…
  → Flutter handles deep link → handlePaymentWebhook({ invoiceId: reference })
  → wallet credited (webhook may already have completed server-side)
```

**Paystack callback URL** (set in Paystack dashboard *or* leave unset — backend auto-attaches):

```
https://us-central1-truepay-72060.cloudfunctions.net/api/funding/payment-return
```

Override only if needed: `PAYSTACK_CALLBACK_URL` secret or `C2B_API_BASE_URL` env.

**App deep link** (register in Flutter / Android manifest / iOS Info.plist):

```
truepay://payment/callback
```

Override: `C2B_APP_DEEP_LINK=truepay://payment/callback`

### `createPayment` callable

**Before (IntaSend):** Flutter created IntaSend checkout client-side, then called `createPayment` with `invoiceId` / `checkoutUrl`.

**Now (Paystack):** Flutter sends only `amount` (and optional `email`). Backend initializes Paystack in **KES**, attaches callback URL automatically, and returns:

| Field | Value |
|-------|-------|
| `orderId` | Funding order ID (`fund_…`) |
| `invoiceId` | Paystack reference (= funding order ID) |
| `paymentId` | Same as `invoiceId` |
| `checkoutUrl` | Paystack `authorization_url` — **open this URL** |
| `url` / `authorization_url` | Same as `checkoutUrl` (legacy aliases) |
| `amount` | Requested amount (e.g. 200 KES or 25 USD) |
| `currency` | Requested currency |
| `paystackAmount` | KES amount sent to Paystack |
| `paystackCurrency` | `KES` |
| `status` | `pending` |

**Do not** create an IntaSend checkout session in Flutter. If you pass `intasendCheckoutId` or an IntaSend `checkoutUrl`, `createPayment` returns `failed-precondition`.

Open `checkoutUrl` from the **response** with `url_launcher` (`LaunchMode.externalApplication` or `LaunchMode.inAppBrowserView`). You do **not** pass `callbackUrl` from Flutter — the backend sets it.

**Flutter flow:**

1. `createPayment({ amount, currency: 'KES' | 'USD', email? })` — no IntaSend step
2. `launchUrl(response.checkoutUrl)` — Paystack hosted checkout from server response
3. Register deep link handler for `truepay://payment/callback`
4. On deep link, read `reference` query param → `handlePaymentWebhook({ invoiceId: reference })`
5. Refresh wallet balance in UI

**Flutter deep link handler (example):**

```dart
// Android: AndroidManifest.xml intent-filter for truepay scheme
// iOS: Info.plist CFBundleURLSchemes

void handlePaymentDeepLink(Uri uri) {
  if (uri.scheme != 'truepay') return;
  final reference = uri.queryParameters['reference'];
  if (reference == null) return;
  // Callable: handlePaymentWebhook with { invoiceId: reference }
}
```

### REST alternative

`POST /funding/orders` on the `api` function exposes the same funding layer for non-callable clients.

## Webhook lifecycle

1. Raw body preserved for HMAC verification (`x-paystack-signature`)
2. Signature verified (`PAYSTACK_WEBHOOK_SECRET` or `PAYSTACK_SECRET_KEY`)
3. Receipt persisted in `webhookReceipts` (idempotency)
4. Event normalized to `NormalizedFundingEvent`
5. `fundingWebhookService.processFundingEvent()` — **never credits wallet directly**
6. Server-side `verifyPayment()` before completion
7. Amount mismatch → error, no credit
8. Duplicate webhook → idempotent success, no double credit

## Configuration

Set via Firebase Functions secrets / environment:

| Variable | Purpose |
|----------|---------|
| `PAYSTACK_SECRET_KEY` | API auth + default webhook HMAC (**required**) |
| `PAYSTACK_SPLIT_CODE` | Tourist treasury split on every transaction (**required**) |
| `PAYSTACK_CALLBACK_URL` | Optional override; default is hosted `api/funding/payment-return` |
| `C2B_APP_DEEP_LINK` | App return URL, default `truepay://payment/callback` |
| `C2B_API_BASE_URL` | Optional override for `api` function base URL |
| `PAYSTACK_WEBHOOK_SECRET` | Optional webhook HMAC override |
| `PAYSTACK_API_BASE_URL` | Default `https://api.paystack.co` |
| `FUNDING_DEFAULT_PROVIDER` | Default `paystack` |
| `PAYSTACK_PUBLIC_KEY` | Optional; **not used by Flutter** (hosted checkout only). Keep for Paystack dashboard / ops reference if desired. |

### Paystack dashboard setup

1. Create TruePay Tourist split → copy **Split Code** → `PAYSTACK_SPLIT_CODE`
2. Register **webhook URL** → `https://us-central1-truepay-72060.cloudfunctions.net/handlePaystackWebhook`
3. Optional: set **callback URL** → `https://us-central1-truepay-72060.cloudfunctions.net/api/funding/payment-return` (backend also sends this per transaction)
4. Enable `charge.success` (and related charge events)

## Failure recovery

| Scenario | Recovery |
|----------|----------|
| Webhook missed | `reconcileFundingOrders` job (every 15 min) verifies stale pending orders |
| Client redirect before webhook | `handlePaymentWebhook` or `POST /funding/confirm` triggers verify + complete |
| Verify failure | Order stays pending; ops timeline shows `funding_failed` or verification error |
| Duplicate webhook | Receipt + ledger idempotency prevent double credit |

## Reconciliation

`reconcileFundingOrders` scans `fundingOrders` in `pending`/`processing` older than `FUNDING_RECONCILE_STALE_MINUTES` (default 20), calls Paystack verify, and replays through `processFundingEvent`.

## Operational runbook

### Checkout not initializing

- Confirm `PAYSTACK_SECRET_KEY` bound on `createPayment` and `api`
- Check logs for `paystack.initialize.failed`
- Verify USD-only amount (Paystack amount = USD × 100)

### Webhook 403

- Confirm webhook URL points to `handlePaystackWebhook`
- Verify HMAC secret matches dashboard (uses secret key by default)

### Payment succeeded in Paystack but wallet not credited

1. Find funding order by reference (`invoiceId` from app)
2. `GET /funding/ops/timeline/:fundingOrderId`
3. Check `webhookReceipts` for duplicate/failed status
4. Trigger manual confirm or wait for reconciliation job

### Metrics (daily rollup in `opsMetricsDaily`)

- `funding.checkout.initialized` / `funding.checkout.failed`
- `funding.webhook.received` / `funding.webhook.duplicate`
- `funding.verification.failed` / `funding.verification.*` timing
- `funding.completed` / `funding.failed`

## What was not changed

- **Settlement / Daraja** — merchant payouts unchanged
- **B2B IntaSend** — payment links and partner checkout unchanged
- **Legacy `handleTopUpWebhook`** — still serves legacy IntaSend webhooks if configured; C2B app no longer uses this path

## Key files

| File | Role |
|------|------|
| `services/funding/providers/paystackProvider.js` | Paystack API adapter |
| `services/funding/c2bFundingBridgeService.js` | `createPayment` → funding layer bridge |
| `services/funding/fundingWebhookService.js` | Webhook orchestration |
| `http/paymentsHttp.js` | `createPayment`, `handlePaymentWebhook` callables |
| `services/funding/fundingCallbackService.js` | Callback URL + deep link builders |
| `utils/fundingPaymentReturnPage.js` | Hosted browser return page HTML |
| `http/fundingHttp.js` | `/funding/payment-return`, `/public/funding/status` |


set new keys
firebase functions:secrets:set PAYSTACK_SECRET_KEY
firebase functions:secrets:set PAYSTACK_SPLIT_CODE
firebase functions:secrets:set PAYSTACK_CALLBACK_URL

redepoy after changin fees
firebase deploy --only functions:createPayment,functions:handlePaymentWebhook,functions:handlePaystackWebhook,functions:api,functions:reconcileFundingOrders