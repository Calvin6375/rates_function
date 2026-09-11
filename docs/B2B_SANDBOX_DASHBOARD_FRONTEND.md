# B2B sandbox onboarding — dashboard frontend guide

Use these **portal** routes (Firebase Bearer) so the onboarding checklist and Transactions tab reflect sandbox tests without manual ops review.

Base URL:

```text
https://{region}-{projectId}.cloudfunctions.net/b2bPortal
```

TruePay example: `https://us-central1-truepay-72060.cloudfunctions.net/b2bPortal`

Auth: `Authorization: Bearer <Firebase ID token>` on every call below.

---

## Overview

| Goal | Endpoint | Notes |
|------|----------|-------|
| Load checklist + link token | `GET /portal/onboarding` | `progress.testTransactionDone`, `sandbox.linkToken` |
| Run test from dashboard | `POST /portal/sandbox/payments` | No curl; auto-checks checklist |
| List sandbox test rows | `GET /portal/sandbox/transactions` | Firestore-backed; survives cold starts |
| Run test via curl (step 4) | `POST {partnerSandboxBaseUrl}/payments` | Pass `X-Sandbox-Link-Token` from onboarding |

Live partner transactions (`GET /portal/transactions`) stay empty until the partner is **active** and real payments exist. During onboarding, use **`GET /portal/sandbox/transactions`** for the Transactions tab.

## Test mode (full dashboard)

Session from `GET /portal/me`: `environment` (`test`|`live`), `canUseLive`, `testWalletReady`. Banner: **Test mode — no real money**.

| Feature | Test endpoint |
|---------|----------------|
| Session switch | `POST /portal/environment` `{ "environment": "test" \| "live" }` |
| Transactions | `GET /portal/sandbox/transactions` |
| Collect | `POST /portal/sandbox/payments` (`scenario` optional) |
| Payment links | `GET/POST /portal/sandbox/payment-links`, `POST .../:linkId/pay` |
| Hosted checkout | `GET/POST /public/sandbox/l/:linkId` |
| QR | `GET /portal/sandbox/profile-qr` |
| Wallet | `GET /portal/sandbox/wallet` |
| Fund | `POST /portal/sandbox/funding` `{ amount, currency }` |
| Send | `/portal/sandbox/send/recipients`, `quote`, `payments` |
| Settlements | `GET/POST /portal/sandbox/settlements` |
| Dashboard / reports | `GET /portal/sandbox/dashboard`, `/portal/sandbox/reports` |
| Test webhook payload | `POST /portal/sandbox/webhooks/test` |

Isolation: test ledger is `partnerTestLedgers/{uid}`. Live Partner API rejects `sandbox.publicApiKey` (`401`). Test rows include `sandbox: true` and `environment: "test"`. Histories never mix.

Deterministic QA: amount ending `00` (or omit) → completed; `01` fail; `02` pending; `03` expire. Or send `"scenario": "success"|"fail"|"pending"|"expire"`.

---

## 1. Load onboarding state

```http
GET /b2bPortal/portal/onboarding
Authorization: Bearer <idToken>
```

**Use in UI**

| Field | Purpose |
|-------|---------|
| `data.onboarding.progress.testTransactionDone` | Check “Run test transaction” when `true` |
| `data.sandbox.publicApiKey` | Pre-fill curl / copy button |
| `data.sandbox.linkToken` | Attribute curl tests to this user |
| `data.sandbox.partnerSandboxBaseUrl` | Base URL for step 4 curl |
| `data.sandbox.testTransactionDone` | Same flag as progress (convenience) |

**Example (trimmed)**

```json
{
  "success": true,
  "data": {
    "onboarding": {
      "progress": { "testTransactionDone": false }
    },
    "sandbox": {
      "publicApiKey": "KalvoB2B-Sandbox-public-test-key-2026",
      "linkToken": "sbxlnk_…",
      "partnerSandboxBaseUrl": "https://us-central1-truepay-72060.cloudfunctions.net/partnerSandbox",
      "testTransactionDone": false
    }
  }
}
```

Poll this endpoint (or `/portal/sandbox/transactions`) after the user runs step 4 curl until `testTransactionDone` becomes `true`.

---

## 2. Option A — Run test from the dashboard (recommended)

No Partner API key in browser beyond what onboarding already exposes; server records the test for the signed-in user.

```http
POST /b2bPortal/portal/sandbox/payments
Authorization: Bearer <idToken>
Content-Type: application/json

{
  "amount": 100,
  "currency": "KES",
  "reference": "sandbox-test-001"
}
```

**Success (`201`)**

```json
{
  "success": true,
  "sandbox": true,
  "data": {
    "transactionId": "sbx_tx_…",
    "amount": 100,
    "currency": "KES",
    "reference": "sandbox-test-001",
    "previousBalance": 25000,
    "newBalance": 25100,
    "sandbox": true
  }
}
```

After success:

1. Set checklist item complete from `testTransactionDone` (refresh onboarding or transactions list).
2. Append the row to the Transactions tab from `GET /portal/sandbox/transactions`.

---

## 3. Option B — Keep curl in the checklist (step 4)

When showing the curl snippet, inject `linkToken` so the backend ties the payment to the dashboard user.

**Header (preferred)**

```bash
curl -sS -X POST "${partnerSandboxBaseUrl}/payments" \
  -H "Content-Type: application/json" \
  -H "X-API-KEY: ${publicApiKey}" \
  -H "X-Sandbox-Link-Token: ${linkToken}" \
  -d '{"amount":100,"currency":"KES","reference":"sandbox-test-001"}'
```

**Or body metadata**

```json
{
  "amount": 100,
  "currency": "KES",
  "reference": "sandbox-test-001",
  "metadata": { "linkToken": "sbxlnk_…" }
}
```

Immediate success: `success: true` and `data.transactionId` on the sandbox response.

Then poll:

```http
GET /b2bPortal/portal/onboarding
```

until `progress.testTransactionDone === true` (usually one request after curl completes).

---

## 4. Transactions tab during onboarding

```http
GET /b2bPortal/portal/sandbox/transactions?limit=50
Authorization: Bearer <idToken>
```

**Response**

```json
{
  "success": true,
  "data": {
    "transactions": [
      {
        "id": "sbx_tx_…",
        "transactionId": "sbx_tx_…",
        "type": "b2b_payment",
        "amount": 100,
        "currency": "KES",
        "status": "completed",
        "metadata": { "reference": "sandbox-test-001", "sandbox": true },
        "createdAt": "2026-06-05T…"
      }
    ],
    "testTransactionDone": true,
    "sandbox": true
  }
}
```

**UI mapping**

| Column | Field |
|--------|-------|
| ID | `transactionId` |
| Amount | `amount` + `currency` |
| Status | `status` |
| Reference | `metadata.reference` |
| Badge | Show “Sandbox” when `metadata.sandbox === true` |

While `partner.status !== "active"`, prefer this list over `GET /portal/transactions`. After go-live, switch the tab to `/portal/transactions` (or merge both with a filter).

---

## 5. Checklist wiring

```tsx
// Pseudocode
const { onboarding, sandbox } = onboardingResponse.data;
const testDone =
  onboarding?.progress?.testTransactionDone === true ||
  sandbox?.testTransactionDone === true;
const goLiveDone =
  onboarding?.progress?.goLiveDone === true ||
  sandbox?.goLiveDone === true;

<ChecklistItem title="Run test transaction" completed={testDone} />
<ChecklistItem title="Go live" completed={goLiveDone} />
```

**Go live** is set by the backend when the partner’s Firestore `status` is `active` (super admin `PATCH /platform/partners/{id}`). No separate confirm endpoint. Optional frontend fallback: `GET /portal/me` → `data.partner.status === "active"`.

**Optional “Run test” button** — call `POST /portal/sandbox/payments` with default body, then refetch onboarding + transactions.

**After external curl** — poll every 2–3s (max ~30s):

1. `GET /portal/sandbox/transactions`
2. Or `GET /portal/onboarding`

Stop when `testTransactionDone` is true or show a hint to include `X-Sandbox-Link-Token` if still false after a successful curl.

---

## 6. Copy helpers for step 4 UI

Build the curl string from onboarding response:

```javascript
function buildSandboxPaymentCurl({ sandbox }) {
  const { partnerSandboxBaseUrl, publicApiKey, linkToken } = sandbox;
  return `curl -X POST '${partnerSandboxBaseUrl}/payments' \\
  -H 'Content-Type: application/json' \\
  -H 'X-API-KEY: ${publicApiKey}' \\
  -H 'X-Sandbox-Link-Token: ${linkToken}' \\
  -d '{"amount":100,"currency":"KES","reference":"sandbox-test-001"}'`;
}
```

---

## 7. Error handling

| Status | Meaning |
|--------|---------|
| `401` | Missing or expired ID token |
| `400` | Invalid amount on `POST /portal/sandbox/payments` |
| `500` | Server error — show generic message |

Curl without `linkToken`: payment still succeeds on `partnerSandbox`, but checklist stays unchecked and rows won’t appear under `/portal/sandbox/transactions`.

---

## 8. Implementation checklist

- [ ] On dashboard load, `GET /portal/onboarding` and store `sandbox.linkToken` + `progress.testTransactionDone`
- [ ] Update step 4 curl to include `X-Sandbox-Link-Token`
- [ ] Transactions tab calls `GET /portal/sandbox/transactions` until partner is active
- [ ] Checklist reads `progress.testTransactionDone` (poll after curl or use in-dashboard `POST /portal/sandbox/payments`)
- [ ] Optional: “Run test” button → `POST /portal/sandbox/payments` → refresh lists

Machine Partner API reference: [`B2B_SANDBOX.md`](./B2B_SANDBOX.md).
