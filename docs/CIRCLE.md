# Circle USDC — Developer-Controlled Wallets

TruePay integrates [Circle Developer-Controlled Wallets](https://developers.circle.com/wallets/dev-controlled) as a **crypto payment rail** alongside existing fiat rails (IntaSend, TransFi). Circle handles wallet creation, on-chain transfers, and webhook notifications — the backend never manages private keys or blockchain nodes.

USDC balances are tracked separately from fiat wallets. **Firestore is the source of truth** (append-only ledger + aggregate cache + reservations). Realtime Database at `wallet/{userId}/crypto/USDC` is a **read-only projection** for the Flutter app — never used for balance computation.

---

## Base URLs (TruePay project)

Firebase / GCP project ID: **`truepay-72060`**. Region default: **`us-central1`**.

| Function | Purpose |
|----------|---------|
| `cryptoApi` | Consumer crypto REST API (wallet, balance, send) |
| `handleCircleWebhook` | Circle webhook receiver |
| `reconcileCircleLedger` | Scheduled job — ledger drift correction (every 6h) |

**Production**

```text
https://us-central1-truepay-72060.cloudfunctions.net/cryptoApi
https://us-central1-truepay-72060.cloudfunctions.net/handleCircleWebhook
```

**Emulator (local)**

```text
http://localhost:5001/truepay-72060/us-central1/cryptoApi
http://localhost:5001/truepay-72060/us-central1/handleCircleWebhook
```

---

## Architecture

### Truth model (strict)

| Layer | Role |
|-------|------|
| `cryptoLedger` | **Source of truth** — append-only immutable credits/debits |
| `pendingReservations` | Pending send liabilities (funds held before ledger debit) |
| `walletAggregates` | Read cache derived from ledger only |
| `cryptoTransactions` | Audit / UI log only — **never used for balance math** |
| `cryptoWallets` | Wallet metadata only — **no balance field** |
| `wallet/{uid}/crypto/USDC` (RTDB) | UI projection only — writes via `rtdbSyncService` |

**Balance formulas:**

```text
ledgerBalance   = walletAggregates.USDC  (or sum of cryptoLedger entries)
availableBalance = ledgerBalance - sum(active reservations)
```

RTDB, `cryptoTransactions`, and `cryptoWallets` are never read to compute balances.

### Data flow

```
READ PATH:
  walletService / cryptoApi
    → ledgerService.getAvailableBalance()
    → walletAggregates minus pendingReservations
    → RTDB cache (Flutter display only)

WRITE PATH (deposit):
  Circle webhook → circleRailAdapter
    → webhook lock (transaction-safe)
    → ledgerService.appendTransaction (credit)
    → walletAggregates update
    → cryptoTransactions (complete)
    → rtdbSyncService.syncToRTDB()

WRITE PATH (send):
  POST /crypto/send → circleRailAdapter.send
    → sendIdempotencyKeys lock
    → reservationService.reserveFunds()   ← before Circle API
    → Circle createTransaction
    → cryptoTransactions (pending)
    → return immediately
  Circle webhook (outbound complete):
    → ledgerService.appendTransaction (debit)
    → reservationService.confirmReservation()
    → cryptoTransactions → complete
    → rtdbSyncService.syncToRTDB()
  Circle webhook (outbound failed):
    → reservationService.releaseReservation()
    → cryptoTransactions → failed

RECONCILIATION (every 6h):
  reconcileCircleLedger
    → fetch Circle on-chain USDC per wallet
    → compare to ledgerService.getLedgerBalance()
    → append reconciliation_adjustment if drift detected (idempotent)
```

### Module map

All external Circle access goes through **`circleRailAdapter.js`**. No direct Circle API calls outside the adapter.

```
┌─────────────────┐     ┌──────────────────────┐     ┌─────────────┐
│  Flutter app    │────▶│  cryptoApi (HTTP)    │────▶│ circleRail  │
│  Bearer auth    │     │                      │     │ Adapter     │
└────────┬────────┘     └──────────────────────┘     └──────┬──────┘
         │ RTDB (cache)                                    │ Circle SDK
         ▼                                                   ▼
 wallet/{uid}/crypto/USDC                          ┌─────────────┐
         ▲              rtdbSyncService             │  Circle API │
         │                                         └─────────────┘
         │         ┌────────────────────────┐            ▲
         └─────────│  ledgerService         │            │ webhooks
                   │  reservationService    │   ┌────────┴──────────┐
                   │  cryptoLedger          │◀──│ handleCircleWebhook│
                   │  walletAggregates      │   │ paymentRailService │
                   └────────────────────────┘   └────────────────────┘
                              ▲
                   ┌──────────┴───────────┐
                   │ reconcileCircleLedger │  (scheduled, 6h)
                   └──────────────────────┘
```

| Module | Path | Responsibility |
|--------|------|----------------|
| `circleRailAdapter.js` | `services/circle/` | **Sole entry point** — send, balance, webhooks, wallet ops |
| `ledgerService.js` | `services/ledger/` | Append-only ledger, aggregates, `getLedgerBalance()`, `getAvailableBalance()` |
| `reservationService.js` | `services/ledger/` | Reserve / confirm / release funds; prevents double-spend |
| `rtdbSyncService.js` | `services/sync/` | **Sole gateway** for USDC RTDB writes |
| `sendIdempotencyService.js` | `services/circle/` | Send idempotency keys (24h TTL) + `circleTransactionId` mapping |
| `circleService.js` | `services/circle/` | Low-level API client (adapter only) |
| `circleWalletService.js` | `services/circle/` | Wallet create/lookup (adapter only) |
| `circleWebhookService.js` | `services/circle/` | Delegate to adapter + 72h replay guard |
| `circleTransactionService.js` | `services/circle/` | Delegate to adapter |
| `circleBalanceService.js` | `services/circle/` | Ledger + reservation reads (adapter only) |
| `reconcileCircleLedger.js` | `jobs/` | Scheduled drift detection and correction |

HTTP entry points:

| File | Export |
|------|--------|
| `functions/http/cryptoApi.js` | `cryptoApi` |
| `functions/http/circleWebhookHttp.js` | `handleCircleWebhook` |

Extensions to existing services:

| File | Addition |
|------|----------|
| `walletService.js` | `getCryptoBalance()` / `getBalances()` via `ledgerService.getAvailableBalance()` |
| `paymentRailService.js` | `circle` rail, `processDeposit({ rail: "circle", payload })` → adapter |
| `triggers/usersTrigger.js` | Auto-provision Circle wallet via adapter on `users/{userId}` create |
| `utils/firestore.js` | USDC RTDB sync via `rtdbSyncService` (not direct RTDB writes) |

Existing IntaSend and TransFi code is untouched.

---

## User lifecycle

### 1. New user signup

When a document is created in `users/{userId}`, the `onUserCreated` trigger:

1. Initializes default fiat fields (`fiatBalance`, `cryptoBalance`, `phoneNumber`) — unchanged behavior.
2. If Circle is configured, calls `circleRailAdapter.createWallet(userId)`.
3. Stores the wallet in `cryptoWallets` with `provider: "circle"`, `asset: "USDC"`.
4. **Fails gracefully** — if Circle wallet creation errors, fiat wallet setup still succeeds.

### 2. Receive USDC (deposit)

1. User shares their deposit address from `GET /crypto/wallet`.
2. External wallet sends USDC on-chain to that address.
3. Circle confirms the transaction and POSTs a webhook to `handleCircleWebhook`.
4. Backend rejects stale events (>72h), acquires webhook lock, appends **ledger credit**, writes `cryptoTransactions` (type: `deposit`, status: `complete`), syncs RTDB via `rtdbSyncService`.

### 3. Send USDC (withdrawal) — async with reservations

1. User calls `POST /crypto/send` with `toAddress`, `amount`, and required `X-Idempotency-Key`.
2. Backend acquires send idempotency key (duplicate → cached response or `409`).
3. **`reservationService.reserveFunds()`** — holds funds in `pendingReservations` before calling Circle.
4. Calls Circle `createTransaction`, stores `cryptoTransactions` with `status: "pending"` and `reservationId`.
5. **Returns immediately** to the client — no polling.
6. On webhook **success**: ledger debit → `confirmReservation()` → transaction `complete`.
7. On webhook **failure**: `releaseReservation()` → transaction `failed` (no ledger debit).

---

## Consumer API

All endpoints require a Firebase ID token:

```http
Authorization: Bearer <firebase-id-token>
```

### `GET /crypto/wallet`

Returns the user's Circle deposit address and QR code data.

**Response**

```json
{
  "success": true,
  "data": {
    "address": "0x...",
    "chain": "BASE",
    "asset": "USDC",
    "walletId": "circle-wallet-uuid",
    "qrDataUrl": "data:image/png;base64,...",
    "qrPayload": "0x..."
  }
}
```

If no wallet exists yet and Circle is configured, one is created on demand.

### `GET /crypto/balance`

Returns **available** balance: `ledgerBalance - active reservations`. Never reads RTDB or `cryptoTransactions`.

**Response**

```json
{
  "success": true,
  "data": {
    "USDC": 12.5,
    "asset": "USDC"
  }
}
```

### `GET /crypto/transactions`

Query param: `limit` (default 50, max 100).

**Response**

```json
{
  "success": true,
  "data": {
    "transactions": [
      {
        "id": "firestore-doc-id",
        "type": "deposit",
        "amount": 5,
        "asset": "USDC",
        "status": "complete",
        "txHash": "0x...",
        "circleTransactionId": "...",
        "createdAt": "2026-06-07T12:00:00.000Z"
      }
    ]
  }
}
```

Send transactions may show `status: "pending"` until the outbound webhook confirms, or `failed` if Circle rejects the transfer.

### `POST /crypto/send`

**Body**

```json
{
  "toAddress": "0xRecipientAddress",
  "amount": 5
}
```

**Headers**

```http
X-Idempotency-Key: <uuid>   (required)
Authorization: Bearer <firebase-id-token>
```

**Response** (immediate — async completion via webhook)

```json
{
  "success": true,
  "data": {
    "success": true,
    "circleTransactionId": "...",
    "txHash": null,
    "status": "pending",
    "firestoreTxId": "...",
    "reservationId": "res_<uuid>",
    "amount": 5
  }
}
```

After the outbound webhook fires, `status` becomes `complete` and `txHash` is populated. Duplicate requests with the same idempotency key return the cached result.

**Rate limit:** 5 send requests per user per minute (in-memory per function instance).

**Errors:**

| Status | Condition |
|--------|-----------|
| `400` | Missing body fields, missing `X-Idempotency-Key`, insufficient balance |
| `401` | Missing/invalid auth |
| `404` | No crypto wallet |
| `409` | Duplicate send already in progress |
| `429` | Rate limit exceeded |

---

## Webhook

Circle delivers notifications to:

```text
POST https://us-central1-truepay-72060.cloudfunctions.net/handleCircleWebhook
```

### Verification

Every webhook includes:

| Header | Purpose |
|--------|---------|
| `X-Circle-Signature` | ECDSA signature of the raw JSON body |
| `X-Circle-Key-Id` | Public key ID — fetched from `GET /v2/notifications/publicKey/{keyId}` |

The handler rejects requests with invalid signatures (`403`).

### Replay protection

Events with `timestamp` older than **72 hours** are rejected immediately (marked stale, no processing). This prevents replay of ancient notifications.

### Processed event types

| Circle notification | Internal type | Ledger direction | Reservation |
|---------------------|---------------|------------------|-------------|
| `transactions.inbound` / `transfer.incoming` | `deposit` | `credit` | — |
| `transactions.outbound` / `transfer.outgoing` (complete) | `send` | `debit` | `confirmReservation()` |
| `transactions.outbound` (failed/cancelled/denied) | `send` | — | `releaseReservation()` |

Only `COMPLETE` / `CONFIRMED` transactions credit or debit the ledger. Failed outbound events release the reservation without a ledger entry.

### Idempotency gate (transaction-safe)

Webhook processing follows a strict lock order to survive Circle retries:

1. **Reject stale** — `timestamp` older than 72h → stop.
2. **Check** `webhookEvents/{notificationId}` — if doc exists, stop immediately (`duplicate: true`).
3. **Acquire lock** — create `webhookEvents` doc in a Firestore transaction (`processed: false`).
4. **Process** — append ledger entry (if not `hasLedgerEntry`), confirm/release reservation, update `cryptoTransactions`, sync RTDB.
5. **Mark** `processed: true`.

Additional dedup layers:

- Ledger doc id `cl_{circleTransactionId}` — duplicate appends are no-ops.
- `sendIdempotencyKeys` maps 1:1 with Circle transaction id.
- `cryptoTransactions` updated by `circleTransactionId` if a pending send already exists.

Register the webhook URL in [Circle Console](https://console.circle.com/) and subscribe to inbound/outbound transaction events.

---

## Reconciliation job

`reconcileCircleLedger` runs on schedule **`0 */6 * * *`** (every 6 hours).

For each `cryptoWallets` document:

1. Fetch Circle on-chain USDC balance via API.
2. Fetch `ledgerService.getLedgerBalance(userId, "USDC")`.
3. If drift detected, append a `reconciliation_adjustment` ledger entry (credit or debit).
4. Log the discrepancy.

Adjustments are idempotent per 6-hour bucket: reference id `recon_{userId}_{bucket}_{balanceCents}`. Safe to run multiple times without double-correcting.

---

## Firestore collections

### `cryptoLedger` (source of truth)

Append-only immutable entries. Balances are never updated directly — only derived.

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Doc id: `cl_{referenceId}` |
| `userId` | string | Owner |
| `type` | string | `deposit`, `send`, or `reconciliation_adjustment` |
| `asset` | string | `"USDC"` |
| `amount` | number | Positive amount |
| `direction` | string | `"credit"` or `"debit"` |
| `source` | string | `"circle"` or `"reconciliation"` |
| `referenceId` | string | Circle transaction id or reconciliation key |
| `createdAt` | timestamp | |

### `pendingReservations`

Doc id: `res_{requestId}` (requestId = `X-Idempotency-Key`).

| Field | Type | Description |
|-------|------|-------------|
| `userId` | string | Owner |
| `amount` | number | Reserved USDC |
| `status` | string | `reserved`, `confirmed`, or `released` |
| `requestId` | string | Idempotency key |
| `circleTransactionId` | string | Set after Circle accepts the send |
| `createdAt` | timestamp | |
| `confirmedAt` | timestamp | After webhook success |
| `releasedAt` | timestamp | After failure or cancel |

### `walletAggregates` (read cache)

Doc id = `userId`. Updated only by `ledgerService` on append.

| Field | Type | Description |
|-------|------|-------------|
| `userId` | string | Firebase Auth UID |
| `USDC` | number | Settled ledger balance (excludes reservations) |
| `updatedAt` | timestamp | |

### `cryptoWallets`

| Field | Type | Description |
|-------|------|-------------|
| `userId` | string | Firebase Auth UID |
| `provider` | string | Always `"circle"` |
| `walletId` | string | Circle wallet UUID |
| `address` | string | On-chain deposit address |
| `addressLower` | string | Lowercase address for lookups |
| `chain` | string | `"BASE"` or `"POLYGON"` |
| `blockchain` | string | Circle blockchain id (e.g. `BASE-SEPOLIA`) |
| `asset` | string | `"USDC"` |
| `status` | string | e.g. `"live"` |
| `createdAt` | timestamp | |
| `updatedAt` | timestamp | |

> **Note:** `cryptoWallets` does **not** store a balance field.

### `cryptoTransactions` (audit log only)

| Field | Type | Description |
|-------|------|-------------|
| `userId` | string | Owner |
| `circleTransactionId` | string | Circle tx id |
| `txHash` | string | On-chain hash (null while pending) |
| `type` | string | `"deposit"` or `"send"` |
| `amount` | number | USDC amount |
| `asset` | string | `"USDC"` |
| `status` | string | `pending`, `complete`, or `failed` |
| `toAddress` | string | Destination (sends) |
| `fromWalletId` | string | Circle wallet id |
| `idempotencyKey` | string | Send idempotency key (sends only) |
| `reservationId` | string | Link to `pendingReservations` (sends only) |
| `provider` | string | `"circle"` |
| `createdAt` | timestamp | |
| `updatedAt` | timestamp | |

### `webhookEvents`

| Field | Type | Description |
|-------|------|-------------|
| `eventId` | string | Circle `notificationId` (doc id) |
| `provider` | string | `"circle"` |
| `processed` | boolean | `false` = lock held; `true` = done |
| `stale` | boolean | `true` if rejected for age >72h |
| `payloadHash` | string | SHA-256 of raw body |
| `notificationType` | string | |
| `createdAt` | timestamp | |
| `processedAt` | timestamp | |

### `sendIdempotencyKeys`

| Field | Type | Description |
|-------|------|-------------|
| `key` | string | Client `X-Idempotency-Key` (doc id) |
| `userId` | string | Requesting user |
| `requestData` | object | Send parameters |
| `circleTransactionId` | string | 1:1 mapping to Circle tx |
| `result` | object | Cached response (after initiation) |
| `createdAt` | timestamp | |
| `expiresAt` | timestamp | 24h TTL |

---

## Realtime Database (Flutter)

USDC is projected to RTDB **only** via `rtdbSyncService.syncToRTDB()` after ledger updates:

```text
wallet/{userId}/crypto/USDC
```

**Rule:** No direct `admin.database().ref().set()` for USDC outside `rtdbSyncService.js`.

RTDB is a read-only cache. The Flutter app may listen here for live updates, but the backend never reads RTDB to compute balances.

Fiat balances remain at `wallet/{userId}/fiat/{currency}`. The general balance sync in `utils/firestore.js` reads `walletAggregates` and delegates USDC writes to `rtdbSyncService`.

---

## Configuration

### Required secrets

Set via Firebase Functions secrets (never expose to the frontend):

```bash
firebase functions:secrets:set CIRCLE_API_KEY
firebase functions:secrets:set CIRCLE_ENTITY_SECRET
```

Obtain credentials from [Circle Console](https://console.circle.com/):

1. Create an API key.
2. Generate and register an entity secret.

### Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CIRCLE_API_KEY` | Yes | — | Circle API key |
| `CIRCLE_ENTITY_SECRET` | Yes | — | Registered entity secret |
| `CIRCLE_ENV` | No | `sandbox` | `sandbox` or `prod` |
| `CIRCLE_WALLET_SET_ID` | No | auto-created | Shared wallet set for all users |
| `CIRCLE_BLOCKCHAIN` | No | `BASE-SEPOLIA` (sandbox), `BASE` (prod) | Circle blockchain identifier |
| `CIRCLE_USDC_TOKEN_ID` | No | — | Token id for outbound transfers |
| `CIRCLE_API_BASE_URL` | No | `https://api.circle.com` | API host override |

### Functions that bind Circle secrets

| Function | Secrets |
|----------|---------|
| `cryptoApi` | `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET` |
| `handleCircleWebhook` | `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET` |
| `onUserCreated` | `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET` |
| `reconcileCircleLedger` | `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET` |

---

## Firestore indexes

Create composite indexes before production traffic:

| Collection | Fields |
|------------|--------|
| `cryptoWallets` | `userId` ASC, `provider` ASC |
| `cryptoWallets` | `addressLower` ASC, `provider` ASC |
| `cryptoTransactions` | `userId` ASC, `createdAt` DESC |
| `cryptoTransactions` | `circleTransactionId` ASC |
| `cryptoLedger` | `userId` ASC, `asset` ASC |
| `pendingReservations` | `userId` ASC, `status` ASC |

Firebase will log index-creation links on first query failure if any are missing.

---

## Aggregated balances (`walletService`)

`getBalances(userId)` returns:

```json
{
  "fiat": { "USD": 0, "KES": 0, "USDT": 0 },
  "crypto": { "USDC": 12.5 }
}
```

`getCryptoBalance(userId)` calls `ledgerService.getAvailableBalance(userId, "USDC")` — ledger minus active reservations. Never reads RTDB, `cryptoTransactions`, or `cryptoWallets`.

| Function | Returns |
|----------|---------|
| `ledgerService.getLedgerBalance()` | Settled balance from ledger |
| `ledgerService.getAvailableBalance()` | Spendable balance (ledger − reservations) |
| `ledgerService.rebuildBalanceFromLedger()` | Recompute aggregate from append-only ledger |

---

## Security

- Circle API keys and entity secrets are server-side only (Firebase secrets).
- All Circle operations route through `circleRailAdapter` — no scattered API calls.
- Webhook signatures verified on every request (ECDSA + Circle public key).
- Webhook replay protection: events older than 72 hours are rejected.
- Webhook processing uses a Firestore transaction lock before any business logic.
- Send operations require `X-Idempotency-Key`; duplicates return cached results or `409`.
- **Reservations** hold funds before Circle API calls — prevents double-spend on concurrent sends.
- Ledger entries are append-only and idempotent by `referenceId` (Circle transaction id).
- `cryptoTransactions` is audit/UI only — never used for balance computation.
- All USDC RTDB writes go through `rtdbSyncService` — no direct RTDB balance writes.
- Reconciliation job detects and corrects ledger drift against Circle on-chain balances.
- `txHash` and `userId` are logged for audit; no private keys are stored or handled.

---

## Deployment

```bash
cd functions
npm install
firebase functions:secrets:set CIRCLE_API_KEY
firebase functions:secrets:set CIRCLE_ENTITY_SECRET
npm run deploy
```

Register the webhook URL in Circle Console after deploy. The `reconcileCircleLedger` scheduled function deploys automatically with `npm run deploy`.

### Sandbox testing

1. Set `CIRCLE_ENV=sandbox` and `CIRCLE_BLOCKCHAIN=BASE-SEPOLIA` (or your testnet).
2. Fund a test wallet via the [Circle Faucet](https://faucet.circle.com/).
3. Create a test user — `onUserCreated` provisions a Circle wallet automatically.
4. Call `GET /crypto/wallet` to get the deposit address.
5. Send testnet USDC from an external wallet.
6. Confirm webhook delivery → `cryptoLedger` credit → `walletAggregates` update → RTDB cache.
7. Call `POST /crypto/send` with `X-Idempotency-Key` — verify `pendingReservations` created, immediate `pending` response, then webhook completes debit and confirms reservation.
8. Retry the same idempotency key — verify cached response, no double send.

---

## Acceptance criteria

| # | Criterion | How |
|---|-----------|-----|
| 1 | New user gets a Circle wallet | `onUserCreated` → adapter → `cryptoWallets` doc |
| 2 | Backend returns USDC address | `GET /crypto/wallet` |
| 3 | External deposit detected | Webhook → ledger credit → `cryptoTransactions` |
| 4 | Tx in Firestore + RTDB | `cryptoLedger` + `walletAggregates` + `rtdbSyncService` |
| 5 | Flutter shows updated balance | RTDB listener on `crypto/USDC` (cache, not source) |
| 6 | User can send USDC out | Reserve → send → pending → webhook debit |
| 7 | Duplicate webhooks safe | 72h replay guard + `webhookEvents` lock + ledger idempotency |
| 8 | Balances survive restarts | Ledger + aggregates + reservations in Firestore |
| 9 | Double send prevented | `pendingReservations` + idempotency keys |
| 10 | Drift corrected | `reconcileCircleLedger` every 6h |

---

## Related docs

- [Circle Developer-Controlled Wallets](https://developers.circle.com/wallets/dev-controlled)
- [Circle Webhook Notifications](https://developers.circle.com/wallets/webhook-notifications)
- [`README_HIGH_LEVEL.md`](./README_HIGH_LEVEL.md) — TruePay system overview
- [`BACKEND_ARCHITECTURE.md`](./BACKEND_ARCHITECTURE.md) — Service layer conventions
