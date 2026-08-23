# Architecture Verification Audit

No code was modified for this review. Findings below are based on the current implementation in the repo.

---

# 1. Paystack Isolation

## Does `walletService` import or call Paystack anywhere?

**NO.**

**Why:** `walletService.js` imports `fiatLedgerService`, `fiatReservationService`, and `circleRailAdapter` (pre-existing crypto path). It has no Paystack import and no HTTP calls.

**Files:** `functions/services/walletService.js`

**Functions:** `creditUserFiat`, `debitUserFiat`, `getFiatAvailableBalance`, `dualWriteUsdBalance` — none reference Paystack.

```javascript
// functions/services/walletService.js
async function creditUserFiat(userId, amount, currency = "USD", options = {}) {
  // ...
  const ledgerResult = await fiatLedgerService.appendTransaction({
    userId,
    type: options.type || "funding",
    asset,
    amount: numericAmount,
    direction: "credit",
    source: options.source || "funding",
    referenceId,
    fundingOrderId: options.fundingOrderId || null,
    transactionRecordId: options.transactionRecordId || null,
    metadata: options.metadata || {},
  });
```

---

## Does `transactionService` import or call Paystack anywhere?

**NO** (directly).

**Why:** It imports `fundingOrderService` and `FUNDING_STATUSES`, not `paystackRail`. Provider name appears only as opaque string metadata (`fundingOrder.provider`).

**Files:** `functions/services/transactionService.js`

**Functions:** `completeFundingOrder` — orchestrates order update, transaction record, wallet credit.

```javascript
// functions/services/transactionService.js
async function completeFundingOrder(params) {
  const { fundingOrder, verifiedEvent } = params;
  // ...
  await fundingOrderService.updateFundingOrder(fundingOrder.id, {
    status: FUNDING_STATUSES.processing,
    providerTransactionId: verifiedEvent.providerTransactionId || fundingOrder.providerTransactionId,
  });
  // ...
  const creditResult = await walletService.creditUserFiat(
      fundingOrder.userId,
      fundingOrder.amount,
      fundingOrder.currency,
      {
        referenceId,
        type: "funding",
        source: fundingOrder.provider,
        fundingOrderId: fundingOrder.id,
        // ...
      },
  );
```

**Caveat:** `transactionService` now depends on `fundingOrderService`, which is funding-domain coupling, but not Paystack coupling.

---

## Does `merchantSettlementService` import or call Paystack anywhere?

**NO.**

**Why:** Comment and imports confirm funding-provider isolation. It uses `walletService`, `rateService`, `fiatReservationService`, `paymentRailService.resolveSettlementRail()`, and `merchantDirectoryService`.

**Files:** `functions/services/settlement/merchantSettlementService.js`

---

## Does any controller communicate directly with Paystack?

**NO** (direct HTTP to Paystack from controllers).

**Why:** Controllers delegate to `fundingRailService` or `fundingWebhookService`.

**However — partial violation of ideal isolation:**

| File | Issue |
|------|--------|
| `functions/http/fundingHttp.js` | Hardcodes `provider !== FUNDING_PROVIDERS.paystack` gate |
| `functions/http/paystackWebhookHttp.js` | Hardcodes `FUNDING_PROVIDERS.paystack` as provider constant |
| `functions/services/funding/fundingWebhookService.js` | Hardcodes `paystack_` prefix in webhook dedup keys |

Controllers do not call Paystack APIs directly, but Paystack is named in HTTP layer logic, not only in `paystackRail`.

```javascript
// functions/http/fundingHttp.js
if (provider !== FUNDING_PROVIDERS.paystack) {
  res.status(400).json({ success: false, error: `Provider not yet enabled: ${provider}` });
  return;
}
```

```javascript
// functions/http/paystackWebhookHttp.js
const provider = FUNDING_PROVIDERS.paystack;
const signatureOk = fundingRailService.verifyWebhookSignature(provider, req, rawBody);
```

---

## Is Paystack only accessed through `paystackRail`?

**NO** — not strictly.

Paystack API calls (`axios.post`/`axios.get` to `api.paystack.co`) exist only in `paystackRail.js`. But Paystack is referenced in 13 files total:

