# B2B payment links & portal — frontend integration guide

Backend now supports **IntaSend checkout** on hosted payment links, **partner wallet credits** on webhook settlement, and **portal wallet/transaction reads** without exposing the Partner API key in the browser.

Base URL pattern:

```text
https://{region}-{projectId}.cloudfunctions.net/b2bPortal
```

TruePay example: `https://us-central1-truepay-72060.cloudfunctions.net/b2bPortal`

---

## 1. What changed (backend)

| Area | Detail |
|------|--------|
| Hosted pay page | `GET /b2bPortal/l/:linkId?partner=` — **Continue to payment** starts IntaSend and redirects |
| Checkout API | `POST /b2bPortal/public/payment-links/:linkId/checkout?partner=` |
| Payment status | `GET /b2bPortal/public/payment-links/:linkId/status?partner=` |
| Partner wallet | `GET /b2bPortal/portal/wallet` (Firebase Bearer) |
| Partner transactions | `GET /b2bPortal/portal/transactions` (Firebase Bearer) |
| Link statuses | `active`, `expired`, `cancelled`, **`paid`** |

Consumer app InstaSend top-up (`createPayment` callable + user wallet webhook) is **unchanged**.

---

## 2. B2B dashboard — partner portal (Firebase Auth)

Auth: `Authorization: Bearer <Firebase ID token>` with claims `partnerId` + `partnerRole`.

### 2.1 Wallet balances

```http
GET /b2bPortal/portal/wallet
Authorization: Bearer …
```

**Response**

```json
{
  "success": true,
  "data": {
    "walletId": "wallet_partner_…",
    "balances": { "USD": 0, "KES": 1000, "USDT": 0 }
  }
}
```

Use this instead of calling `GET /partner/wallet` with `X-API-KEY` from the browser.

### 2.2 Transaction history

```http
GET /b2bPortal/portal/transactions?limit=50
Authorization: Bearer …
```

**Response**

```json
{
  "success": true,
  "data": {
    "transactions": [
      {
        "id": "txr_…",
        "type": "b2b_payment",
        "partnerId": "…",
        "amount": 1000,
        "currency": "KES",
        "status": "completed",
        "metadata": {
          "linkId": "pl_…",
          "bookingReference": "…",
          "invoiceId": "…",
          "rail": "intasend"
        },
        "createdAt": "2026-06-05T12:00:00.000Z"
      }
    ]
  }
}
```

Filter or badge **`type === "b2b_payment"`** for payment-link collections. Metadata includes `linkId`, `bookingReference`, `invoiceId`, `rail`.

### 2.3 Payment links (existing)

| Action | Method | Path |
|--------|--------|------|
| Create | `POST` | `/portal/payment-links` (org_admin) |
| List | `GET` | `/portal/payment-links` |
| Detail | `GET` | `/portal/payment-links/:linkId` |
| Update | `PATCH` | `/portal/payment-links/:linkId` (org_admin) |

**UI updates**

- Show status **`paid`** (green) alongside `active`, `expired`, `cancelled`.
- Display optional fields when present: `paidAt`, `transactionId`, `invoiceId`.
- Disable edit for **`paid`** links (backend rejects PATCH).
- Share URL from `data.url` on create/list responses.

### 2.4 Token refresh

After org-admin or member role changes, force **ID token refresh** (sign out/in or `getIdToken(true)`) before portal calls.

---

## 3. Hosted payment link page (payer-facing)

You do **not** need a separate frontend app for the default flow — the backend serves HTML at:

```text
GET /b2bPortal/l/:linkId?partner={partnerId}
```

Optional custom domain: set env `PAYMENT_LINK_BASE_URL` (e.g. `https://pay.truepay.africa`).

### 3.1 If you build your own payer UI

**Load link**

```http
GET /b2bPortal/public/payment-links/:linkId?partner={partnerId}
```

- `200` — `active` or **`paid`**
- `410` — expired
- `409` — cancelled
- `404` — not found / wrong partner

**Start checkout**

