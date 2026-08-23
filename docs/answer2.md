# TruePay Production Hardening — Implementation Plan

**Scope:** Reliability, resilience, observability, fault tolerance only. No new product features. No architecture rewrite. No breaking API changes.

**Approach:** Extend existing services (`fundingWebhookService`, `fundingOrderService`, `transactionService.completeFundingOrder`, `merchantSettlementService`, `fiatReservationService`, `utils/notifications.js`) rather than replacing them.

---

## Executive Summary

| Phase | Deliverable | Primary new artifact |
|-------|-------------|---------------------|
| 1 | Funding reconciliation job | `jobs/reconcileFundingOrders.js` |
| 2 | POST `/funding/orders` idempotency | `fundingRequestId` on orders |
| 3 | Durable webhook receipts | `webhookReceipts` collection |
| 4 | Reservation TTL + sweeper | `jobs/releaseExpiredReservations.js` |
| 5 | Daraja async completion | `handleDarajaCallback` + completion service |
| 6 | Settlement retry engine | `jobs/processSettlementRetries.js` |
| 7 | Settlement provider registry | Mirror funding provider pattern |
| 8 | Funding/settlement notifications | `fundingNotificationService.js` |
| 9 | Admin ops monitoring | Extend platform admin APIs |
| 10 | Docs + indexes | README, architecture, `firestore.indexes.json` |

---

## Cross-Cutting Foundations (applied across all phases)

### A. Structured logging helper

**New file:** `functions/utils/fundingLogger.js`

Wraps `console.log` / `console.warn` / `console.error` with a consistent JSON shape:

```javascript
{
  correlationId,
  fundingOrderId,
  userId,
  provider,
  providerReference,
  transactionRecordId,
  ledgerEntryId,
  settlementJobId,
  merchantPaymentId,
  reservationId,
  event: "funding.reconcile.completed",
  // ...
}
```

**Used by:** all new jobs, refactored webhook path, settlement processor.

**Correlation ID:** Generated in `fundingHttp` (`X-Correlation-Id` header or UUID) and passed through service calls via `metadata.correlationId`.

### B. Reconciliation metrics collection

**New collection:** `opsMetrics/{dateBucket}_{jobName}` (append-only counters, idempotent increment via transaction)

Stores: `ordersReconciled`, `ordersStillPending`, `failedVerifications`, `reservationsReleased`, `settlementsRetried`, `lastRunAt`.

Avoids dependency on external metrics stack while satisfying observability requirements.

### C. Status enum extensions (additive only)

Extend `functions/utils/fundingTypes.js`:

```javascript
FUNDING_STATUSES.payment_initialized: "payment_initialized"  // checkoutUrl set, awaiting payment
WEBHOOK_RECEIPT_STATUSES: received | processing | completed | failed
RESERVATION_STATUSES: reserved | confirmed | released | expired
SETTLEMENT_JOB_STATUSES: pending | processing | completed | failed | dead_letter
```

Existing clients reading `pending|processing|completed|failed` remain valid. New states are additive.

---

## Phase 1 — Funding Reconciliation

### Problem addressed
Missed/delayed Paystack webhooks leave orders stuck in non-terminal states after customer was charged.

### Design

**New file:** `functions/jobs/reconcileFundingOrders.js`  
**Export:** `reconcileFundingOrders` — `onSchedule`, cron `*/45 * * * *` (every 45 minutes)

**New file:** `functions/services/funding/fundingReconciliationService.js`  
Extracted logic (testable without scheduler):

```
runFundingReconciliation()
  → listStaleFundingOrders()
  → for each order:
      → fundingRailService.verifyPayment(order.provider, order.providerReference)
      → if success && order not completed:
           → fundingWebhookService.processFundingEvent({ provider, event: verified, webhookEventId: "recon_{orderId}_{bucket}" })
      → if failed && order still pending/processing past threshold:
           → fundingOrderService.updateFundingOrder(failed)
      → record metrics
```