| File | Role |
|------|------|
| `functions/services/funding/paystackRail.js` | **Only file with Paystack HTTP API calls** |
| `functions/services/funding/fundingRailService.js` | Registry; delegates to `paystackRail` |
| `functions/http/paystackWebhookHttp.js` | Thin webhook handler |
| `functions/services/funding/fundingWebhookService.js` | Orchestration; Paystack-specific webhook doc IDs |
| `functions/http/fundingHttp.js` | REST routes; Paystack-only provider gate |
| `functions/http/customerWalletsHttp.js` | Comment only |
| `functions/index.js` | Export `handlePaystackWebhook` |
| `functions/config.js` | Secrets/config |
| `functions/utils/fundingTypes.js` | Enum |
| `functions/services/funding/fundingProviderInterface.js` | Comment |
| `functions/services/settlement/merchantSettlementService.js` | Comment ("never references Paystack") |
| `functions/test/funding/paystackRail.test.js` | Tests |
| `functions/test/funding/fundingOrderService.test.js` | Test string reference |

**Ideal set was:** `paystackRail`, `handlePaystackWebhook`, `fundingRailService`.

**Actual set adds:** `fundingHttp`, `fundingWebhookService`, `config`, `fundingTypes`, `index`, tests.

**What should change (recommendation, not implemented):**
- Rename `handlePaystackWebhook` → generic `handleFundingWebhook` with provider route param, or keep separate handlers that only pass `provider` string.
- Remove `paystack_` hardcoding from `fundingWebhookService.isWebhookDuplicate` / `recordWebhookEvent`.
- Remove `if (provider !== paystack)` from `fundingHttp`; use `fundingRailService.listProviders()` or registry lookup instead.

---

# 2. Funding Provider Abstraction

## Is there a FundingProvider interface?

**YES** — as a **runtime-validated contract**, not a TypeScript interface or abstract class.

**File:** `functions/services/funding/fundingProviderInterface.js`

**Mandatory methods:**

```javascript
const REQUIRED_METHODS = Object.freeze([
  "initializePayment",
  "verifyPayment",
  "normalizeWebhook",
  "verifyWebhookSignature",
]);
```

**Optional (documented only, not enforced):** `refundPayment`

**Also required at runtime:** `providerId` string property (checked in `assertFundingProvider`).

---

## Does Paystack implement it?

**YES.**

**File:** `functions/services/funding/paystackRail.js`

```javascript
const paystackRail = {
  providerId: PROVIDER_ID,
  initializePayment,
  verifyPayment,
  normalizeWebhook,
  verifyWebhookSignature,
  isConfigured,
};
```

Registered at startup:

```javascript
const PROVIDERS = registerFundingProviders({
  [FUNDING_PROVIDERS.paystack]: paystackRail,
});
```

---

## Is the implementation complete?

**PARTIALLY — NO for production-grade completeness.**

| Requirement | Status |
|-------------|--------|
| `initializePayment` | YES |
| `verifyPayment` | YES |
| `normalizeWebhook` | YES |
| `verifyWebhookSignature` | YES |
| `refundPayment` | **NO — not implemented** |
| Error normalization | Minimal |
| Retry / timeout policy | Only axios timeout |
| Idempotency inside adapter | NO |

There is no class named `PaystackFundingProvider`; the module exports plain object `paystackRail`.

---

## Is every funding provider normalized before reaching `transactionService`?

**YES** for the webhook/confirm path.

**Flow:**
1. `paystackRail.normalizeWebhook(payload)` → `NormalizedFundingEvent`
2. `fundingWebhookService.processFundingEvent` receives normalized `event`
3. `fundingRailService.verifyPayment` re-normalizes via `normalizePaystackTransaction`
4. `transactionService.completeFundingOrder` receives `verifiedEvent` (normalized shape)

```javascript
const verified = await fundingRailService.verifyPayment(provider, event.providerReference);
// ...
const result = await transactionService.completeFundingOrder({
  fundingOrder,
  verifiedEvent: verified,
});
```

**Normalized shape** (from `fundingTypes.js` JSDoc):

```javascript
{
  providerReference,
  providerTransactionId,
  amount,
  currency,       // always "USD"
  status,         // "success" | "failed" | "pending"
  failureReason?,
}
```

**Exception:** `transactionService` still stores raw provider string in metadata (`provider: fundingOrder.provider`), which is acceptable.

---

## Code snippets — three layers

**Interface contract:**

```javascript
// functions/services/funding/fundingProviderInterface.js
/**
 * Required methods:
 *   - providerId: string
 *   - initializePayment(params) → InitializePaymentResult
 *   - verifyPayment(providerReference) → NormalizedFundingEvent
 *   - normalizeWebhook(payload) → NormalizedFundingEvent | null
 *   - verifyWebhookSignature(req, rawBody) → boolean
 */
```

**Paystack adapter:**

```javascript
// functions/services/funding/paystackRail.js
async function initializePayment(params) {
  const response = await axios.post(
      `${config.paystack.baseUrl}/transaction/initialize`,
      payload,
      { headers: { Authorization: `Bearer ${secretKey}` }, timeout: 15000 },
  );
  return {
    checkoutUrl: body.data.authorization_url,
    providerReference: body.data.reference || reference,
    providerTransactionId: body.data.access_code || null,
    raw: body.data,
  };
}
```

