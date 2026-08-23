# B2B payment links & portal — frontend integration guide

Backend supports **IntaSend checkout** on hosted payment links, **partner wallet credits** on webhook settlement, and **portal wallet/transaction reads** without exposing the Partner API key in the browser.

Base URL pattern:

```text
https://{region}-{projectId}.cloudfunctions.net/b2bPortal
```

TruePay example: `https://us-central1-truepay-72060.cloudfunctions.net/b2bPortal`

---

## 1. Org-wide product payment links (June 2026)

Payment links are **one per product/room** (`bookingReference` = product ref, `description` = product name), shared with **all clients**. Payer identity is collected **at checkout**, not when the link is created.

| Before | After |
|--------|--------|
| Admin enters **Guest name** when creating the link | **Remove** Guest name from create/edit forms |
| One guest per link; link status → `paid` after first payment | Link stays **`active`** until expiry/cancel; **reusable** |
| Checkout without payer info | Payer enters **full name** on pay page, then IntaSend |

### Dashboard changes (frontend team)

1. **Create product payment link form** — remove Guest name; map UI labels to API fields:
   - **Product reference** → `bookingReference` (required)
   - **Product name** → `description` (optional)
   - **Link expiry** → `expiryHours` (24, 48, 168) or omit for **no expiry**

2. **Payment links table** — remove Guest column; show `paymentCount`, `lastPaidAt`, `lastPayerName`; legacy `paid` status → display as **active**.

3. **Transactions tab (super admin blocker fix)** — call **`GET /platform/transactions`** (preferred) instead of `/portal/transactions` for platform super-admin views.

---

## 1b. Platform transactions API (super admin)

```http
GET /b2bPortal/platform/transactions?channel=b2b&limit=50&startAfter={cursor}
Authorization: Bearer <Firebase ID token>
```

| Query | Default | Notes |
|-------|---------|-------|
| `channel` | `b2b` | `b2b` \| `c2b` \| `all` |
| `partnerId` | — | Optional B2B partner filter |
| `limit` | `50` | Max 100 |
| `startAfter` | — | Pagination cursor (= last row `transactionId`) |
| `status` | — | Optional status filter |

**Response**

```json
{
  "success": true,
  "data": {
    "transactions": [{
      "transactionId": "txr_…",
      "type": "b2b_payment",
      "amount": 4500,
      "currency": "USD",
      "status": "completed",
      "createdAt": "2026-06-05T12:00:00.000Z",
      "payerName": "Jane Doe",
      "metadata": {
        "linkId": "pl_…",
        "bookingReference": "DELUXE-TENT-A",
        "payerName": "Jane Doe"
      }
    }],
    "nextPageCursor": "txr_…",
    "channel": "b2b",
    "scope": "platform"
  }
}
```

**Fallback:** `GET /portal/transactions` also works for super admins (same shape + `scope`).

C2B for super admin remains on `GET /transactionsApi/admin/transactions` — no change.

---

## 2. What changed (backend)

| Area | Detail |
|------|--------|
| Hosted pay page | `GET /b2bPortal/l/:linkId?partner=` — payer enters name, then **Continue to payment** |
| Checkout API | `POST …/checkout?partner=` — **`payerName` required** |
| Session status | `GET …/status?partner=&checkoutId=` — poll **per checkout**, not link-level `paid` |
| Partner wallet | `GET /b2bPortal/portal/wallet` (Firebase Bearer) |
| Partner transactions | `GET /b2bPortal/portal/transactions` (Firebase Bearer) |
| Link statuses | `active`, `expired`, `cancelled` (+ legacy `paid` on old rows) |

Consumer app InstaSend top-up (`createPayment` callable + user wallet webhook) is **unchanged**.

---

## 3. B2B dashboard — partner portal (Firebase Auth)

Auth: `Authorization: Bearer <Firebase ID token>` with claims `partnerId` + `partnerRole`.

### 3.1 Wallet balances

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

### 3.2 Transaction history

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
          "payerName": "James Ndegwa",
          "invoiceId": "…",
          "rail": "intasend"
        },
        "createdAt": "2026-06-05T12:00:00.000Z"
      }
    ]
  }
}
```

Filter or badge **`type === "b2b_payment"`** for payment-link collections. Use **`metadata.payerName`** for the guest/payer column in transaction tables.

### 3.3 Payment links

| Action | Method | Path |
|--------|--------|------|
| Create | `POST` | `/portal/payment-links` (org_admin) |
| List | `GET` | `/portal/payment-links` |
| Detail | `GET` | `/portal/payment-links/:linkId` |
| Update | `PATCH` | `/portal/payment-links/:linkId` (org_admin) |

Platform super-admin equivalents under `/platform/partners/:partnerId/payment-links` and `/platform/payment-links`.

**Create body (example — no `guestName`)**

```json
{
  "amount": 4500,
  "currency": "USD",
  "bookingReference": "BK-2026-0042",
  "description": "Safari deposit",
  "expiryHours": 24
}
```

**List/detail fields (new / changed)**

| Field | Meaning |
|-------|---------|
| `paymentCount` | Number of completed payments via this link |
| `lastPaidAt` | ISO timestamp of most recent payment |
| `lastPayerName` | Name entered by last payer (summary only) |
| `lastTransactionId` | Latest settlement id |

**UI updates**

- Remove **Guest name** from forms and tables.
- Show **`paymentCount`** / **`lastPaidAt`** instead of link-level **Paid**.
- Disable edit only for **`cancelled`** or **`expired`** links.
- Share URL from `data.url` on create/list responses.

### 3.4 Token refresh

After org-admin or member role changes, force **ID token refresh** (sign out/in or `getIdToken(true)`) before portal calls.

---

## 4. Hosted payment link page (payer-facing)

Default flow — backend serves HTML at:

```text
GET /b2bPortal/l/:linkId?partner={partnerId}
```

The hosted page already includes a **Your full name** field and sends `payerName` to checkout. **No dashboard work required** for the default payer experience unless you build a custom pay UI.

Optional custom domain: set env `PAYMENT_LINK_BASE_URL` (e.g. `https://pay.truepay.africa`).