**Query strategy (indexed, no full scan):**

```javascript
// Two queries merged in memory (Firestore `in` max 10 — use two calls)
status == "pending" AND createdAt < cutoff
status == "processing" AND updatedAt < cutoff
status == "payment_initialized" AND createdAt < cutoff
```

Treat `pending + checkoutUrl != null` as `payment_initialized` for recon even before enum migration (backward compatible mapping in service).

**Idempotency guarantees (no duplicate credits):**

| Layer | Mechanism |
|-------|-----------|
| Recon re-run | Same order → `completeFundingOrder` short-circuits if `status === completed` |
| Ledger | `fiatLedger` keyed by `referenceId = fund_{provider}_{txnId}` |
| Webhook dedup | Synthetic `webhookEventId = recon_{orderId}_{hourBucket}` stored in `webhookEvents` |

**Notification:** Phase 8 wires in; Phase 1 passes `source: "reconciliation"` in metadata so notifications can distinguish.

### Files

| Action | File |
|--------|------|
| **Create** | `jobs/reconcileFundingOrders.js` |
| **Create** | `services/funding/fundingReconciliationService.js` |
| **Modify** | `index.js` — export scheduled function |
| **Modify** | `config.js` — `collections.opsMetrics`, recon config (`staleMinutes: 30`) |
| **Modify** | `fundingOrderService.js` — `listStaleOrders({ statuses, olderThan })` |
| **Modify** | `firestore.indexes.json` — see Firestore section |
| **Create** | `test/funding/fundingReconciliation.test.js` |

### Backward compatibility
New scheduled function only. No API changes. Existing webhook path unchanged.

---

## Phase 2 — Funding Order Idempotency

### Problem addressed
Double-tap / network retry on `POST /funding/orders` creates duplicate orders.

### Design

**Schema extension** on `fundingOrders` (additive fields):

```javascript
{
  fundingRequestId: "uuid-from-client",  // from Idempotency-Key header
  idempotencyKey: "same value",          // alias for clarity in admin UI
}
```

**New function:** `fundingOrderService.findOpenOrderByIdempotency({ userId, provider, amount, currency, fundingRequestId })`

Query: matching `fundingRequestId` OR composite `(userId, provider, amount, currency, fundingRequestId)` where status NOT IN (`completed`, `failed`).

If found → return existing order + existing `checkoutUrl` (re-initialize Paystack session only if checkout expired — optional: verify with Paystack if `authorization_url` still valid; v1: return existing checkoutUrl).

If not found → create atomically using Firestore transaction on idempotency doc:

**New collection:** `fundingIdempotency/{hash}` — lock doc written before order creation (same pattern as Circle `sendIdempotencyKeys`).

```
hash = sha256(userId + provider + amount + currency + fundingRequestId)
```

Transaction: if lock exists and points to orderId → return that order; else create order + set lock.

**HTTP change** (`fundingHttp.js`):

```javascript
const fundingRequestId =
  req.get("Idempotency-Key") ||
  req.get("idempotency-key") ||
  body.fundingRequestId ||
  null;
```

If missing: generate server-side UUID and return it in response so Flutter can retry with same key.

**Response shape unchanged** — additive field `fundingRequestId` in response data.

### Files

| Action | File |
|--------|------|
| **Modify** | `http/fundingHttp.js` |
| **Modify** | `services/funding/fundingOrderService.js` |
| **Modify** | `utils/fundingTypes.js` |
| **Modify** | `config.js` — `collections.fundingIdempotency` |
| **Modify** | `firestore.indexes.json` |
| **Create** | `test/funding/fundingIdempotency.test.js` |

### Idempotency
Lock doc + open-order lookup. Duplicate POST returns `200/201` with same `fundingOrder.id`.

### Backward compatibility
Header optional. Clients not sending key get server-generated ID (new behavior, non-breaking). Existing response fields preserved.