**Router:**

```javascript
// functions/services/funding/fundingRailService.js
function resolveProvider(providerId) {
  const id = String(providerId || config.funding.defaultProvider || FUNDING_PROVIDERS.paystack).toLowerCase();
  const adapter = PROVIDERS[id];
  if (!adapter) {
    throw new Error(`Unsupported funding provider: ${id}`);
  }
  return adapter;
}

async function initializePayment(params) {
  const adapter = resolveProvider(params.provider);
  return adapter.initializePayment(params);
}
```

---

# 3. Provider Registry

## How is a funding provider selected?

**Registry lookup — NOT bare `if (provider=="paystack")` in the rail layer.**

**File:** `functions/services/funding/fundingRailService.js`  
**Mechanism:** `PROVIDERS` object map + `resolveProvider(providerId)`

```javascript
const PROVIDERS = registerFundingProviders({
  [FUNDING_PROVIDERS.paystack]: paystackRail,
});

function resolveProvider(providerId) {
  const id = String(providerId || config.funding.defaultProvider || FUNDING_PROVIDERS.paystack).toLowerCase();
  const adapter = PROVIDERS[id];
  if (!adapter) {
    throw new Error(`Unsupported funding provider: ${id}`);
  }
  return adapter;
}
```

This is equivalent to `FundingProviderRegistry.get(provider)`, implemented as a plain object map validated at module load via `registerFundingProviders()`.

## Where `if/else` still exists

**YES — in HTTP and settlement layers:**

| Location | Pattern |
|----------|---------|
| `fundingHttp.js:45` | `if (provider !== FUNDING_PROVIDERS.paystack)` |
| `paystackWebhookHttp.js:33` | `const provider = FUNDING_PROVIDERS.paystack` |
| `paymentRailService.js:582-586` | `if (railId === darajaRail.railId)` for settlement |

**Why it exists:** Only Paystack is registered; HTTP layer explicitly rejects other providers until adapters exist.

**Recommendation:** Replace HTTP gate with `fundingRailService.resolveProvider(provider)` try/catch. Keep separate webhook Cloud Functions per provider if needed, but pass `provider` param rather than hardcoding.

---

# 4. Funding Order Lifecycle

## States that currently exist

**File:** `functions/utils/fundingTypes.js`

```javascript
const FUNDING_STATUSES = Object.freeze({
  pending: "pending",
  processing: "processing",
  completed: "completed",
  failed: "failed",
});
```

## States from your example vs implementation

| Example state | Exists? |
|---------------|---------|
| PENDING | YES → `pending` |
| PAYMENT_INITIALIZED | **NO** (implicit: `checkoutUrl` set while still `pending`) |
| PAYMENT_PROCESSING | YES → `processing` |
| PAYMENT_COMPLETED | YES → `completed` |
| FAILED | YES → `failed` |
| CANCELLED | **NO** |
| REFUNDED | **NO** |

## State transitions (actual)

```
createFundingOrder()
  → pending
       ↓ (checkout initialized, checkoutUrl stored — status stays pending)
webhook/confirm success path:
  pending → processing (completeFundingOrder start)
  processing → completed (credit succeeds)
  processing → failed (credit throws)
webhook failure:
  pending → failed (event.status === "failed")
terminal guard:
  completed/failed cannot transition (updateFundingOrder throws)
```

**Relevant functions/files:**

| Transition | Function | File |
|------------|----------|------|
| → `pending` | `createFundingOrder` | `fundingOrderService.js` |
| checkout URL stored, still `pending` | `updateFundingOrder` | `fundingHttp.js` + `fundingOrderService.js` |
| → `processing` | `updateFundingOrder` | `transactionService.completeFundingOrder` |
| → `completed` | `updateFundingOrder` | `transactionService.completeFundingOrder` |
| → `failed` | `updateFundingOrder` | `fundingWebhookService.processFundingEvent` or `completeFundingOrder` catch |

**Missing states that should be added before production:**
- `cancelled` (user abandons checkout)
- `refunded`
- Explicit `payment_initialized` (optional but improves ops visibility)

---

# 5. Webhook Flow (Successful Paystack Charge)

## Full call chain

