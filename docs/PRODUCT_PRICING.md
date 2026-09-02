# Product pricing (Revenue Calculator)

Server-side fee catalog for the dashboard Revenue Calculator: **fee % + flat fee (KES)** per product, stored in Firestore and applied opt-in to Pay / Send / Collection / **Local Topup** charge paths.

Formula: `charge = amount × (feePercent / 100) + flatFeeKes`

## Non-breaking rule

Suggested values (UI mock defaults) are **never** used to charge customers. Live fees apply only when:

1. `PRODUCT_PRICING_ENABLED` is not `false`, and
2. The product has `enabled: true` with a non-zero fee in `config/productPricing`

Otherwise each path keeps its legacy fee logic (Safari env flats, B2B corridor fees, full collection credit, face-amount Paystack top-ups).

## Firestore

Document: **`config/productPricing`**

```json
{
  "schemaVersion": 1,
  "products": {
    "buy_goods": { "enabled": false, "feePercent": 0, "flatFeeKes": 0 },
    "pay_bill": { "enabled": false, "feePercent": 0, "flatFeeKes": 0 },
    "pochi": { "enabled": false, "feePercent": 0, "flatFeeKes": 0 },
    "send_ke": { "enabled": false, "feePercent": 0, "flatFeeKes": 0 },
    "send_et": { "enabled": false, "feePercent": 0, "flatFeeKes": 0 },
    "send_ug": { "enabled": false, "feePercent": 0, "flatFeeKes": 0 },
    "send_tz": { "enabled": false, "feePercent": 0, "flatFeeKes": 0 },
    "send_ae": { "enabled": false, "feePercent": 0, "flatFeeKes": 0 },
    "local_topup": { "enabled": false, "feePercent": 0, "flatFeeKes": 0 },
    "payment_links": { "enabled": false, "feePercent": 0, "flatFeeKes": 0 },
    "checkout": { "enabled": false, "feePercent": 0, "flatFeeKes": 0 }
  },
  "updatedAt": null,
  "updatedBy": null
}
```

| Key | Category | Suggested (UI only) | Live path | Fee model |
|-----|----------|---------------------|-----------|-----------|
| `buy_goods` | pay | 1.5% / 0 | Safari Card Till | Wallet debit + fee |
| `pay_bill` | pay | 1.25% / 10 | Safari Card PayBill | Wallet debit + fee |
| `pochi` | pay | 1% / 5 | Catalog only | none |
| `send_ke` | send | 0.75% / 15 | **C2B Send Money** (MPESA_B2C + bank/PesaLink + SafariTap) **and** B2B `KES_KES` | Wallet debit + fee |
| `send_et` … `send_ae` | send | see UI | B2B `KES_*` corridors | Wallet debit + fee |
| **`local_topup`** | **topup** | **2.5% / 0** | **C2B Local Topup + partner Add Money (Paystack)** | **Checkout surcharge** |
| `payment_links` | collection | 2.5% / 0 | IntaSend payment-link webhook | Deduct from partner credit |
| `checkout` | collection | 2.5% / 0 | IntaSend checkout webhook | Deduct from partner credit |

## Fee models (do not confuse)

| Model | Products | Customer pays | Wallet / partner gets |
|-------|----------|---------------|------------------------|
| **`checkout_surcharge`** | `local_topup` | Face **+ fee** on Paystack | Face amount credited |
| **`merchant_credit_deduction`** | `payment_links`, `checkout` | Face amount only | Face **− fee** |
| **`wallet_debit_surcharge`** | Pay / Send | Face **+ fee** from wallet | Recipient gets face |

### Local Topup example (2.5%)

User enters **50** to receive on SafariTap or partner virtual card:

1. Server computes fee **1.25**
2. Paystack checkout amount = **51.25**
3. On success, wallet credit = **50**

Shared for:

- C2B app → Deposit → **Local Topup**
- Partner portal → Send → **Add Money**

Not used for International Topup (Transak) or crypto deposit.

### Collection example (2.5%) — different

Payment link face **50**:

1. Customer still pays **50**
2. Partner credit = **48.75**

## HTTP (`api` function)

| Method | Path | Auth |
|--------|------|------|
| GET | `/config/product-pricing` | Any authenticated user |
| PUT | `/config/product-pricing` | Platform admin |
| POST | `/config/product-pricing/reset` | Platform admin |
| POST | `/config/product-pricing/preview` | Platform admin |
| **POST** | **`/funding/topup/quote`** | **Authenticated C2B user** |

Partner Add Money quote (same breakdown): `POST /portal/funding/quote` on **`b2bPortal`**.

`GET` includes per-product `feeModel`, `adminHint`, and top-level `feeModelLabels` for the dashboard.

### Local Topup quote (Deposit Review)

Call **before** Confirm & Pay. Does not create a funding order.

```http
POST /funding/topup/quote
Authorization: Bearer <firebase-id-token>
Content-Type: application/json

{ "amount": 180, "currency": "KES" }
```

Response fields for the Review screen:

| UI row | Field |
|--------|--------|
| You deposit | `youDeposit` / `lines[you_deposit]` |
| Processing fees | `processingFees` (`display`: `"Free"` or `"1.25 KES"`) |
| Payment method fees | `paymentMethodFees` (always 0 / Free for now) |
| You will pay | `youWillPay` / `paystackAmount` (KES charged on Paystack) |
| Checkout provider | `checkoutProvider` → `"Paystack"` |

Then create checkout with the same `amount` + `currency` via `createPayment` / `POST /funding/orders`.

### C2B Send Money / Pay quote (Review screens)

Same endpoint for **Send Money** and **Pay** (Till / PayBill). Call **before** confirm. Does not create a payout.