---

## Phase 3 — Webhook Receipt Persistence

### Problem addressed
Webhook processed before durable receipt; crash mid-flight complicates replay.

### Design

**New collection:** `webhookReceipts/{receiptId}`

```javascript
{
  id: "wr_paystack_{eventId}",
  provider: "paystack",
  eventId: "...",
  providerReference: "...",
  headers: { /* sanitized */ },
  payload: { /* raw JSON */ },
  status: "received" | "processing" | "completed" | "failed",
  receivedAt,
  processingStartedAt,
  completedAt,
  failureReason,
  fundingOrderId,
  correlationId,
}
```

**New file:** `functions/services/funding/webhookReceiptService.js`

```
createReceipt(raw)           // status: received — Firestore create() fails if exists
markProcessing(receiptId)    // txn: received → processing
markCompleted(receiptId)     // processing → completed
markFailed(receiptId, err)   // → failed
findByEventId(provider, id)  // duplicate detection
```

**Refactored webhook flow** (`paystackWebhookHttp.js` + `fundingWebhookService.js`):

```
1. verifyWebhookSignature
2. parse payload
3. webhookReceiptService.createReceipt()  ← if duplicate doc exists → 200 OK immediately
4. markProcessing
5. normalizeWebhook → processFundingEvent (pass receiptId, not paystack_ webhookEvents prefix)
6. markCompleted | markFailed
```

Deprecate (but keep writing for transition) `webhookEvents/paystack_*` — dual-write during migration, then remove in future milestone.

**Replay:** Admin job or manual script reads `webhookReceipts` where `status === failed` and re-invokes `processFundingEvent` with stored payload.

### Files

| Action | File |
|--------|------|
| **Create** | `services/funding/webhookReceiptService.js` |
| **Modify** | `http/paystackWebhookHttp.js` |
| **Modify** | `services/funding/fundingWebhookService.js` |
| **Modify** | `config.js` — `collections.webhookReceipts` |
| **Modify** | `utils/fundingTypes.js` — receipt statuses |
| **Create** | `test/funding/webhookReceipt.test.js` |

### Idempotency
Receipt doc ID = deterministic from `(provider, eventId)`. `create()` on existing doc → duplicate webhook → early exit.

### Backward compatibility
Webhook URL and HTTP response codes unchanged. Paystack still gets `200 OK` on duplicates.

---

## Phase 4 — Reservation Expiration

### Problem addressed
`pendingFiatReservations` with `status: reserved` never expire if Daraja never completes.

### Design

**Schema extension** on `pendingFiatReservations`:

```javascript
{
  expiresAt: Timestamp,       // default: now + 30 minutes at reserve time
  attemptCount: 0,
  lastAttemptAt: null,
  reason: null,                // "expired" | "settlement_failed" | ...
}
```

**Modify:** `fiatReservationService.reserveFunds()` — set `expiresAt` from `config.funding.reservationTtlMinutes` (default 30).

**New function:** `fiatReservationService.expireReservation(requestId, reason)` — txn: `reserved → expired` (new status, distinct from `released`).

**New file:** `functions/jobs/releaseExpiredReservations.js`  
Schedule: `*/5 * * * *` (every 5 minutes)

**New file:** `functions/services/ledger/fiatReservationLifecycleService.js`

```
findExpiredReservations(limit = 100)
  → where status == reserved AND expiresAt < now
  → for each:
      → expireReservation (idempotent if already expired/released)
      → fundingNotificationService.reservationReleased (Phase 8)
      → log + metrics
```

Note: Expiring a reservation does **not** debit ledger — it only releases the hold. No balance change needed (reservations are logical, not ledger entries).

**Also expire on:** settlement failure (Phase 5/6) via explicit `releaseReservation` or `expireReservation`.

### Files