```
Paystack (charge.success POST)
  ↓
handlePaystackWebhook                     [functions/http/paystackWebhookHttp.js]
  app.post("/", ...)                      L18-81
  ↓
fundingRailService.verifyWebhookSignature [functions/services/funding/fundingRailService.js]
  → resolveProvider("paystack")
  → paystackRail.verifyWebhookSignature   [functions/services/funding/paystackRail.js]
  ↓
fundingRailService.normalizeWebhook
  → paystackRail.normalizeWebhook
  → normalizePaystackTransaction
  ↓
fundingWebhookService.processFundingEvent [functions/services/funding/fundingWebhookService.js]
  → isWebhookDuplicate                    (webhookEvents/paystack_{id})
  → fundingOrderService.findByProviderReference
  → fundingRailService.verifyPayment
  → paystackRail.verifyPayment            (GET /transaction/verify/:reference)
  ↓
transactionService.completeFundingOrder  [functions/services/transactionService.js]
  → fundingOrderService.updateFundingOrder (processing)
  → createTransactionRecord               (transactionRecords, type: funding)
  → walletService.creditUserFiat
  ↓
fiatLedgerService.appendTransaction      [functions/services/ledger/fiatLedgerService.js]
  → Firestore transaction: fiatLedger + walletAggregatesFiat
  → rtdbSyncService.syncFiatToRTDB
  ↓
walletService.dualWriteUsdBalance         [functions/services/walletService.js]
  → users.usdBalance, users.USD, users.fiatBalance, users.wallets
  ↓
walletService.syncUserBalanceToRealtime
  → syncBalanceToRealtimeDatabase         [functions/utils/firestore.js]
  → rtdbSyncService.syncToRTDB (USDC path only inside full sync)
  → wallet/{uid}/fiat/USD (and other fiat fields)
  ↓
transactionService.updateTransactionStatus (completed)
  → fundingOrderService.updateFundingOrder (completed)
  → logTransaction                        (legacy transactions/{uid}/transactions)
  ↓
fundingWebhookService.recordWebhookEvent  (webhookEvents)
  ↓
HTTP 200 OK
```

## Notification step

**NO — not in this path.**

IntaSend top-ups call `createNotification` via `libs/payments.js`. The Paystack funding path does **not** emit push/in-app notifications.

**Missing function:** nothing equivalent to `notifyDirectTopupAdmins` or user notification on funding complete.

---

# 6. Wallet Service Responsibilities

## Can `walletService` credit/debit/read balances?

| Capability | YES/NO | Function |
|------------|--------|----------|
| Credit fiat | **YES** | `creditUserFiat` |
| Debit fiat | **YES** | `debitUserFiat` |
| Read fiat (legacy) | **YES** | `getUserWalletBalances` (reads `users` doc, not ledger) |
| Read fiat (ledger-available) | **YES** | `getFiatAvailableBalance` → `fiatReservationService.getAvailableBalance` |
| Credit crypto | **NO** (delegates to Circle ledger via `getCryptoBalance` only) | Pre-existing |

## Can `walletService` verify payments / call Paystack / call Daraja / handle webhooks?

| Capability | YES/NO | Why |
|------------|--------|-----|
| Verify payments | **NO** | |
| Call Paystack | **NO** | |
| Call Daraja | **NO** | |
| Handle webhooks | **NO** | |

**Caveat:** `walletService` still imports `circleRailAdapter` for `getCryptoBalance` / `getWallet` — pre-existing crypto coupling, not introduced for Paystack.

```javascript
async function getCryptoBalance(userId) {
  const wallet = await circleRailAdapter.getWallet(userId);
  if (!wallet) return 0;
  return ledgerService.getAvailableBalance(userId, "USDC");
}
```

**Architectural gap:** `getUserWalletBalances` reads `users.usdBalance` directly, not `walletAggregatesFiat`. Ledger-read cutover was explicitly deferred, so read path is inconsistent between old and new flows.

---

# 7. Transaction Service Responsibilities

## External dependencies of `transactionService.js`

| Dependency | Purpose |
|------------|---------|
| `config` | Collection names |
| `libs/firestore` | Firestore access |
| `utils/transactions` | `logTransaction`, `generateTransactionId` |
| `ledgerService.js` | Double-entry `ledger_entries` (legacy B2B path; unused by new funding flow) |
| `walletService` | `creditUserFiat` in `completeFundingOrder` |
| `funding/fundingOrderService` | Order status updates in `completeFundingOrder` |
| `utils/fundingTypes` | `FUNDING_STATUSES` |

## Does it contain provider-specific logic?

**NO Paystack/axios/HMAC logic.**

**YES opaque provider metadata** (`fundingOrder.provider`, `providerReference`) — acceptable.

## Does it match the agreed scope?

| Expected responsibility | Implemented? |
|-------------------------|--------------|
| Complete funding orders | YES — `completeFundingOrder` |
| Audit records | YES — `transactionRecords`, optional legacy `logTransaction` |
| Ledger operations | **NO directly** — delegates to `walletService` → `fiatLedgerService` |
| Domain events | **NO** |