### 4.1 Custom payer UI (if not using hosted HTML)

**Load link**

```http
GET /b2bPortal/public/payment-links/:linkId?partner={partnerId}
```

- `200` — `active` (reusable; may include `paymentCount`, `lastPaidAt`)
- `410` — expired
- `409` — cancelled
- `404` — not found / wrong partner

**Start checkout**

```http
POST /b2bPortal/public/payment-links/:linkId/checkout?partner={partnerId}
Content-Type: application/json

{
  "payerName": "James Ndegwa",
  "email": "client@example.com",
  "phoneNumber": "2547…",
  "rail": "intasend"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `payerName` | **Yes** | Full name (min 2 chars). Alternative: `firstName` + `lastName`. |
| `email`, `phoneNumber` | No | Passed to IntaSend when provided |
| `rail` | No | Default `intasend` |

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
    "payerName": "James Ndegwa",
    "redirectUrl": "https://…/b2bPortal/l/pl_…/success"
  }
}
```

**Action:** open `data.checkoutUrl` (new tab recommended). Store `data.checkoutId` in `sessionStorage` keyed by `linkId` for post-redirect polling.

**Poll after payment (per session)**

```http
GET /b2bPortal/public/payment-links/:linkId/status?partner={partnerId}&checkoutId={checkoutId}
```

When `data.status === "paid"`, show confirmation with `data.payerName`.

Do **not** poll link-level status alone for confirmation — the link stays `active` after payment.

Suggested poll: every 2s, max ~60s.

### 4.2 Currency notes

Payment links allow `USD`, `KES`, `USDT`, `NGN`, `GHS`. **IntaSend checkout** currently supports **`KES`, `USD`, `GBP`, `EUR`, `NGN`, `GHS`** — not `USDT`. Links in USDT will return `400` from checkout until a crypto rail is added.

---

## 5. Platform super-admin UI

- Remove **Guest name** from create form and list columns (same as partner portal).
- Show **`paymentCount`**, **`lastPaidAt`**, **`lastPayerName`** on link rows.
- Transaction tables: column **Guest / Payer** from **`metadata.payerName`**, not from the link.

---

## 6. Server-side / PMS integrations (unchanged)

Machine integrations still use **`partner`** with **`X-API-KEY`**:

- `GET /partner/wallet`
- `GET /partner/transactions`
- `POST /partner/payments` (manual record after off-channel payment)

Hosted link checkout is for **guest payers**; partner API remains for backends.

---

## 7. Environment / DevOps (coordinate with backend)

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

## 8. Send / Pay (recipients, quote, payments)

See **[`B2B_SEND.md`](./B2B_SEND.md)**:

- Recipients: `GET/POST /portal/send/recipients`
- Quote (rate + fees): `POST /portal/send/quote`
- Submit: `POST /portal/send/payments` (debits wallet, notifies super admin)

---

## 8b. Add Money (partner KES self-topup)

Partners fund their own **KES** wallet via Paystack from the Pay → Add Money modal.

See **[`B2B_ADD_MONEY.md`](./B2B_ADD_MONEY.md)** for the full dashboard contract:

- `POST /b2bPortal/portal/funding/checkout` → open `checkoutUrl`
- Return to `/dashboard/pay?funding=return&reference=…`
- `POST /portal/funding/confirm` + `GET /portal/wallet`

Do **not** call consumer `createPayment` for Add Money.

---

## 9. Consumer Flutter app

**No changes required** for B2B payment links. Do not call `createPayment` for hosted B2B links — that path credits **consumer** wallets.

---

## 10. QA checklist

- [ ] Create payment link **without** guest name → open `data.url`.
- [ ] Enter payer name on hosted page → **Continue to payment** → IntaSend → complete test payment.
- [ ] Confirmation shows **Paid by** with entered name.
- [ ] Re-open same link → still **active**; another payer can pay with a different name.
- [ ] Partner **`GET /portal/wallet`** balance increases per payment.
- [ ] **`GET /portal/transactions`** shows `b2b_payment` with `metadata.payerName` and `metadata.linkId`.
- [ ] Dashboard link list shows **`paymentCount`** ≥ 1, not link-level **Paid**.
- [ ] Sending `guestName` on create returns **400**.
- [ ] Consumer app top-up still credits **user** wallet (regression).

---

## 11. Related code

| File | Role |
|------|------|
| `functions/services/paymentRailService.js` | Rail abstraction (IntaSend first) |
| `functions/services/b2bPaymentLinkCheckoutService.js` | Start checkout + status |
| `functions/libs/b2bPayments.js` | Webhook → partner wallet |
| `functions/http/b2bPortalHttp.js` | Portal + public routes |
| `functions/utils/paymentLinkCheckoutPage.js` | Hosted HTML payer page |