| Action | File |
|--------|------|
| **Create** | `jobs/releaseExpiredReservations.js` |
| **Create** | `services/ledger/fiatReservationLifecycleService.js` |
| **Modify** | `services/ledger/fiatReservationService.js` |
| **Modify** | `index.js` |
| **Modify** | `config.js` |
| **Modify** | `firestore.indexes.json` |
| **Create** | `test/ledger/fiatReservationExpiry.test.js` |

### Idempotency
`expireReservation` checks current status; no-op if already `released|expired|confirmed`.

---

## Phase 5 — Daraja Callback Completion

### Problem addressed
Live Daraja returns `processing` but no callback handler completes settlement or debits wallet.

### Design

**New file:** `functions/http/darajaCallbackHttp.js`  
**Export:** `handleDarajaCallback` — `onRequest`, POST from Safaricom ResultURL

**New file:** `functions/services/settlement/settlementCallbackService.js`

```
handleDarajaCallback(payload)
  → settlementProvider.normalizeCallback(payload)   // Phase 7
  → find settlementJob by providerReference (ConversationID)
  → idempotency: if job.status === completed → 200 OK
  → on success:
      → merchantSettlementService.completeMerchantPayment(...)
  → on failure:
      → mark settlementJob failed
      → releaseReservation
      → notify user (Phase 8)
```

**Modify:** `merchantSettlementService.initiateMerchantPayment` — when NOT stub, return `processing` and do **not** call `completeMerchantPayment` (already correct).

**Timeout handling:** Phase 6 retry job picks up jobs in `processing` past `timeoutAt`.

**Duplicate callbacks:** Idempotent via `settlementJobs.status` terminal guard + debit `referenceId = mp_debit_{requestId}`.

### Files

| Action | File |
|--------|------|
| **Create** | `http/darajaCallbackHttp.js` |
| **Create** | `services/settlement/settlementCallbackService.js` |
| **Modify** | `services/settlement/merchantSettlementService.js` — expose `findSettlementJobByReference`, fix duplicate reservation short-circuit |
| **Modify** | `index.js` |
| **Modify** | `config.js` — callback URL env docs |
| **Create** | `test/settlement/darajaCallback.test.js` |

### Backward compatibility
Stub mode unchanged (still auto-completes). New HTTP function is additive. No changes to `POST /funding/merchant-payments` request/response shape.

---

## Phase 6 — Settlement Retry Engine

### Problem addressed
Daraja initiate failures and timeouts have no retry or dead-letter path.

### Design

**Schema extension** on `settlementJobs`:

```javascript
{
  status: "pending" | "processing" | "completed" | "failed" | "dead_letter",
  retryCount: 0,
  maxRetries: 6,
  nextRetryAt: Timestamp,
  lastError: null,
  timeoutAt: Timestamp,          // processing timeout
  backoffScheduleMs: [60000, 300000, 900000, 3600000, 21600000],
}
```

**New file:** `functions/services/settlement/settlementJobProcessor.js`

```
processRetryQueue()
  → query settlementJobs where status IN (pending, processing)
     AND (nextRetryAt <= now OR timeoutAt <= now)
     AND retryCount < maxRetries
  → settlementProvider.initializeSettlement() OR verifySettlement()
  → on success → settlementCallbackService.complete(...)
  → on retriable failure → increment retryCount, set nextRetryAt (exponential backoff)
  → on max retries → status = dead_letter, release reservation, admin alert
```

**New file:** `functions/jobs/processSettlementRetries.js`  
Schedule: `*/2 * * * *` (every 2 minutes)

**Idempotency:** Each retry uses same `settlementJobId` and same debit `referenceId`. `completeMerchantPayment` guarded by job status + ledger referenceId.

### Files

| Action | File |
|--------|------|
| **Create** | `services/settlement/settlementJobProcessor.js` |
| **Create** | `jobs/processSettlementRetries.js` |
| **Modify** | `services/settlement/merchantSettlementService.js` — set `nextRetryAt`, `timeoutAt` on create |
| **Modify** | `utils/fundingTypes.js` — `dead_letter` status |
| **Modify** | `index.js` |
| **Create** | `test/settlement/settlementRetry.test.js` |

