# B2B Add Money (Paystack KES self-topup)

Dashboard integration guide for the **Pay → Add Money** modal. Partners fund their **KES** wallet via Paystack hosted checkout. International / non-KES collection is not supported on this Paystack merchant.

## Flow

```
Add Money modal
  → POST /b2bPortal/portal/funding/checkout
  → open data.checkoutUrl (Paystack)
  → user pays (card / M-Pesa / bank on Paystack)
  → Paystack redirects to /dashboard/pay?funding=return&reference=fund_…
  → POST /portal/funding/confirm (optional, speeds up if webhook is slow)
  → GET /portal/wallet until balances.KES updates
```

Server-side credit happens on **Paystack webhook** (`handlePaystackWebhook`) after verify — same rail as tourist funding, but credits the **partner wallet** (`wallets` / `ownerType: partner`), not a consumer fiat ledger.

## Auth

Same as other portal routes:

```
Authorization: Bearer <Firebase ID token>
```

User must have B2B partner claims (`partnerId` + `partnerRole`). Do **not** use Partner API `X-API-KEY` for this flow from the browser. Do **not** call consumer `createPayment`.

## Base URL

```
https://us-central1-truepay-72060.cloudfunctions.net/b2bPortal
```

## API

### 1. Create checkout — `POST /portal/funding/checkout`

**Request**

```http
POST /b2bPortal/portal/funding/checkout
Authorization: Bearer <idToken>
Content-Type: application/json
Idempotency-Key: <optional-uuid>

{
  "amount": 5000,
  "currency": "KES",
  "email": "ops@partner.com"
}
```

| Field | Required | Notes |
|-------|----------|--------|
| `amount` | Yes | KES major units, `>= 1` |
| `currency` | No | Default `KES`. Any other value → `400` |
| `email` | No | Defaults to Firebase user email |
| `callbackUrl` / `redirectUrl` | No | Override return URL (defaults to dashboard Pay page) |

**Success** `201` (or `200` if idempotent replay)

```json
{
  "success": true,
  "data": {
    "orderId": "fund_…",
    "fundingOrderId": "fund_…",
    "invoiceId": "fund_…",
    "paymentId": "fund_…",
    "amount": 5000,
    "currency": "KES",
    "paystackAmount": 5000,
    "paystackCurrency": "KES",
    "status": "pending",
    "checkoutUrl": "https://checkout.paystack.com/…",
    "url": "https://checkout.paystack.com/…",
    "authorization_url": "https://checkout.paystack.com/…",
    "provider": "paystack",
    "partnerId": "…",
    "duplicate": false
  }
}
```

**Dashboard action:** navigate the browser to `data.checkoutUrl` (same tab or new tab). Persist `orderId` / `invoiceId` in `sessionStorage` for the return handler.

### 2. Poll order — `GET /portal/funding/orders/:orderId`

```json
{
  "success": true,
  "data": {
    "orderId": "fund_…",
    "invoiceId": "fund_…",
    "status": "pending | processing | completed | failed",
    "amount": 5000,
    "currency": "KES",
    "checkoutUrl": "…",
    "failureReason": null
  }
}
```

### 3. Confirm after return — `POST /portal/funding/confirm`

Call when the user lands back on `/dashboard/pay?funding=return&reference=…` (Paystack also may send `trxref`).

```http
POST /b2bPortal/portal/funding/confirm
Authorization: Bearer <idToken>
Content-Type: application/json

{ "invoiceId": "fund_…" }
```

Or `{ "orderId": "fund_…" }`.

Then refresh wallet:

```http
GET /b2bPortal/portal/wallet
```

Use `data.balances.KES`.

## UI mapping (Add Money modal)

| Control | v1 behavior |
|---------|-------------|
| Wallet **KES** | Only funded currency — keep selected |
| **USD / USDT / USDC** | Disable or “Coming soon” — Paystack KES collection only |
| **M-Pesa / Bank / Card** | Optional UX; hosted Paystack shows enabled channels. Single **Add Money → Paystack** CTA is enough |
| **M-PESA PHONE** | Not required for hosted checkout — omit for v1 |
| Amount + presets | Send as `amount` in KES |
| Demo banner | Remove once this API is wired |
| **Add Money** | Call checkout → `window.location.href = checkoutUrl` (or `window.open`) |

## Return URL handling

Default Paystack callback:

```
https://theadmin.truepay.live/dashboard/pay?funding=return
```

Paystack appends `&reference=fund_…&trxref=fund_…`.

Suggested handler on `/dashboard/pay`:

1. If `funding=return` and `reference` present → `POST /portal/funding/confirm` with `{ invoiceId: reference }`
2. Poll `GET /portal/wallet` (and/or order status) until `completed` or timeout (~30–60s)
3. Close modal / toast success / refresh balances
4. Clear query params from the URL

## Transactions

Completed top-ups appear as `type: "b2b_funding"` on `GET /portal/transactions` (included in the B2B channel filter). Badge separately from guest `b2b_payment` link settlements if useful.

## Errors

| HTTP | Meaning |
|------|---------|
| `400` | Invalid amount, or non-KES currency |
| `401` | Missing/invalid Firebase token |
| `403` | Not a partner user |
| `404` | Order not found / wrong partner |
| `500` | Paystack or server failure |

## Out of scope

- Pay Merchant / send money (separate debit API)
- Funding USD/USDT/USDC via this endpoint
- Guest payment links (still IntaSend)

## Deploy / ops (backend)

```bash
firebase functions:secrets:set PAYSTACK_SECRET_KEY
firebase functions:secrets:set PAYSTACK_SPLIT_CODE
# optional dedicated B2B split / callback:
# firebase functions:secrets:set PAYSTACK_B2B_SPLIT_CODE   # if used as secret
# PAYSTACK_B2B_CALLBACK_URL=https://theadmin.truepay.live/dashboard/pay?funding=return

firebase deploy --only functions:b2bPortal,functions:handlePaystackWebhook,functions:reconcileFundingOrders
```

Webhook URL (already used for tourist):  
`https://us-central1-truepay-72060.cloudfunctions.net/handlePaystackWebhook`