**Violation of strict layering:** `transactionService` calls `fundingOrderService.updateFundingOrder` directly. Order lifecycle arguably belongs in a `fundingService` orchestrator; `transactionService` should only create/update transaction records and invoke wallet ops.

---

# 8. Fiat Ledger vs Circle Ledger

## Comparison table

| Property | Crypto (`ledger/ledgerService.js`) | Fiat (`ledger/fiatLedgerService.js`) |
|----------|-----------------------------------|--------------------------------------|
| Append-only ledger collection | `cryptoLedger` | `fiatLedger` |
| Aggregate cache | `walletAggregates` | `walletAggregatesFiat` |
| Reservations | `pendingReservations` | `pendingFiatReservations` |
| Doc ID prefix | `cl_{referenceId}` | `fl_{referenceId}` |
| Idempotent append | YES — `hasLedgerEntry(referenceId)` | YES — same pattern |
| Balance from aggregate | YES | YES |
| Rebuild from ledger | YES — `rebuildBalanceFromLedger` | YES — same |
| RTDB sync inside append | YES — `syncAssetToRtdb` | YES — `syncFiatToRTDB` |
| Webhook replay window | YES — `WEBHOOK_REPLAY_MAX_MS` | **NO** |
| Reconciliation job | YES — `reconcileCircleLedger` | **NO** |

## Is fiat append-only?

**YES.**

```javascript
tx.set(entryRef, {
  id: entryRef.id,
  userId,
  type,
  asset,
  amount: numericAmount,
  direction,
  source,
  referenceId,
  // ...
  createdAt: serverTimestamp(),
});
```

No update/delete paths exist.

## Is fiat using aggregates?

**YES** — `walletAggregatesFiat/{userId}` updated in same Firestore transaction as ledger append.

## Does fiat calculate balances from ledger?

**YES** — primary path reads aggregate; fallback `rebuildBalanceFromLedger` sums `fiatLedger` entries.

## Are balances computed from `transactionRecords`?

**NO** for the new funding path. Correct.

**YES indirectly for legacy reads:** `getUserWalletBalances` still reads `users.usdBalance`, not ledger.

## Differences that matter

1. **Separate aggregate collections** — correct, avoids USDC/USD collision.
2. **Crypto has reconciliation; fiat does not.**
3. **Crypto webhook replay protection; fiat webhook uses generic `webhookEvents` without timestamp staleness check.**
4. **`fiatLedgerService.appendTransaction` syncs RTDB inside ledger service; `walletService.creditUserFiat` also calls `syncUserBalanceToRealtime` which re-syncs all fiat fields from `users` doc** — double RTDB write path.

---

# 9. Dual Write

## When a wallet is credited (Paystack path), collections updated

```
1. fiatLedger/{fl_{referenceId}}           ← append (Firestore txn with aggregate)
2. walletAggregatesFiat/{userId}           ← same Firestore txn
3. RTDB wallet/{uid}/fiat/USD              ← inside fiatLedgerService.appendTransaction
4. users/{uid}                             ← dualWriteUsdBalance (separate Firestore txn)
5. RTDB wallet/{uid}/fiat/* (full sync)    ← syncBalanceToRealtimeDatabase via walletService
6. transactionRecords/{txr_*}              ← transactionService.createTransactionRecord
7. fundingOrders/{fund_*}                  ← status updates
8. transactions/{uid}/transactions          ← legacy logTransaction (best-effort)
9. customerWallets                          ← NOT updated
```

## Is order guaranteed?

**NO.**

Steps 1–3 are one atomic Firestore transaction inside `fiatLedgerService.appendTransaction`.  
Steps 4–5 are separate operations in `walletService.creditUserFiat`:

```javascript
const ledgerResult = await fiatLedgerService.appendTransaction({ ... });
const dualWrite = await dualWriteUsdBalance(userId, ledgerResult.newBalance);
await syncUserBalanceToRealtime(userId, asset);
```

## Is it transactional end-to-end?

**NO.**

Failure modes:
- Ledger commits, `dualWriteUsdBalance` fails → ledger/aggregate ahead of `users.usdBalance`
- `dualWriteUsdBalance` succeeds, RTDB sync fails → Firestore ahead of RTDB (logged, non-fatal in legacy sync)
- `customerWallets` never written in new path — potential third source of truth drift if anything reads that collection

**What should change:** Single orchestrated saga or one Firestore transaction spanning ledger + users (harder with RTDB). Minimum: outbox/reconcile job comparing `walletAggregatesFiat.USD` vs `users.usdBalance`.

---

# 10. Merchant Settlement