---

## Phase 7 — Settlement Provider Abstraction

### Problem addressed
Daraja is if/else in `paymentRailService.resolveSettlementRail`. Not swappable.

### Design

Mirror funding pattern exactly:

**New files:**
```
services/settlement/settlementProviderInterface.js   // assertSettlementProvider, registerSettlementProviders
services/settlement/settlementRailService.js         // resolveProvider, initializeSettlement, verifySettlement, handleCallback
services/settlement/darajaSettlementProvider.js      // move logic from funding/darajaRail.js
```

**Required methods:**

```javascript
providerId: string
initializeSettlement(params)    // was initiateB2BPayment
verifySettlement(reference)     // was queryPaymentStatus
handleCallback(payload)         // normalize Daraja Result body
cancelSettlement(reference)     // stub/no-op for Daraja v1
normalizeResponse(raw)          // internal status mapping
verifyCallbackSignature(req)    // if applicable
```

**Modify:** `merchantSettlementService` — replace `paymentRailService.resolveSettlementRail()` with `settlementRailService.resolveProvider()`.

**Modify:** `paymentRailService.js` — keep `resolveSettlementRail` as thin deprecated re-export to `settlementRailService` (zero break for any external import).

**Delete (after move):** `services/funding/darajaRail.js` → content lives in settlement provider.

### Files

| Action | File |
|--------|------|
| **Create** | `settlementProviderInterface.js`, `settlementRailService.js`, `darajaSettlementProvider.js` |
| **Modify** | `merchantSettlementService.js`, `settlementCallbackService.js`, `settlementJobProcessor.js` |
| **Modify** | `paymentRailService.js` — delegate only |
| **Delete** | `services/funding/darajaRail.js` (after migration) |
| **Modify** | `test/funding/darajaRail.test.js` → move to `test/settlement/` |

### Backward compatibility
`paymentRailService.resolveSettlementRail()` remains exported. Internal routing changes only.

---

## Phase 8 — Funding Notifications

### Problem addressed
No user/admin notification on funding or settlement events (unlike IntaSend path).

### Design

**New file:** `functions/services/funding/fundingNotificationService.js`

Thin wrapper over `utils/notifications.js` — **not** called from `walletService`:

```javascript
notifyFundingCompleted({ userId, fundingOrderId, amount, currency, correlationId })
notifyFundingFailed({ userId, fundingOrderId, reason })
notifySettlementCompleted({ userId, merchantPaymentId, amountKes })
notifySettlementFailed({ userId, merchantPaymentId, reason })
notifyReservationReleased({ userId, amount, reason })
notifyAdminReconciliationSummary(metrics)  // optional system alert
```

**Extend** `NOTIFICATION_TYPES` in `utils/notifications.js` (additive):

```javascript
FUNDING_COMPLETED: "funding_completed",
FUNDING_FAILED: "funding_failed",
SETTLEMENT_COMPLETED: "settlement_completed",
SETTLEMENT_FAILED: "settlement_failed",
RESERVATION_RELEASED: "reservation_released",
```

**Injection points (after successful txn, never inside ledger):**

| Event | Call site |
|-------|-----------|
| Funding completed | end of `transactionService.completeFundingOrder` |
| Funding failed | `fundingWebhookService.processFundingEvent` failure branch |
| Settlement completed | `merchantSettlementService.finalizeMerchantPayment` |
| Settlement failed | `settlementCallbackService`, `settlementJobProcessor` dead_letter |
| Reservation released | `fiatReservationLifecycleService.expireReservation` |

All wrapped in try/catch — notification failure must not fail financial operation (same as IntaSend).

### Files