```http
POST /b2bPortal/public/payment-links/:linkId/checkout?partner={partnerId}
Content-Type: application/json

{
  "email": "guest@example.com",
  "phoneNumber": "2547…",
  "firstName": "Jane",
  "lastName": "Guest",
  "rail": "intasend"
}
```

All body fields are optional except `partner` query param. Default rail: `intasend` (override with env `B2B_DEFAULT_PAYMENT_RAIL` on backend).

**Success `201`**

```json
{
  "success": true,
  "data": {
    "linkId": "pl_…",
    "partnerId": "…",
    "orderId": "…",
    "rail": "intasend",
    "checkoutUrl": "https://payment.intasend.com/checkout/…/express/",
    "checkoutId": "…",
    "invoiceId": "…",
    "redirectUrl": "https://…/b2bPortal/l/pl_…?partner=…&paid=1"
  }
}
```

**Action:** redirect the payer to `data.checkoutUrl` (same tab or new tab).

**Poll after return**

IntaSend redirects to `redirectUrl` with `?paid=1`. Poll until settled:

```http
GET /b2bPortal/public/payment-links/:linkId/status?partner={partnerId}
```

When `data.status === "paid"`, show confirmation.

Suggested poll: every 2s, max ~40s (hosted page already does this).

### 3.2 Currency notes

Payment links allow `USD`, `KES`, `USDT`, `NGN`, `GHS`. **IntaSend checkout** currently supports **`KES`, `USD`, `GBP`, `EUR`, `NGN`, `GHS`** — not `USDT`. Links in USDT will return `400` from checkout until a crypto rail is added.

---

## 4. Platform super-admin UI

No new routes required beyond existing payment-link management. Optional improvements:

- Show **`paid`** status and `paidAt` in platform payment-link lists.
- Link **`transactionId`** to partner transaction views.

---

## 5. Server-side / PMS integrations (unchanged)

Machine integrations still use **`partner`** with **`X-API-KEY`**:

- `GET /partner/wallet`
- `GET /partner/transactions`
- `POST /partner/payments` (manual record after off-channel payment)

Hosted link checkout is for **guest payers**; partner API remains for backends.

---

## 6. Environment / DevOps (coordinate with backend)

Ensure these Firebase secrets are set for production checkout:

| Secret | Used for |
|--------|----------|
| `INTASEND_PUBLISHABLE_KEY` | Creating checkout sessions (`b2bPortal`) |
| `INTASEND_SECRET` or `INTASEND_CHALLENGE` | Webhook verification (`handleTopUpWebhook`) |

Optional:

| Env | Purpose |
|-----|---------|
| `PAYMENT_LINK_BASE_URL` | Branded payer link host |
| `B2B_DEFAULT_PAYMENT_RAIL` | Default rail id (`intasend`) |
| `INTASEND_ENV=sandbox` | Force sandbox IntaSend host |

Deploy **`b2bPortal`**, **`handleTopUpWebhook`**, and **Firestore indexes** (`firestore.indexes.json`).

---

## 7. Consumer Flutter app

**No changes required** for B2B payment links. Do not call `createPayment` for hosted B2B links — that path credits **consumer** wallets.

---

## 8. QA checklist

- [ ] Create payment link in portal → open `data.url` → **Continue to payment** → IntaSend → complete test payment.
- [ ] Partner **`GET /portal/wallet`** balance increases.
- [ ] **`GET /portal/transactions`** shows `b2b_payment` with `metadata.linkId`.
- [ ] Link status becomes **`paid`**; PATCH rejected.
- [ ] Re-open paid link → payer sees paid state (no pay button).
- [ ] Consumer app top-up still credits **user** wallet (regression).

---

## 9. Related code

| File | Role |
|------|------|
| `functions/services/paymentRailService.js` | Rail abstraction (IntaSend first) |
| `functions/services/b2bPaymentLinkCheckoutService.js` | Start checkout + status |
| `functions/libs/b2bPayments.js` | Webhook → partner wallet |
| `functions/http/b2bPortalHttp.js` | Portal + public routes |
| `functions/utils/paymentLinkCheckoutPage.js` | Hosted HTML payer page |
