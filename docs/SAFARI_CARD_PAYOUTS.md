# Safari Card Payouts (IntaSend Disbursement)

Safari Card outbound payments use **IntaSend Send Money API** server-side. The Flutter app never sees `INTASEND_SECRET_KEY` or other disbursement credentials.

Collection (inbound) IntaSend flows are unchanged — see [`INTASEND.md`](./INTASEND.md).

## Architecture

```
Safari Card Flutter
  │ Firebase Auth
  v
safariCardApi (Cloud Function)
  │ POST /safari-card/payouts/validate-beneficiary
  │ POST /safari-card/payouts
  │ GET  /safari-card/payouts/:id
  │ GET  /safari-card/payouts
  │ GET  /safari-card/banks
  v
safariCardPayoutService
  │ validate → reserve (fiatReservationService)
  │ create payout doc → intasendDisbursementProvider
  │ finalize debit (walletService.debitUserFiat) on SUCCESS
  v
IntaSend Send Money API
  │ MPESA-B2C / MPESA-B2B / PESALINK
  v
handleIntaSendDisbursementWebhook
  → safariCardPayoutWebhookService
  → safariCardPayoutService.applyProviderStatusUpdate
```

## Supported payout types

| Type | Provider | Use case |
|------|----------|----------|
| `MPESA_B2C` | IntaSend `MPESA-B2C` | Send to customer M-Pesa phone |
| `MPESA_B2B` + `TillNumber` | IntaSend `MPESA-B2B` | Pay merchant Till |
| `MPESA_B2B` + `PayBill` | IntaSend `MPESA-B2B` | Pay PayBill (+ `accountReference`) |
| `BANK` | IntaSend `PESALINK` | Kenyan bank account (PesaLink) |
| `SAFARITAP_WALLET` | **TruePay ledger** (no IntaSend) | Send KES to another SafariTap / C2B user wallet |
| `TRUEPAY_MERCHANT` | **TruePay ledger** → partner wallet | Pay a B2B merchant via **profile QR** or `merchantId` (not product `/l/` QR) |

Currency: **KES only** (Safari Card disbursement scope).

### Balance source (important)

Safari Card spends **available fiat ledger** balance (`walletAggregatesFiat` / `fiatLedger`), not RTDB.

Historically, **Exchange swaps** updated `users.kesBalance` (shown on `/api/accounts`) without writing the fiat ledger. Before each payout balance check the server now runs `syncFiatLedgerFromUserProjection` (credit-only) so swapped KES becomes spendable. New swaps also sync the ledger after completion.

**SafariTap / ledger sync bugs (fixed):**

1. **Wipe on receive:** `creditUserFiat` dual-writes `users.kesBalance` to the **absolute** ledger total. If ledger was `0` but users held e.g. `2,660.69`, a `+300` credit set balance to `300`. Credits now align ledger to users **before** applying the amount.
2. **Resurrect after admin zero:** Admin debit updates `users.kesBalance → 0` but could leave fiatLedger at the old total. The next SafariTap credit did `oldLedger + sendAmount` and wrote that back to users (e.g. zero → send 500 → **3,160.69**). Sync before credit/debit is now **bidirectional** (`allowDebit: true`) so admin-zeroed wallets start from `0` then add only the transfer.

If you still see `INSUFFICIENT_BALANCE`, the error includes `available` vs `required`, and active **reservations** may be holding funds.

**Repair wiped recipient:** Admin → Customer Wallets → credit KES for the missing amount (then ledger syncs on next spend).

### `SAFARITAP_WALLET` (internal transfer)

```
POST /safari-card/payouts
{
  "type": "SAFARITAP_WALLET",
  "amount": 500,
  "currency": "KES",
  "clientRequestId": "550e8400-e29b-41d4-a716-446655440000",
  "recipient": {
    "phoneNumber": "254712345678",
    "name": "Jane Doe"
  },
  "narrative": "SafariTap wallet transfer"
}
```

Optional: `recipient.userId` (Firebase uid) instead of / in addition to phone.

### `TRUEPAY_MERCHANT` (profile QR / merchant ID)

Dashboard **`GET /b2bPortal/portal/profile-qr`** returns `payUrl` / `qrCode` (`…/b2bPortal/p/{merchantId}`). Product links use `…/l/{linkId}?partner=` — do **not** treat those as merchant pay.

```
POST /safari-card/merchants/resolve
{ "payload": "<scanned QR or typed merchantId>" }
```

`kind: "profile"` → fill Merchant ID + show `partnerName`. `kind: "product"` → open hosted product checkout instead.