| Action | File |
|--------|------|
| **Create** | `services/funding/fundingNotificationService.js` |
| **Modify** | `utils/notifications.js` |
| **Modify** | `transactionService.js`, `fundingWebhookService.js`, `merchantSettlementService.js`, `fiatReservationLifecycleService.js`, `fundingReconciliationService.js` |

---

## Phase 9 — Admin Operations Monitoring

### Problem addressed
No ops visibility into stuck funding, failed settlements, webhook failures.

### Design

**New file:** `functions/services/ops/fundingOpsService.js`

```javascript
getFundingOpsDashboard()
  → {
      fundingOrders: { pending, processing, stuck, completedToday, failedToday },
      reservations: { active, expiredToday, releasedToday },
      settlements: { processing, failed, deadLetter, retryQueue },
      webhooks: { failedReceipts, pendingReceipts },
      reconciliation: { lastRun, ordersReconciled },
    }
```

**Queries:** Use indexed status + timestamp queries with limits (no full scans). "Stuck" = non-terminal AND `updatedAt < now - staleMinutes`.

**Expose via existing admin surfaces (pick both for flexibility):**

1. **B2B platform admin** — `GET /platform/funding-ops` in `b2bPortalHttp.js` (alongside `/platform/overview`)
2. **Admin callable** — `getFundingOpsDashboard` in `adminHttp.js` (platform admin claim)

**New collection (optional):** `reconciliationReports/{runId}` — append-only log from Phase 1 job for admin UI history.

**Modify:** `platformConsumerService.getPlatformOverviewCounts()` — add funding counts to existing overview (additive fields only).

### Files

| Action | File |
|--------|------|
| **Create** | `services/ops/fundingOpsService.js` |
| **Modify** | `http/b2bPortalHttp.js` — `GET /platform/funding-ops` |
| **Modify** | `http/adminHttp.js` — callable `getFundingOpsDashboard` |
| **Modify** | `services/platformConsumerService.js` — optional count extension |
| **Modify** | `index.js` — export callable if new |
| **Create** | `test/ops/fundingOps.test.js` |

### Backward compatibility
New endpoints only. `/platform/overview` response extended with optional nested `fundingOps` object (clients ignoring unknown fields unaffected).

---

## Firestore Indexes Required

Add to `firestore.indexes.json`:

```json
{ "collectionGroup": "fundingOrders", "fields": [
  {"fieldPath": "provider", "order": "ASCENDING"},
  {"fieldPath": "providerReference", "order": "ASCENDING"} ]},
{ "collectionGroup": "fundingOrders", "fields": [
  {"fieldPath": "status", "order": "ASCENDING"},
  {"fieldPath": "createdAt", "order": "ASCENDING"} ]},
{ "collectionGroup": "fundingOrders", "fields": [
  {"fieldPath": "status", "order": "ASCENDING"},
  {"fieldPath": "updatedAt", "order": "ASCENDING"} ]},
{ "collectionGroup": "fundingOrders", "fields": [
  {"fieldPath": "userId", "order": "ASCENDING"},
  {"fieldPath": "fundingRequestId", "order": "ASCENDING"} ]},
{ "collectionGroup": "fundingOrders", "fields": [
  {"fieldPath": "userId", "order": "ASCENDING"},
  {"fieldPath": "createdAt", "order": "DESCENDING"} ]},
{ "collectionGroup": "webhookReceipts", "fields": [
  {"fieldPath": "provider", "order": "ASCENDING"},
  {"fieldPath": "eventId", "order": "ASCENDING"} ]},
{ "collectionGroup": "webhookReceipts", "fields": [
  {"fieldPath": "status", "order": "ASCENDING"},
  {"fieldPath": "receivedAt", "order": "ASCENDING"} ]},
{ "collectionGroup": "pendingFiatReservations", "fields": [
  {"fieldPath": "status", "order": "ASCENDING"},
  {"fieldPath": "expiresAt", "order": "ASCENDING"} ]},
{ "collectionGroup": "settlementJobs", "fields": [
  {"fieldPath": "status", "order": "ASCENDING"},
  {"fieldPath": "nextRetryAt", "order": "ASCENDING"} ]},
{ "collectionGroup": "settlementJobs", "fields": [
  {"fieldPath": "providerReference", "order": "ASCENDING"} ]}
```

