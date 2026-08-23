# B2B Send (Pay) — dashboard integration

Partner **Send** flow: save merchants, quote corridor rate + fees, submit payment (debits wallet, notifies super admin).

Base URL:

```
https://us-central1-truepay-72060.cloudfunctions.net/b2bPortal
```

Auth for all `/portal/send/*` routes:

```
Authorization: Bearer <Firebase ID token>
```

Requires partner claims (`partnerId` + role).

---

## 1. Recipients (saved merchants)

### List

```http
GET /portal/send/recipients?currency=AED&limit=50
```

```json
{
  "success": true,
  "data": {
    "recipients": [
      {
        "id": "rcpt_…",
        "displayName": "Dubai Merchant",
        "currency": "AED",
        "deliveryMethod": "bank_transfer",
        "bankName": "Emirates NBD",
        "accountName": "Dubai Merchant LLC",
        "accountNumber": "AE07…",
        "country": "AE",
        "status": "active"
      }
    ]
  }
}
```

### Create

```http
POST /portal/send/recipients
Content-Type: application/json

{
  "displayName": "Dubai Merchant",
  "currency": "AED",
  "deliveryMethod": "bank_transfer",
  "bankName": "Emirates NBD",
  "accountName": "Dubai Merchant LLC",
  "accountNumber": "AE070331234567890123456",
  "country": "AE"
}
```

Also: `GET/PATCH/DELETE /portal/send/recipients/:recipientId`

Wire **+ Add new merchant** → `POST`, and the search dropdown → `GET`.

---

## 2. Quote (Payment summary)

Call whenever amount / currencies change (debounce ~300ms).

```http
POST /portal/send/quote
Content-Type: application/json

{
  "amount": 1000,
  "fromCurrency": "USD",
  "toCurrency": "AED",
  "rail": "bank_transfer"
}
```

**Response** (matches summary panel):

```json
{
  "success": true,
  "data": {
    "quote": {
      "corridor": "USD_AED",
      "rail": "bank_transfer",
      "fromCurrency": "USD",
      "toCurrency": "AED",
      "rate": 3.6732,
      "rateLabel": "1 USD = 3.6732 AED",
      "live": true,
      "youSend": 1000,
      "exchangeRate": 3.6732,
      "recipientGets": 3673.2,
      "fees": {
        "ourFee": 5,
        "paymentFee": 0,
        "totalFees": 5,
        "currency": "USD",
        "ourFeeFlat": 5,
        "ourFeePercent": 0,
        "paymentFeeFlat": 0,
        "paymentFeePercent": 0
      },
      "noChargesToRecipient": true,
      "totalDeduction": 1005,
      "availableBalance": 5250,
      "sufficientBalance": true,
      "estimatedDelivery": "Within minutes",
      "howItWorks": [ "…", "…", "…" ]
    }
  }
}
```

**UI mapping**

| Summary row | Field |
|-------------|--------|
| Rate | `rateLabel` + `live` |
| You send | `youSend` + `fromCurrency` |
| Exchange rate | `exchangeRate` |
| Recipient gets | `recipientGets` + `toCurrency` |
| Our fee | `fees.ourFee` |
| Payment fee | `fees.paymentFee` |
| Total fees | `fees.totalFees` |
| Total deduction | `totalDeduction` |
| Available balance | `availableBalance` (also `GET /portal/wallet`) |

List corridors: `GET /portal/send/corridors`.

**Ops config:** Firestore `config/b2bSend`:

```json
{
  "corridors": {
    "USD_AED": {
      "fromCurrency": "USD",
      "toCurrency": "AED",
      "rail": "bank_transfer",
      "rate": 3.6732,
      "ourFeeFlat": 5,
      "ourFeePercent": 0,
      "paymentFeeFlat": 0,
      "paymentFeePercent": 0,
      "estimatedDelivery": "Within minutes",
      "noChargesToRecipient": true
    },
    "KES_AED": {
      "fromCurrency": "KES",
      "toCurrency": "AED",
      "rail": "bank_transfer",
      "rate": 0.02825,
      "ourFeeFlat": 0,
      "ourFeePercent": 0.5,
      "paymentFeeFlat": 0,
      "paymentFeePercent": 0,
      "estimatedDelivery": "Within minutes"
    }
  }
}
```

Defaults ship in code until this doc exists. AED is **not** on Binance — keep rates in this config.

---

## 3. Create payment (Review & Confirm)

```http
POST /portal/send/payments
Content-Type: application/json

{
  "amount": 1000,
  "fromCurrency": "USD",
  "toCurrency": "AED",
  "rail": "bank_transfer",
  "paymentReference": "Invoice #12345",
  "recipientId": "rcpt_…",
  "saveRecipient": false
}
```

Or inline recipient (optional save):

```json
{
  "amount": 1000,
  "fromCurrency": "KES",
  "toCurrency": "AED",
  "recipient": {
    "displayName": "New Merchant",
    "currency": "AED",
    "bankName": "Emirates NBD",
    "accountName": "New Merchant LLC",
    "accountNumber": "AE07…"
  },
  "saveRecipient": true
}
```

**Behavior**

1. Recomputes quote server-side  
2. Debits partner wallet by `totalDeduction`  
3. Creates `partnerSendPayments` record (`status: pending`)  
4. Writes `transactionRecords` type `b2b_send`  
5. Notifies super admin (`go_live`-style system notification + FCM)

**Errors:** `INSUFFICIENT_BALANCE`, `CORRIDOR_NOT_FOUND`, `RECIPIENT_NOT_FOUND`, `CURRENCY_MISMATCH`

### Send history (dashboard table)

```http
GET /portal/send/payments?limit=50
GET /portal/send/payments?status=pending
```

```json
{
  "success": true,
  "data": {
    "payments": [
      {
        "id": "spay_…",
        "status": "pending",
        "fromCurrency": "KES",
        "toCurrency": "AED",
        "youSend": 1000,
        "recipientGets": 28.25,
        "totalDeduction": 1005,
        "paymentReference": "Invoice #12345",
        "recipientSnapshot": {
          "displayName": "Dubai Merchant",
          "currency": "AED",
          "bankName": "Emirates NBD"
        },
        "createdAt": "2026-08-09T03:30:00.000Z"
      }
    ]
  }
}
```

| Table column | Field |
|--------------|--------|
| DATE | `createdAt` |
| REFERENCE | `paymentReference` (fallback `id`) |
| MERCHANT | `recipientSnapshot.displayName` |
| WALLET | `fromCurrency` |
| SENT | `youSend` (+ `fromCurrency`) |
| RECEIVED | `recipientGets` (+ `toCurrency`) |

Also: `GET /portal/send/payments/:paymentId` for a single row.

Call this on Send page load and again after a successful `POST /portal/send/payments`.

---

## Super admin

- Notification type: `b2b_send_admin_alert` (system bucket — same as go-live alerts)
- List queue: `GET /platform/send/payments?status=pending`

Ops fulfills the bank transfer offline, then can mark complete in a follow-up (status update endpoint can be added when needed).

---

## Suggested frontend flow

1. Load recipients (`GET …/recipients?currency=AED`)  
2. Load history (`GET …/payments`) → Send history table  
3. On amount change → `POST …/quote` → bind Payment summary  
4. On **Review & Confirm** → `POST …/payments`  
5. Refresh `GET /portal/wallet` + `GET …/payments` + show pending state  

## Deploy

```bash
firebase deploy --only functions:b2bPortal
```