```
POST /safari-card/payouts/validate-beneficiary
{ "type": "TRUEPAY_MERCHANT", "merchantId": "partner_…" }
```

or `{ "type": "TRUEPAY_MERCHANT", "qrPayload": "https://…/b2bPortal/p/partner_…" }`

```
POST /safari-card/payouts
{
  "type": "TRUEPAY_MERCHANT",
  "amount": 1500,
  "currency": "KES",
  "clientRequestId": "550e8400-e29b-41d4-a716-446655440000",
  "recipient": { "merchantId": "partner_…" }
}
```

Credits the partner KES wallet; payer is debited on the SafariTap fiat ledger.

Flow (synchronous):

1. Resolve recipient by `userId` or Kenyan `phoneNumber` (`users` collection)
2. Reject self-transfer / missing user (`SELF_TRANSFER` / `RECIPIENT_NOT_FOUND`)
3. Reserve `totalDebit` (amount + fee; wallet fee default **0**, `SAFARI_CARD_WALLET_FEE`)
4. `debitUserFiat(sender)` + `creditUserFiat(recipient)` on fiat ledger
5. Confirm reservation → payout `SUCCESS` immediately (`provider: "truepay"`)

Validate:

```
POST /safari-card/payouts/validate-beneficiary
{ "type": "SAFARITAP_WALLET", "recipient": { "phoneNumber": "254712345678" } }
```

Returns `{ valid, beneficiaryName, recipientUserId, provider: "truepay" }` — no IntaSend call.

Bank amount limits per IntaSend: **KES 100 – 999,999**.

## Payout lifecycle

```
User balance (AVAILABLE)
  → RESERVE totalDebit (amount + fee)     pendingFiatReservations
  → PENDING / INITIATED / PROCESSING      safariCardPayouts
  → IntaSend initiate + approve
  → Webhook or reconcile poll
  → SUCCESS: debit ledger + confirm reservation
  → FAILED: release reservation (no permanent debit)
```

**Important:** Wallet balance is not permanently reduced until IntaSend reports **SUCCESS** (`TS100` / batch `BC100`). API acceptance only means the payout was **initiated**.

## Internal status model

| Status | Meaning |
|--------|---------|
| `PENDING` | Record created, reservation held |
| `INITIATED` | Submitted to IntaSend |
| `PROCESSING` | In flight at provider |
| `SUCCESS` | Settled; ledger debited |
| `FAILED` | Failed; reservation released |
| `CANCELLED` | Cancelled at provider |
| `RETRY` | Queued for retry |
| `UNKNOWN` | Ambiguous; reconcile |

IntaSend codes mapped in `utils/safariCardPayoutTypes.js` (`TS100`, `TF106`, `BC100`, etc.).

## API endpoints

Base URL:

```
https://us-central1-truepay-72060.cloudfunctions.net/safariCardApi
```

All routes require `Authorization: Bearer <Firebase ID token>`.

### Validate beneficiary

```
POST /safari-card/payouts/validate-beneficiary
```

```json
{
  "type": "MPESA_B2C",
  "recipient": { "phoneNumber": "254712345678" }
}
```

Response:

```json
{
  "success": true,
  "data": {
    "valid": true,
    "account": "254712345678",
    "beneficiaryName": "Jane Doe",
    "provider": "intasend"
  }
}
```

### Create payout

```
POST /safari-card/payouts
```

**M-Pesa B2C:**

```json
{
  "type": "MPESA_B2C",
  "amount": 5000,
  "currency": "KES",
  "clientRequestId": "unique-client-id-min-8-chars",
  "recipient": { "phoneNumber": "254712345678" },
  "narrative": "Safari Card transfer"
}
```

**Till:**

```json
{
  "type": "MPESA_B2B",
  "accountType": "TillNumber",
  "amount": 1500,
  "currency": "KES",
  "clientRequestId": "till-pay-001",
  "recipient": { "account": "512345" }
}
```

**PayBill:**

```json
{
  "type": "MPESA_B2B",
  "accountType": "PayBill",
  "amount": 1500,
  "currency": "KES",
  "clientRequestId": "paybill-001",
  "recipient": {
    "account": "123456",
    "accountReference": "INV-10291"
  }
}
```

**Bank:**

```json
{
  "type": "BANK",
  "amount": 10000,
  "currency": "KES",
  "clientRequestId": "bank-001",
  "recipient": {
    "bankCode": "68",
    "accountNumber": "0123456789",
    "accountName": "Jane Doe"
  }
}
```

### Get payout / list payouts

```
GET /safari-card/payouts/:payoutId
GET /safari-card/payouts?limit=20
```

