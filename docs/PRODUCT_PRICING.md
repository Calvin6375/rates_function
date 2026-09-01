# Product pricing (Revenue Calculator)

Server-side fee catalog for the dashboard Revenue Calculator: **fee % + flat fee (KES)** per product, stored in Firestore and applied opt-in to Pay / Send / Collection charge paths.

Formula: `charge = amount × (feePercent / 100) + flatFeeKes`

## Non-breaking rule

Suggested values (UI mock defaults) are **never** used to charge customers. Live fees apply only when:

1. `PRODUCT_PRICING_ENABLED` is not `false`, and
2. The product has `enabled: true` with a non-zero fee in `config/productPricing`

Otherwise each path keeps its legacy fee logic (Safari env flats, B2B corridor fees, full collection credit).

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
    "payment_links": { "enabled": false, "feePercent": 0, "flatFeeKes": 0 },
    "checkout": { "enabled": false, "feePercent": 0, "flatFeeKes": 0 }
  },
  "updatedAt": null,
  "updatedBy": null
}
```

| Key | Category | Suggested (UI only) | Live path |
|-----|----------|---------------------|-----------|
| `buy_goods` | pay | 1.5% / 0 | Safari Card `MPESA_B2B` + Till |
| `pay_bill` | pay | 1.25% / 10 | Safari Card `MPESA_B2B` + PayBill |
| `pochi` | pay | 1% / 5 | Catalog only (no payout type yet) |
| `send_ke` … `send_ae` | send | see UI | B2B `KES_*` corridors when present |
| `payment_links` | collection | 2.5% / 0 | IntaSend webhook when `linkId` set |
| `checkout` | collection | 2.5% / 0 | IntaSend webhook without `linkId` |

## HTTP (`api` function)

| Method | Path | Auth |
|--------|------|------|
| GET | `/config/product-pricing` | Any authenticated user |
| PUT | `/config/product-pricing` | Platform admin |
| POST | `/config/product-pricing/reset` | Platform admin |
| POST | `/config/product-pricing/preview` | Platform admin |

### Save prices

```http
PUT /config/product-pricing
Authorization: Bearer <admin>
Content-Type: application/json

{
  "products": {
    "buy_goods": { "enabled": true, "feePercent": 1.5, "flatFeeKes": 0 }
  }
}
```

### Reset

`POST /config/product-pricing/reset` disables and zeroes **all** products (reverts charge paths to legacy fees). Prefer this over resetting inputs to mock suggested values.

## Precedence

| Area | When pricing applied | Else |
|------|----------------------|------|
| Safari Pay (Till / PayBill) | Replaces env B2B flat | `SAFARI_CARD_MPESA_B2B_FEE` |
| B2B Send (`KES_*`) | Overrides corridor `ourFeeFlat` / `ourFeePercent` | `config/b2bSend` / defaults |
| B2B Send (`USD_AED`) | Never (flat is USD) | Corridor unchanged |
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

## Code map

| Piece | Path |
|-------|------|
| Service | `functions/services/pricing/productPricingService.js` |
| Routes | `functions/http/productPricingRoutes.js` |
| Pay hook | `functions/services/safariCard/safariCardPayoutFeeService.js` |
| Send hook | `functions/services/b2bSendService.js` (`resolveCorridor`) |
| Collection hook | `functions/libs/b2bPayments.js` |
| Tests | `functions/test/pricing/productPricingService.test.js`, `productPricingSafariSend.test.js`, `productPricingCollection.test.js` |

## Out of scope (v1)

- Live Pochi charging (no distinct payout type)
- Creating ETB/UGX/TZS/domestic KES send corridors
- AED bank disbursement automation
- Swap/exchange fees
- Per-partner tiers / revenue ledger
- Dashboard UI (API ready for Save / Reset / preview)
