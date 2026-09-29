# Plan: Replace Grid C2B with Crossmint Onramp sandbox

USD card top-up stays on the existing TruePay funding rail. `FUNDING_USD_PROVIDER` defaults to `crossmint`. KES stays Paystack. Crossmint delivers staging USDC to one TruePay-controlled wallet; SafariTap balance is still the TruePay fiat ledger. Credit only after `orders.delivery.completed` plus GET Order verification.

## Existing inventory

### Lightspark/Grid C2B (remove from this path)

- `functions/services/funding/providers/gridApi.js`
- `functions/services/funding/providers/gridProvider.js`
- `functions/services/funding/gridAccountService.js`
- `functions/http/gridWebhookHttp.js`
- `functions/http/gridSandboxHttp.js`
- `docs/grid-sandbox-c2b.md`
- tests: `c2bFundingBridgeGrid.test.js`, `gridProvider.test.js`, `gridWebhook.test.js`
- Grid branches in `paymentsHttp.js`, `fundingHttp.js`, `customerWalletsHttp.js`, `index.js`, `config.js`, `c2bFundingBridgeService.js`, `fundingRailService.js`, `fundingTypes.js`

Grid is not used by merchant Daraja, Turnkey crypto deposits, or B2B Paystack. Leave `users/{uid}.grid` and `gridCustomerLinks` data in Firestore (orphaned after deploy).

### Provider abstraction (keep)

- `fundingProviderInterface.js`: `initializePayment`, `verifyPayment`, `normalizeWebhook`, `verifyWebhookSignature`
- `fundingRailService.js` registry
- `fundingOrderService.js` writes the order **before** the provider call
- `fundingWebhookService.processFundingEvent` → `transactionService.completeFundingOrder` → `walletService.creditUserFiat`
- Ledger id: `fund_{provider}_{providerTransactionId || providerReference}`
- `webhookReceipts` for at-least-once delivery

### Funding order flow (keep)

```
createPayment | POST /funding/orders
  → c2bFundingBridgeService
  → fundingOrders (pending)
  → fundingRailService.initializePayment
  → adapter
webhook / confirm
  → verifyPayment
  → completeFundingOrder
  → creditUserFiat(requestedAmount)
```

Callable `createPayment` ignores client `provider`. REST honors `body.provider`. Quote `POST /funding/topup/quote` stays Paystack-only.

### Flutter top-up (`/Users/calvin/Projects/Kalvo/pretium`)

- `PaymentService.createPayment` → Grid USD instructions **or** WebView `checkoutUrl`
- No Crossmint SDK today
- App may send `provider: transak` for USD; server ignores it

## Routing

- Currency other than USD → Paystack (unchanged)
- USD → `FUNDING_USD_PROVIDER` / `config.funding.usdProvider`, default **`crossmint`**
- Allowed USD values: `crossmint` | `paystack`
- `grid` as USD provider throws `Unsupported FUNDING_USD_PROVIDER`

## Crossmint (documented only)

- Staging API: `https://staging.crossmint.com/api`
- `POST /2022-06-09/orders` with `x-api-key`
- Body: `lineItems[{ tokenLocator, executionParameters: { mode: "exact-in", amount } }]`, `payment: { method: "card", receiptEmail }`, `recipient: { walletAddress }`
- 201: `order.orderId`, `clientSecret`
- GET `/2022-06-09/orders/{orderId}`
- Credit only when `phase`, `payment.status`, and `lineItems[0].delivery.status` are all `completed`
- Do **not** credit on widget success or `orders.payment.succeeded`
- Webhook V3: `{ actionId, type, data }`; Svix `svix-id` / `svix-timestamp` / `svix-signature`
- External wallet: `PUT /2025-06-09/users/{userLocator}/linked-wallets/{address}` then create order
- Flutter: `crossmint_flutter`, `CrossmintEmbeddedCheckout(apiKey: ck_staging_…, config.order: ExistingOrder(orderId, clientSecret))`. Environment is the key prefix.

Default locator: `base-sepolia:0x036CbD53842c5426634e7929541eC2318f3dCF7e`. Crossmint onramp has **no Avalanche** locator. Turnkey Fuji USDC stays a separate crypto rail.

## Implementation

### Adapter

- `initializePayment`: require USD; require real email (`receiptEmail`); idempotent link of `CROSSMINT_COLLECTION_WALLET` on `CROSSMINT_CHAIN` under `CROSSMINT_USER_LOCATOR`; POST create order; return `checkoutUrl: null`, `providerReference` = Crossmint `orderId`, `raw: { orderId, clientSecret, collectionWallet, tokenLocator, chain }`
- `verifyPayment`: GET order; success only if all three completed, amount within 0.01 of funding order, destination matches collection wallet
- `normalizeWebhook`: `orders.delivery.completed` → success (`providerReference` = `actionId`); `orders.payment.failed` / `orders.delivery.failed` → failed; `orders.payment.succeeded` and quote events → `null`
- `verifyWebhookSignature`: Svix HMAC-SHA256 as documented (`whsec_` prefix, raw body, 5-minute timestamp)