Document in `functions/BACKEND_ARCHITECTURE.md` with deploy command: `firebase deploy --only firestore:indexes`.

---

## Testing Plan

| Test file | Covers |
|-----------|--------|
| `test/funding/fundingReconciliation.test.js` | Stale order → verify → complete; idempotent re-run |
| `test/funding/fundingIdempotency.test.js` | Duplicate Idempotency-Key → same order |
| `test/funding/webhookReceipt.test.js` | Receipt before process; duplicate delivery |
| `test/funding/webhookReplay.test.js` | Failed receipt replay |
| `test/ledger/fiatReservationExpiry.test.js` | Expired reservation released |
| `test/settlement/darajaCallback.test.js` | Success/failure/duplicate callback |
| `test/settlement/settlementRetry.test.js` | Backoff, dead_letter, no duplicate debit |
| `test/settlement/settlementProvider.test.js` | Registry resolves Daraja |
| `test/ops/fundingOps.test.js` | Dashboard aggregation mocks |

All existing tests (`paystackRail`, `darajaRail`) must pass after Daraja move (Phase 7).

---

## Documentation Updates (Phase 10)

| Document | Additions |
|----------|-----------|
| `README_HIGH_LEVEL.md` | Reconciliation jobs, idempotency, webhook receipts, settlement lifecycle |
| `functions/BACKEND_ARCHITECTURE.md` | Funding/settlement state machines, provider registries, ops collections |
| `api.md` | `Idempotency-Key` header on `POST /funding/orders`; admin ops endpoints |
| `firestore.indexes.json` | All new indexes |
| New: `FUNDING_OPS.md` | Runbooks: stuck orders, dead-letter settlements, webhook replay |

**Architecture diagrams to add (Mermaid in docs):**

1. Funding lifecycle (including recon path)
2. Webhook receipt flow
3. Settlement lifecycle (initiate → callback → retry → dead_letter)
4. Reservation lifecycle (reserve → confirm | expire | release)
5. Provider architecture (funding + settlement registries side by side)

---

## Complete File Inventory

### New files (22)

```
functions/jobs/reconcileFundingOrders.js
functions/jobs/releaseExpiredReservations.js
functions/jobs/processSettlementRetries.js
functions/services/funding/fundingReconciliationService.js
functions/services/funding/webhookReceiptService.js
functions/services/funding/fundingNotificationService.js
functions/services/ledger/fiatReservationLifecycleService.js
functions/services/settlement/settlementProviderInterface.js
functions/services/settlement/settlementRailService.js
functions/services/settlement/darajaSettlementProvider.js
functions/services/settlement/settlementCallbackService.js
functions/services/settlement/settlementJobProcessor.js
functions/services/ops/fundingOpsService.js
functions/http/darajaCallbackHttp.js
functions/utils/fundingLogger.js
functions/test/funding/fundingReconciliation.test.js
functions/test/funding/fundingIdempotency.test.js
functions/test/funding/webhookReceipt.test.js
functions/test/funding/webhookReplay.test.js
functions/test/ledger/fiatReservationExpiry.test.js
functions/test/settlement/darajaCallback.test.js
functions/test/settlement/settlementRetry.test.js
FUNDING_OPS.md
```

### Modified files (18)

```
functions/index.js
functions/config.js
functions/utils/fundingTypes.js
functions/utils/notifications.js
functions/http/fundingHttp.js
functions/http/paystackWebhookHttp.js
functions/http/customerWalletsHttp.js          (CORS: allow Idempotency-Key header)
functions/http/b2bPortalHttp.js
functions/http/adminHttp.js
functions/services/funding/fundingOrderService.js
functions/services/funding/fundingWebhookService.js
functions/services/transactionService.js
functions/services/settlement/merchantSettlementService.js
functions/services/ledger/fiatReservationService.js
functions/services/paymentRailService.js
functions/services/platformConsumerService.js
firestore.indexes.json
README_HIGH_LEVEL.md
functions/BACKEND_ARCHITECTURE.md
api.md
```