GET by ID triggers reconciliation if still in-flight.

### List banks

```
GET /safari-card/banks
```

Proxies IntaSend `GET /api/v1/send-money/bank-codes/ke/`.

## Webhook

Dedicated disbursement webhook (not the collection `handleTopUpWebhook`):

```
POST https://us-central1-truepay-72060.cloudfunctions.net/handleIntaSendDisbursementWebhook
```

Configure in IntaSend dashboard as the **send money callback URL** (`callback_url` on initiate is also set when `INTASEND_DISBURSEMENT_CALLBACK_URL` is configured).

Verification: same as collection — `x-intasend-signature` HMAC and/or `INTASEND_CHALLENGE`.

Payload: IntaSend [send money events](https://developers.intasend.com/docs/send-money-events) with `tracking_id` and `transactions[]`.

## Firestore collections

### `safariCardPayouts/{payoutId}`

| Field | Description |
|-------|-------------|
| `userId` | Firebase Auth uid (never from client body) |
| `type` | `MPESA_B2C`, `MPESA_B2B`, `BANK` |
| `status` | Internal status enum |
| `amount`, `fee`, `totalDebit`, `currency` | KES amounts |
| `recipient` | Masked-safe recipient details |
| `providerTrackingId` | IntaSend `tracking_id` |
| `providerTransactionId` | IntaSend transaction id |
| `clientRequestId` | Client idempotency key |
| `idempotencyKey` | `safari_card_payout:{userId}:{clientRequestId}` |
| `requestId` | Reservation id (`fres_{requestId}`) |
| `statusHistory` | Audit trail |
| `transactionId` | `transactionRecords` on success |

### `safariCardPayoutIdempotency/{scpi_userId_clientRequestId}`

Maps client request → `payoutId`.

### Existing ledger collections (reused)

- `pendingFiatReservations` — hold `totalDebit` during payout
- `fiatLedger` / `walletAggregatesFiat` — settled debit on SUCCESS
- `transactionRecords` — `withdrawal` type audit
- `webhookReceipts` — disbursement webhook dedup

## Idempotency

- Client sends `clientRequestId` (min 8 chars) on every create request.
- Server key: `safari_card_payout:{userId}:{clientRequestId}`.
- Duplicate requests return the existing payout; IntaSend is not called twice.
- Reservation key: `fres_{payoutId}`.
- Ledger debit key: `sc_payout_debit_{payoutId}`.

## Fees

Configurable flat fees (KES):

| Env var | Default |
|---------|---------|
| `SAFARI_CARD_MPESA_B2C_FEE` | 0 |
| `SAFARI_CARD_MPESA_B2B_FEE` | 0 |
| `SAFARI_CARD_BANK_FEE` | 0 |

`totalDebit = amount + fee`. Provider charges from IntaSend may differ; actual provider `charge` is stored from webhook when available.

## Secrets / environment

| Secret / env | Purpose |
|--------------|---------|
| `INTASEND_SECRET_KEY` | Bearer auth for Send Money API |
| `INTASEND_PUBLISHABLE_KEY` | Optional `X-Publishable-Key` header |
| `INTASEND_SECRET` | Disbursement webhook HMAC |
| `INTASEND_CHALLENGE` | Webhook challenge fallback |
| `INTASEND_DEVICE_ID` | Optional device id on initiate |
| `INTASEND_DISBURSEMENT_CALLBACK_URL` | Webhook URL sent to IntaSend |
| `INTASEND_DISBURSEMENT_STUB_MODE=true` | Local/test without live API |
| `INTASEND_ENV=sandbox` | Force sandbox host |

Hosts (same as collection):

- Sandbox: `https://sandbox.intasend.com`
- Production: `https://payment.intasend.com`

## IntaSend API reference

Official docs: [Send Money introduction](https://developers.intasend.com/docs/send-money.md) · [Authentication](https://developers.intasend.com/docs/authentication.md) · [Transaction status codes](https://developers.intasend.com/docs/payment-statuses-reference.md)

### Endpoints used by Safari Card (backend)

| Safari Card flow | IntaSend API | Official reference |
|------------------|--------------|-------------------|
| Validate beneficiary | `POST /api/v1/send-money/validate-accounts/` | [Validate Account Name](https://developers.intasend.com/reference/api_v1_send_money_validate_accounts_create) |
| Create payout (step 1) | `POST /api/v1/send-money/initiate/` | [Initiate Send Money](https://developers.intasend.com/reference/api_v1_send_money_initiate_create) |
| Create payout (step 2) | `POST /api/v1/send-money/approve/` | [Approve Send Money](https://developers.intasend.com/reference/api_v1_send_money_approve_create) |
| Reconcile / poll | `POST /api/v1/send-money/status/` | [Check Send Money Status](https://developers.intasend.com/reference/api_v1_send_money_status_create) |
| Bank picker | `GET /api/v1/send-money/bank-codes/ke/` | [List Bank Codes](https://developers.intasend.com/reference/api_v1_send_money_bank_codes_retrieve) |

Adapter: `functions/services/intasend/intasendDisbursementProvider.js`

**Initiate body (what we send):**

| Field | Safari Card value |
|-------|-------------------|
| `currency` | `KES` |
| `country` | `KE` |
| `provider` | `MPESA-B2C` · `MPESA-B2B` · `PESALINK` |
| `requires_approval` | `NO` (straight-through; we still call approve if IntaSend returns preview `BP103`) |
| `transactions[]` | One row per payout — see [M-Pesa B2C](https://developers.intasend.com/docs/m-pesa-b2c.md), [M-Pesa B2B](https://developers.intasend.com/docs/m-pesa-b2b.md), [Bank/PesaLink](https://developers.intasend.com/docs/bank.md) |
| `batch_reference` | `payoutId` (max 70 chars) |
| `callback_url` | `INTASEND_DISBURSEMENT_CALLBACK_URL` → `handleIntaSendDisbursementWebhook` |
| `device_id` | Optional — `INTASEND_DEVICE_ID` |

**Transaction row fields:**

| Payout type | Required IntaSend fields |
|-------------|-------------------------|
| M-Pesa B2C | `name`, `account` (254…), `amount`, `narrative`, `request_reference_id` |
| M-Pesa B2B Till | `name`, `account`, `account_type: TillNumber`, `amount`, `narrative` |
| M-Pesa B2B PayBill | above + `account_reference` |
| Bank | `name`, `account`, `bank_code`, `amount`, `narrative` |

**Validate-accounts body:** `account`, `provider`, `country: KE`, plus `account_type` (B2B) or `bank_code` (PESALINK).

**Auth:** `Authorization: Bearer <INTASEND_SECRET_KEY>` on:

- Sandbox: `https://sandbox.intasend.com`
- Production: `https://payment.intasend.com`

(Same hosts as collection — see [`INTASEND.md`](./INTASEND.md).)

### IntaSend APIs not wired yet (available for future)

| API | Reference | Notes |
|-----|-----------|-------|
| Cancel batch | [Cancel Send Money](https://developers.intasend.com/reference/api_v1_send_money_cancel_create) | Could expose user cancel before approve |
| List / retrieve beneficiaries | [List](https://developers.intasend.com/reference/api_v1_send_money_beneficiaries_list) · [Retrieve](https://developers.intasend.com/reference/api_v1_send_money_beneficiaries_retrieve) · [Frequently used](https://developers.intasend.com/reference/api_v1_send_money_beneficiaries_frequently_used_retrieve) | Saved recipients in IntaSend |
| Categories | [Retrieve categories](https://developers.intasend.com/reference/api_v1_send_money_categories_retrieve) | Payment categorization |
| Transaction history | [List](https://developers.intasend.com/reference/api_v1_send_money_transactions_list) · [Retrieve](https://developers.intasend.com/reference/api_v1_send_money_transactions_retrieve) | Admin/reconciliation views |
| M-Pesa PayBill accounts | [List](https://developers.intasend.com/reference/api_v1_mpesa_paybill_accounts_list) · [Create](https://developers.intasend.com/reference/api_v1_mpesa_paybill_accounts_create) · [Retrieve](https://developers.intasend.com/reference/api_v1_mpesa_paybill_accounts_retrieve) | IntaSend account setup, not per-payout |

## Deploy

```bash
# Required for safariCardApi (Send Money / validate-accounts)
firebase functions:secrets:set INTASEND_SECRET_KEY
firebase functions:secrets:set INTASEND_PUBLISHABLE_KEY

# Required for disbursement webhooks
firebase functions:secrets:set INTASEND_SECRET
firebase functions:secrets:set INTASEND_CHALLENGE

# optional:
# firebase functions:secrets:set INTASEND_DEVICE_ID
# firebase functions:secrets:access INTASEND_SECRET_KEY  # verify test vs live prefix

firebase deploy --only functions:safariCardApi,functions:handleIntaSendDisbursementWebhook
```

### IntaSend 401 `PROVIDER_AUTH_ERROR` troubleshooting

If validate-beneficiary / create payout returns `502` / `PROVIDER_AUTH_ERROR`:

1. **Sandbox vs live** — Test keys (`ISSecretKey_test_…`) must hit `sandbox.intasend.com`. Live keys (`…_live_…`) must hit `payment.intasend.com`. Set `INTASEND_ENV=sandbox` or `live` if auto-detection is wrong.
2. **Secret on deployed revision** — Confirm `safariCardApi` binds `INTASEND_SECRET_KEY` and `INTASEND_PUBLISHABLE_KEY`. Re-set secrets if unsure:
   ```bash
   firebase functions:secrets:set INTASEND_SECRET_KEY
   firebase functions:secrets:set INTASEND_PUBLISHABLE_KEY
   firebase deploy --only functions:safariCardApi
   ```
3. **Send Money enabled** — IntaSend dashboard → enable disbursement / fund working wallet ([Bank Payouts](https://developers.intasend.com/docs/bank)).
4. **Cloud Logs** — Search `intasend.apiAuthFailed` for `apiHost`, `isSandbox`, and masked key prefix.

`GET /safari-card/banks` uses IntaSend [List Bank Codes](https://developers.intasend.com/reference/api_v1_send_money_bank_codes_retrieve) and falls back to the documented Kenya list if the provider call fails, so the bank picker should still load. **Validate** and **Send** still require a working secret key ([Validate Account Name](https://developers.intasend.com/reference/api_v1_send_money_validate_accounts_create)).

## IntaSend dashboard setup (production)

1. Enable **Send Money / Disbursement** on the IntaSend account.
2. Fund the IntaSend **working wallet** with sufficient KES float.
3. Register disbursement webhook URL → `handleIntaSendDisbursementWebhook`.
4. Generate/configure **device ID** if required by your account (set `INTASEND_DEVICE_ID`).
5. Test in sandbox first (`INTASEND_ENV=sandbox` or sandbox keys).

## Source files

| File | Role |
|------|------|
| `services/intasend/intasendClient.js` | Shared auth/host HTTP client |
| `services/intasend/intasendDisbursementProvider.js` | Send Money API adapter |
| `services/safariCard/safariCardPayoutService.js` | Payout orchestration |
| `services/safariCard/safariCardPayoutValidation.js` | Input validation |
| `services/safariCard/safariCardPayoutFeeService.js` | Fee calculation |
| `services/safariCard/safariCardPayoutWebhookService.js` | Webhook processing |
| `services/safariCard/safariCardPayoutReconcileService.js` | Status polling backup |
| `http/safariCardHttp.js` | Authenticated REST API |
| `http/intasendDisbursementWebhookHttp.js` | Webhook HTTP handler |
| `utils/safariCardPayoutTypes.js` | Status mapping, errors |

## Admin dashboard list (Safari Tap tabs)

```http
GET /api/admin/safari-tap/transactions?type=topups
Authorization: Bearer <platform member Firebase ID token>

Any `sessionScope: "platform_admin"` role (`super_admin`, `operations_admin`, `support_admin`, `finance_admin`). Partner sessions are rejected.

Alias: `GET /b2bPortal/platform/safari-tap/transactions` (same query).
```

| Query | Values |
|-------|--------|
| **`type`** (or `method`) | `topups` \| `pay` \| `send` \| `exchange` (**required**) |
| `period` | `today` \| `7d` \| `30d` (default) \| `month` \| `custom` |
| `startDate` / `endDate` | ISO dates when `period=custom` |
| `status`, `currency`, `userId`, `search` | optional filters |
| `limit`, `startAfter` | pagination (max 100) |

**Tab mapping**

| type | Sources |
|------|---------|
| `topups` | `funding` / `topup` / `crypto_onramp` + `fundingOrders` + `orders` (`topup`, `direct_topup`) |
| `pay` | `merchant_payment` + Safari Card `MPESA_B2B` |
| `send` | SafariTap wallet + `MPESA_B2C` + `BANK` + P2P `orders.send` |
| `exchange` | `orders` with `orderType=swap` |

Row fields for the UI table: `orderId`, `clientName`, `recipientName`, `date`, `type`, `amount`, `currency`, `phone`, `channel` (`C2B`), `status`.

Deploy: `firebase deploy --only functions:api`

## Tests

```bash
cd functions && npm test -- test/safariCard test/c2bSafariTapAdminListService.test.js
```

## Unchanged collection flows

These remain untouched:

- `paymentRailService.js` checkout / B2B payment links
- `handleTopUpWebhook` consumer + B2B collection settlement
- `getIntaSendPaymentStatus` admin collection status
- `b2bCheckoutReconcileService` collection reconcile
