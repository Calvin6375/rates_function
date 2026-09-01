# AED — what is implemented

AED exists in TruePay as a **B2B Send destination currency**, not as an automated UAE payout rail and not as a C2B wallet product.

API details for the partner dashboard: [`B2B_SEND.md`](./B2B_SEND.md).

---

## Status

| Area | State |
|------|--------|
| Partner Send: USD → AED and KES → AED | **Done** (quote + debit + ops queue) |
| Saved AED bank recipients (IBAN) | **Done** |
| Super-admin alert + pending list | **Done** |
| Automated AED bank / UAE payout provider | **Not done** — ops pays the merchant offline |
| Mark send completed / failed in API | **Not done** — `completedAt` exists on the record, no PATCH |
| C2B tourist AED wallet / Paystack / Safari Card | **Not done** |
| Customer P2P rates book (`config/customerRates`) | **Not used** for AED — rates are static corridor config |

---

## What was built

### 1. Corridors (static FX, not Binance)

AED is not on Binance P2P. Default corridors ship in `functions/services/b2bSendService.js` and can be overwritten in Firestore `config/b2bSend`:

| Corridor | Debit wallet | Recipient gets | Default rate (units of AED per 1 send) | Default fees |
|----------|--------------|----------------|----------------------------------------|--------------|
| `USD_AED` | Partner **USD** | AED | 3.6732 | Flat **5 USD** “our fee” |
| `KES_AED` | Partner **KES** | AED | 0.02825 | **0.5%** of send amount |

Also default: `KES_USD` (not AED). Quote `live: true` is a label; the rate is the configured number, not a live market feed.

Rail on all of these is `bank_transfer`. Delivery copy says “within minutes”; actual bank timing is ops.

### 2. Recipients

`partnerRecipientService` + `GET/POST/PATCH/DELETE /portal/send/recipients` on **`b2bPortal`**.

- Currency is any ISO-3 code; AED is the intended merchant currency.
- Delivery method is **bank_transfer only**.
- Required: `displayName`, `bankName`, `accountName`, `accountNumber` (IBAN accepted as `iban`).
- If `country` is omitted and currency is **AED**, country defaults to **AE**.

### 3. Quote and confirm

On **`b2bPortal`** (Bearer partner token):

- `POST /portal/send/quote` — `toCurrency` **defaults to AED** if omitted.
- `GET /portal/send/corridors`
- `POST /portal/send/payments` — Review & Confirm

On confirm the server:

1. Recomputes the quote (client amounts are not trusted).
2. Checks recipient currency matches `toCurrency`.
3. Debits the partner wallet by `youSend + fees` in **fromCurrency** (USD or KES). There is **no partner AED balance**.
4. Writes `partnerSendPayments/{id}` with `status: pending`.
5. Writes `transactionRecords` type `b2b_send` (also pending).
6. Notifies platform admins (`b2b_send_admin_alert` + FCM).

Money rounding for quotes is 2 decimal places (`AED` is listed in `functions/utils/money.js` with 2 decimals).

### 4. History and ops queue

- Partner: `GET /portal/send/payments` (and `/:paymentId`). Dashboard activity labels `b2b_send` as “Send payment”.
- Super admin: `GET /platform/send/payments?status=pending`.

Ops is expected to send AED to the IBAN outside the platform, then (later) mark the payment complete. **That complete/fail endpoint is not implemented.**

---

## What was not built

- No Emirates NBD, local UAE switch, or other **AED disbursement API**.
- No C2B `createPayment` / Paystack path for AED (Paystack checkout is KES; other fiats convert to KES then credit the requested C2B wallet — AED is not in that tourist rates flow unless added to `customerRates`).
- Safari Card payouts are **KES** (M-Pesa, Kenya bank, SafariTap wallet), not AED.
- C2B `STANDARD_FIAT_CURRENCIES` does not include AED (USD, KES, TZS, ETB, GBP, EUR, NGN, GHS).
- Partner default wallet balances are `{ USD, KES, USDT }` — send debit uses `balances.USD` or `balances.KES`.

---

## Code map

| Piece | Location |
|-------|----------|
| Quote, debit, notify, list | `functions/services/b2bSendService.js` |
| Recipients | `functions/services/partnerRecipientService.js` |
| HTTP | `functions/http/b2bPortalHttp.js` (`/portal/send/*`, `/platform/send/payments`) |
| Collections | `partnerSendPayments`, `partnerRecipients`, `config/b2bSend` |
| Tests | `functions/test/b2bSendService.test.js` |

Deploy: `firebase deploy --only functions:b2bPortal --project truepay-72060`