### Deleted files (1, Phase 7 only)

```
functions/services/funding/darajaRail.js  → moved to settlement provider
```

### Untouched (explicit guarantee)

```
functions/libs/payments.js
functions/http/webhookApi.js
functions/http/paymentsHttp.js
functions/http/cryptoApi.js
functions/http/circleWebhookHttp.js
functions/http/partnerApi.js
functions/http/partnerSandboxHttp.js
functions/http/b2bPortalHttp.js (except additive /platform/funding-ops route)
functions/services/circle/*
All existing Flutter-facing callable signatures
```

---

## Commit Plan (10 logical commits)

| # | Commit message | Phases |
|---|----------------|--------|
| 1 | `feat: add funding reconciliation scheduled job` | 1 |
| 2 | `feat: add funding order idempotency key support` | 2 |
| 3 | `feat: persist webhook receipts before processing` | 3 |
| 4 | `feat: reservation TTL and expired reservation sweeper` | 4 |
| 5 | `feat: Daraja callback handler and settlement completion` | 5 |
| 6 | `feat: settlement retry engine with dead-letter state` | 6 |
| 7 | `refactor: settlement provider registry mirroring funding` | 7 |
| 8 | `feat: funding and settlement notifications` | 8 |
| 9 | `feat: admin funding ops monitoring endpoints` | 9 |
| 10 | `docs: production hardening architecture and indexes` | 10 |

Each commit is independently deployable. Phases 1–3 can ship first for highest ROI (webhook recovery + idempotency).

---

## Backward Compatibility Summary

| Area | Guarantee |
|------|-----------|
| All existing REST/callable routes | Unchanged signatures |
| `POST /funding/orders` | Additive `Idempotency-Key` header (optional); response adds `fundingRequestId` |
| Funding order statuses | Existing 4 states preserved; `payment_initialized` additive |
| Paystack webhook URL | Same function name `handlePaystackWebhook` |
| IntaSend / Circle / B2B | Zero modifications |
| Firestore existing docs | New fields optional; no migrations required |
| `paymentRailService` exports | All preserved; settlement routing delegates internally |

---

## Idempotency Summary (every balance-affecting operation)

| Operation | Key |
|-----------|-----|
| Funding credit | `fiatLedger/fl_fund_{provider}_{txnId}` |
| Funding recon | `webhookEvents/recon_{orderId}_{bucket}` + order terminal status |
| Idempotent order create | `fundingIdempotency/{hash}` |
| Webhook receipt | `webhookReceipts/wr_{provider}_{eventId}` |
| Merchant debit | `fiatLedger/fl_mp_debit_{requestId}` |
| Settlement job complete | `settlementJobs.status` terminal guard |
| Reservation expire | Status transition `reserved → expired` only once |
| Retry processor | Same `settlementJobId`; no new debit reference |

---

## Success Criteria Mapping

| Requirement | Phase |
|-------------|-------|
| Recovery from missed webhooks | 1 + 3 |
| Safe retries | 2 + 6 |
| Strong idempotency | 2 + 3 + all ledger keys |
| Automatic reconciliation | 1 |
| Reservation lifecycle | 4 |
| Settlement retry/recovery | 5 + 6 |
| Provider abstraction (both rails) | 7 (funding exists; settlement added) |
| Operational visibility | 9 |
| Zero breaking changes | All phases |

---

This plan is ready for implementation. Confirm approval (or adjustments to schedule frequencies, reservation TTL defaults, or admin endpoint placement) and implementation can begin with **Commit 1: Funding reconciliation**.