## Trace: `POST /funding/merchant-payments`

```
fundingHttp mountFundingRoutes
  app.post("/funding/merchant-payments")     [fundingHttp.js:143]
  → verifyFirebaseAuth
  → merchantSettlementService.initiateMerchantPayment
      → merchantDirectoryService.getMerchant
      → walletService.getFiatAvailableBalance
      → fiatReservationService.reserveFunds
      → convertUsdToKes → rateService.getRates
      → Firestore: merchantPayments (pending)
      → paymentRailService.resolveSettlementRail
      → darajaRail.initiateB2BPayment
      → Firestore: settlementJobs (processing)
      → merchantPayments (processing)
      → [stub mode] completeMerchantPayment
          → transactionService.createTransactionRecord
          → walletService.debitUserFiat
          → fiatLedgerService.appendTransaction
          → dualWriteUsdBalance
          → syncUserBalanceToRealtime
          → fiatReservationService.confirmReservation
          → finalizeMerchantPayment
```

## Does flow match Reservation → FX → Rail → Debit → Ledger → RTDB → Audit?

| Step | YES/NO |
|------|--------|
| Reservation | YES |
| FX | YES |
| Settlement rail | YES (Daraja stub/live) |
| Wallet debit | YES (stub completes immediately; **live Daraja leaves debit pending**) |
| Ledger | YES (on complete) |
| RTDB | YES |
| Audit | YES (`transactionRecords`, `merchantPayments`, `settlementJobs`) |

**Critical gap in live (non-stub) mode:**

When `darajaRail.isStubMode()` is false, `initiateMerchantPayment` returns `processing` **without debiting wallet**. There is:
- No Daraja callback webhook handler
- No `completeMerchantPayment` trigger on B2B result
- Reservation stays `reserved` indefinitely

## Retries?

**NO.** `settlementJobs.retryCount` is initialized to 0 but never incremented. No retry scheduler.

## Can reservations expire?

**NO.** No TTL, no scheduled sweeper, no `expiresAt` field on `pendingFiatReservations`.

## Failure handling

| Failure point | Behavior |
|---------------|----------|
| Daraja initiate throws | `releaseReservation`, merchant payment → `failed` |
| Insufficient balance | 402 before reservation |
| Live Daraja async failure | **Unhandled** — funds reserved, no debit, no release |
| Duplicate `requestId` | `reserveFunds` returns `{ duplicate: true }` but flow continues creating new `mp_*` docs |

**Duplicate merchant payment bug:** `initiateMerchantPayment` does not short-circuit on duplicate reservation before creating new `merchantPayments` document.

---

# 11. Settlement Rail Abstraction

## Is Daraja abstracted?

**PARTIALLY — NO full SettlementRail interface.**

**What exists:**
- `darajaRail.js` module with `initiateB2BPayment`, `queryPaymentStatus`, `isStubMode`
- `paymentRailService.resolveSettlementRail(railId)` — **if/else**, not registry

```javascript
function resolveSettlementRail(railId = "daraja_b2b") {
  if (railId === darajaRail.railId) {
    return darajaRail;
  }
  throw new Error(`Unsupported settlement rail: ${railId}`);
}
```

## Can another rail replace it?

**Not without code change.** No `SettlementRail` interface with `registerSettlementRails()` mirroring funding.

## Recommended refactor

```
services/settlement/
  settlementRailInterface.js   (initiatePayout, queryStatus, normalizeCallback)
  settlementRailService.js     (registry)
  darajaRail.js                (implements interface)
  bankRail.js                  (future)
  airtelRail.js                (future)
```

Move `darajaRail.js` from `services/funding/` to `services/settlement/` — it is not a funding provider.

---

# 12. Idempotency

## Funding orders

| Mechanism | Location |
|-----------|----------|
| Terminal status guard | `fundingOrderService.updateFundingOrder` — cannot leave `completed`/`failed` |
| Early return if already completed | `fundingWebhookService.processFundingEvent`, `completeFundingOrder` |

**Gap:** No idempotency on `POST /funding/orders` — double-submit creates two orders.

## Paystack webhook

| Layer | Key |
|-------|-----|
| `webhookEvents/paystack_{eventId}` | Before processing |
| `fiatLedger/fl_fund_paystack_{txnId}` | Ledger referenceId in `completeFundingOrder` |
| Funding order `completed` status | Short-circuit |

```javascript
const referenceId = `fund_${fundingOrder.provider}_${verifiedEvent.providerTransactionId || verifiedEvent.providerReference}`;
```

**Gap:** Webhook event recorded **after** processing in `processFundingEvent`, not before. Crash mid-processing could retry and rely on ledger idempotency only.