### Bridge / HTTP

- Replace `createC2bGridTopupCheckout` with `createC2bCrossmintTopupCheckout` (USD, no FX, no 50k KES cap)
- Patch `providerReference` / `providerTransactionId` to Crossmint order id
- Persist metadata `collectionWallet`, `tokenLocator`, `chain` — **never persist `clientSecret`**
- `createPayment` / REST 201 extras: `checkout: { orderId, clientSecret }` in-memory only; idempotent replay returns `checkout: null`
- `handleCrossmintWebhook`: copy Transak webhook HTTP (403 on bad sig; 200 on ignore/duplicate)
- Bind `CROSSMINT_SERVER_API_KEY` on `createPayment`, `api`, `handleCrossmintWebhook`, `handlePaymentWebhook`, `reconcileFundingOrders`
- Bind `CROSSMINT_WEBHOOK_SECRET` on the webhook function only
- Bind `CROSSMINT_COLLECTION_WALLET` on create/api

### Flutter (sibling repo, separate but required)

- Add `crossmint_flutter`
- If `provider == crossmint` and `checkout.orderId` + `checkout.clientSecret` present → embedded checkout
- After widget completion, call existing confirm/`handlePaymentWebhook`; do not credit locally
- Stop routing new USD responses to `UsdFundingInstructionsScreen`

## Files

**Add**

- `functions/services/funding/providers/crossmintApi.js`
- `functions/services/funding/providers/crossmintProvider.js`
- `functions/http/crossmintWebhookHttp.js`
- `functions/test/funding/crossmintProvider.test.js`
- `functions/test/funding/crossmintWebhook.test.js`
- `functions/test/funding/c2bFundingBridgeCrossmint.test.js`
- `docs/crossmint-sandbox-c2b.md`

**Modify**

- `functions/utils/fundingTypes.js`
- `functions/services/funding/fundingRailService.js`
- `functions/config.js`
- `functions/services/funding/c2bFundingBridgeService.js`
- `functions/http/paymentsHttp.js`
- `functions/http/customerWalletsHttp.js`
- `functions/http/fundingHttp.js`
- `functions/jobs/reconcileFundingOrders.js` (secrets)
- `functions/index.js`
- `docs/INDEX.md`, `docs/README_HIGH_LEVEL.md`

**Remove**

- Grid C2B files listed above

**Keep**

- Firestore index `fundingOrders` `userId` + `provider` + `status`
- Paystack KES path, Transak REST path, Turnkey crypto deposits

## Tests

From `functions/`:

```bash
npx jest test/funding/crossmintProvider.test.js test/funding/crossmintWebhook.test.js test/funding/c2bFundingBridgeCrossmint.test.js test/funding/c2bFundingBridgeService.test.js test/funding/c2bFundingBridgeTransak.test.js
```

Cover: USD → Crossmint; KES → Paystack; create-order body exact; link PUT once; delivery.completed credits once; payment.succeeded does not credit; failed → order failed; pending → no credit; Svix reject; `FUNDING_USD_PROVIDER=paystack` USD still Paystack.

## Sandbox smoke

1. Set secrets + `FUNDING_USD_PROVIDER=crossmint`. Deploy `createPayment`, `api`, `handleCrossmintWebhook`, `handlePaymentWebhook`, `reconcileFundingOrders`.
2. Register webhook URL in Crossmint staging for `orders.delivery.completed`, `orders.payment.failed`, `orders.delivery.failed`.
3. SafariTap USD top-up → `createPayment` returns `provider: crossmint` and `checkout` secrets.
4. Complete staging card in widget. Balance must **not** move yet.
5. After delivery webhook + GET verify, one `fund_crossmint_{orderId}` credit.
6. Replay webhook: no second credit.
7. KES top-up still Paystack.

## Remaining manual steps

- Create `CROSSMINT_SERVER_API_KEY`, `CROSSMINT_WEBHOOK_SECRET`, `CROSSMINT_COLLECTION_WALLET` in Secret Manager
- Set `CROSSMINT_USER_LOCATOR` and Flutter `CROSSMINT_CLIENT_API_KEY` (`ck_staging_…`)
- Quote screen still shows Paystack KES for USD until that route is changed on purpose
- In-flight Grid orders will not complete after Grid code is removed
- Sweeping Base Sepolia USDC onto Avalanche Fuji is out of scope

## Do not

- Redesign funding or credit from Flutter
- Create per-user blockchain wallets
- Persist `clientSecret` or send `sk_` to Flutter
- Invent Crossmint fields or a production host
- Break Paystack KES
- Use Turnkey Fuji as the Crossmint recipient (unsupported locator)