```http
POST /safari-card/payouts/quote
Authorization: Bearer <firebase-id-token>
Content-Type: application/json
```

Cloud Function: **`safariCardApi`**.

**Pay — Buy Goods (Till)** → `buy_goods` fees:

```json
{
  "type": "MPESA_B2B",
  "accountType": "TillNumber",
  "amount": 1000,
  "currency": "KES",
  "recipient": { "account": "512345", "accountType": "TillNumber" }
}
```

**Pay — Pay Bill** → `pay_bill` fees:

```json
{
  "type": "MPESA_B2B",
  "accountType": "PayBill",
  "amount": 1000,
  "currency": "KES",
  "recipient": {
    "account": "123456",
    "accountType": "PayBill",
    "accountReference": "INV-1"
  }
}
```

**Send Money (M-Pesa / bank / SafariTap)** → `send_ke` fees:

```json
{
  "type": "MPESA_B2C",
  "amount": 10,
  "currency": "KES",
  "recipient": { "phoneNumber": "254742844875" }
}
```

Bank / PesaLink uses the same product (`type: "BANK"`).

| UI row | Field |
|--------|--------|
| You pay / You send | `youPay` / `youSend` (same value) |
| Arto+ fees | `artoFees` / `lines[arto_fees].display` |
| Payment method fees | `paymentMethodFees` (Free for now) |
| You will pay | `youWillPay` / `totalDebit` |

`data.method` is `"pay"` for Till/PayBill and `"send_money"` otherwise. `pricingProductKey` is `buy_goods`, `pay_bill`, or `send_ke` when live.

Then create the payout with the same `type` + `amount` (+ `accountType`) via `POST /safari-card/payouts`.

### Save prices

```http
PUT /config/product-pricing
Authorization: Bearer <admin>
Content-Type: application/json

{
  "products": {
    "local_topup": { "enabled": true, "feePercent": 2.5, "flatFeeKes": 0 }
  }
}
```

### Reset

`POST /config/product-pricing/reset` disables and zeroes **all** products (reverts charge paths to legacy fees). Prefer this over resetting inputs to mock suggested values.

## Admin dashboard UX (Revenue Calculator)

So operators do not confuse **Local Topup** with **Collection**:

1. **Separate section: “Topup”** (not under Collection).  
   Title: **Local Topup (Paystack)**  
   Subtitle: *C2B Deposit Local Topup + partner Add Money. Customer pays face + fee; wallet receives face amount.*

2. **Keep Collection subtitle explicit:**  
   *Inbound payment-link / checkout settlement. Customer pays face amount; fee is taken from partner credit.*

3. **Preview charge labels must follow `feeModel`** from the API (`feeModelLabels`):

   | When product is… | Amount field | Customer charge | Net |
   |------------------|--------------|-----------------|-----|
   | `local_topup` | Wallet credit | Paystack charge | Credited to wallet |
   | `payment_links` / `checkout` | Customer pays | Customer pays (same) | Partner receives |
   | Pay / Send | Transfer amount | Total wallet debit | Recipient gets |

4. Show `adminHint` under each product row (API already returns it).

5. Footer copy suggestion:  
   *Live prices with Go live are charged on the next Pay / Send / Collection / Local Topup transaction (where a charge path exists).*

6. Preview example for Local Topup with amount 50 / 2.5%:  
   Fee **1.25** · Paystack **51.25** · Wallet credit **50**.

## Precedence

| Area | When pricing applied | Else |
|------|----------------------|------|
| Safari Pay (Till / PayBill) | Replaces env B2B flat | `SAFARI_CARD_MPESA_B2B_FEE` |
| **C2B Send Money** (MPESA_B2C / BANK / SafariTap) | **`send_ke` when live** | Env `SAFARI_CARD_*_FEE` flat fallbacks |
| B2B Send (`KES_*`) | Overrides corridor `ourFeeFlat` / `ourFeePercent` | `config/b2bSend` / defaults |
| B2B Send (`USD_AED`) | Never (flat is USD) | Corridor unchanged |
| **Local Topup (Paystack)** | **Charge = face KES + fee; credit face** | **Face amount only** |
| Collection | Deducts fee from partner credit | Full credit |
| Exchange / swap | Not used | `swapFeeService` / `config/fees` |

## Env

| Variable | Default | Meaning |
|----------|---------|---------|
| `PRODUCT_PRICING_ENABLED` | `true` | Global kill switch |
| `PRODUCT_PRICING_CACHE_TTL_MS` | `60000` | In-memory cache TTL |

## Seed

```bash
cd functions
GOOGLE_APPLICATION_CREDENTIALS=... node scripts/seed-product-pricing.js --apply
```

Existing Firestore docs pick up `local_topup` via defaults merge on read (disabled until you enable + Save).

## Code map

| Piece | Path |
|-------|------|
| Service | `functions/services/pricing/productPricingService.js` |
| Routes | `functions/http/productPricingRoutes.js` |
| Pay hook | `functions/services/safariCard/safariCardPayoutFeeService.js` |
| Send hook | `functions/services/b2bSendService.js` (`resolveCorridor`) |
| Collection hook | `functions/libs/b2bPayments.js` |
| **Local Topup hooks** | `c2bFundingBridgeService.js`, `b2bFundingBridgeService.js` |
| Tests | `functions/test/pricing/*`, `functions/test/funding/b2bFundingBridgeService.test.js` |

## Out of scope (v1)

- Live Pochi charging (no distinct payout type)
- Creating ETB/UGX/TZS/domestic KES send corridors
- AED bank disbursement automation
- Swap/exchange fees
- Per-partner tiers / revenue ledger
- Transak / International Topup fees
- Crypto deposit fees