**Gap:** `confirmFundingOrder` path has **no** `webhookEventId` dedup.

## Merchant settlement

| Mechanism | Location |
|-----------|----------|
| Reservation doc `fres_{requestId}` | Duplicate returns `{ duplicate: true }` |
| Debit reference `mp_debit_{requestId}` | Ledger idempotency |

**Gap:** Duplicate reservation does not abort `initiateMerchantPayment`; new merchant payment doc still created.

## Reservations

Idempotent by `requestId` doc ID. No expiry. No cleanup job.

---

# 13. Reconciliation

## Does a Paystack/fiat equivalent of `reconcileCircleLedger` exist?

**NO.**

**What exists for Circle:**

```javascript
exports.reconcileCircleLedger = onSchedule(
    { schedule: "0 */6 * * *", ... },
    async () => {
      const result = await runCircleLedgerReconciliation();
    },
);
```

Compares Circle on-chain balance vs `cryptoLedger` / `walletAggregates`.

**For Paystack/fiat: nothing.**

## Recommended implementation

`jobs/reconcileFiatFunding.js` scheduled every 6–24h:

1. Query `fundingOrders` where `status=completed` in time window
2. For each, call `fundingRailService.verifyPayment(provider, providerReference)`
3. Compare verified amount vs order amount vs `fiatLedger` entry
4. Compare `walletAggregatesFiat.USD` vs `users.usdBalance` (dual-write drift)
5. Write adjustment entries with `type: reconciliation_adjustment` (mirror Circle's `appendReconciliationAdjustment`)
6. Alert on mismatch

Also: `reconcilePendingFundingOrders` for orders stuck in `pending`/`processing` > N hours.

---

# 14. Event Driven Design

## Does the project emit domain events?

**NO** — not in the funding/settlement path.

No pub/sub, no Firestore event collection, no Cloud Tasks envelope, no event bus.

Existing notification pattern (`utils/notifications.js` → `createNotification`) is **imperative function calls**, not domain events.

## Events that do NOT exist

- `FundingCompleted`
- `WalletCredited`
- `SettlementCompleted`
- `ReservationReleased`

## Difficulty adding later

**LOW–MEDIUM.**

Clean injection points:
- End of `transactionService.completeFundingOrder`
- End of `merchantSettlementService.completeMerchantPayment`
- End of `fiatReservationService.releaseReservation`

Could add `services/events/domainEventService.js` emitting to Firestore outbox or Pub/Sub without changing provider adapters. Hardest part: retro-fitting notification and analytics consumers.

---

# 15. Backward Compatibility

## Consumer APIs

**Files changed:** `functions/http/customerWalletsHttp.js` (added `mountFundingRoutes(app)` at end), `functions/http/fundingHttp.js` (new)

**Why safe:** Existing routes untouched. New routes are additive under `/funding/*`. Same `exports.api` function name and Firebase export.

## Circle

**Files changed:** `functions/services/walletService.js` (added fiat imports/methods; crypto methods unchanged), `functions/services/sync/rtdbSyncService.js` (extended `syncToRTDB` to route fiat; USDC path preserved)

**Untouched:** `cryptoApi.js`, `circleWebhookHttp.js`, `services/circle/*`, `jobs/reconcileCircleLedger.js`, Circle exports in `index.js`

## IntaSend

**Files changed:** **NONE**

**Untouched:** `libs/payments.js`, `http/webhookApi.js`, `http/paymentsHttp.js`, `handleTopUpWebhook`

## TransFi

**Files changed:** **NONE**

## B2B Portal

**Files changed:** **NONE**

**Untouched:** `b2bPortalHttp.js`, all B2B services

## Partner API

**Files changed:** **NONE**

**Untouched:** `partnerApi.js`, `partnerService.js`

## Partner Sandbox

**Files changed:** **NONE**

## Admin Dashboard

**Files changed:** **NONE** to `adminHttp.js`, `adminClaimsHttp.js`

**Indirect:** `transactionService.CHANNEL_TYPES.c2b` extended with `funding`, `merchant_payment` — affects platform transaction list filters only if used; additive.

## Other modified files (shared infrastructure)

| File | Risk |
|------|------|
| `config.js` | Additive collections/secrets only |
| `index.js` | Additive export `handlePaystackWebhook` |
| `paymentRailService.js` | Additive `resolveSettlementRail`; existing exports unchanged |
| `transactionService.js` | Additive `completeFundingOrder`, new types |
| `package.json` | Jest dev dependency |

---

# 16. Technical Debt — Staff Engineer Production Readiness Review

## Architectural weaknesses

1. **Dual-write without reconciliation job** — `walletAggregatesFiat`, `users.usdBalance`, and RTDB can diverge. At scale this produces support tickets and incorrect balances.

2. **`transactionService` owns funding order state transitions** — blurs transaction engine vs funding orchestrator boundaries.

3. **Paystack named in HTTP/webhook service layers** — adding Stripe requires new HTTP handlers and string edits, not just a new adapter file.

4. **Settlement rail is if/else, not registry** — Daraja lives under `services/funding/` though it is not a funding provider.

5. **Live Daraja path incomplete** — reservations without completion webhook = locked user funds.

6. **No notifications on funding success** — inconsistent with IntaSend UX.

## Scalability issues

1. **`findByProviderReference` composite query** — requires index `(provider, providerReference)`; will fail at first webhook without index deployed.

2. **`rebuildBalanceFromLedger` scans all entries per user** — O(n) per rebuild; unacceptable at millions of entries. Need periodic aggregate snapshots or sharded counters.

3. **`getReservedTotal` query on every balance read** — hot path for merchant payments; needs aggregate reserved field or counter.

4. **No pagination on funding order listing** — not implemented yet but will be needed.

5. **Webhook handler is synchronous** — Paystack webhook does verify API call + full credit path in one HTTP request; timeout risk under load.

## Tight coupling

- `fundingWebhookService` ↔ `paystack_` webhook doc prefix
- `walletService.creditUserFiat` ↔ USD-only `dualWriteUsdBalance` (hardcoded fields even if `currency` param differs)
- `merchantSettlementService` ↔ `rateService.getRates("KES", "USDT")` as USD→KES proxy (USDT/KES ≠ USD/KES formally)

## Missing abstractions

- `SettlementRailInterface` + registry
- Generic `handleFundingWebhook(provider)`
- `FundingOrchestratorService` (order + webhook + confirm)
- Domain event outbox
- `refundPayment` on funding providers

## Missing indexes (Firestore)

Required before production (likely):
- `fundingOrders`: `(provider, providerReference)`
- `fundingOrders`: `(userId, createdAt desc)`
- `fundingOrders`: `(status, createdAt desc)`
- `fiatLedger`: `(userId, asset)` — for rebuild scans
- `pendingFiatReservations`: `(userId, asset, status)`

## Missing scheduled jobs

- `reconcileFiatLedger` / dual-write drift correction
- `reconcilePaystackFundingOrders` (stuck pending/processing)
- `expireFiatReservations` (release stale holds)
- `retrySettlementJobs` (Daraja failures)
- `reconcileDarajaSettlementCallbacks` (when callback URL wired)

## Firestore performance risks

- Double RTDB sync per credit (inside ledger + full sync from users)
- Non-transactional dual-write across 3 stores (ledger, users, RTDB)
- Merchant payment duplicate path creating orphan `merchantPayments` docs
- Full ledger scan in `rebuildBalanceFromLedger` as fallback

## Security concerns

1. **Paystack webhook records event after processing** — race window for duplicate delivery before dedup doc exists (mitigated by ledger idempotency, not webhook idempotency).

2. **`fundingHttp` has no rate limiting** — unlike `cryptoApi` send rate limit.

3. **No amount ceiling validation** on funding orders — large amount DoS vector.

4. **Daraja stub auto-completes settlements** — must ensure `DARAJA_STUB_MODE` cannot be true in production via misconfiguration.

5. **Signature fallback in paystackRail** — `catch (e) { return hash === signature }` compares hex string to potentially non-hex signature (Paystack sends hex; low risk but sloppy).

## Suggested improvements before production (priority order)

1. **Implement `reconcileFiatFunding` job** — dual-write drift is the highest financial risk.
2. **Complete Daraja callback handler + `completeMerchantPayment` async path** — otherwise live settlement locks reservations.
3. **Fix merchant payment idempotency** — abort on duplicate `requestId` before creating new docs.
4. **Deploy Firestore indexes** before first webhook.
5. **Record webhookEvents before processing** (or use transactional lock doc).
6. **Add funding success notifications** — parity with IntaSend.
7. **Extract `FundingOrchestratorService`** — move order transitions out of `transactionService`.
8. **Generic funding webhook handler + settlement rail registry**.
9. **Rate limit `/funding/orders` and `/funding/merchant-payments`**.
10. **Add `cancelled` / stuck-order sweeper** for abandoned Paystack checkouts.

---

## Summary

This implementation **substantially follows** the agreed layering (provider adapter → order → webhook service → transaction service → wallet → ledger → RTDB) and **correctly isolates Paystack API calls to `paystackRail.js`**. It is **not production-ready** for millions of transactions without reconciliation, completed settlement async flow, index deployment, and dual-write integrity guarantees.
