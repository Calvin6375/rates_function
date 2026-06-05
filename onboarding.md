# B2B client onboarding

This guide lists the **ordered steps** and **HTTP endpoints** used to onboard a B2B partner in this codebase. For full request/response schemas, see [`B2B_docs.md`](./B2B_docs.md).

---

## Prerequisites

1. **Deployed Cloud Functions** including `b2bPortal` and `partner` (see `functions/index.js`).
2. **Platform operator** with a Firebase Auth user whose ID token includes **`admin: true`** (custom claim). That user performs partner creation and org-admin assignment.
3. **Placeholders**

   | Placeholder | Meaning |
   |-------------|---------|
   | `{region}` | Function region (default in repo: `us-central1`; env `FUNCTIONS_REGION`) |
   | `{projectId}` | Firebase / GCP project ID |
   | `{idToken}` | Firebase **ID token** (JWT) for the caller |
   | `{partnerId}` | Document ID returned when the partner is created |
   | `{apiKey}` | Secret key returned **once** from partner creation |

**Base URLs**

```text
B2B portal (human / dashboard):  https://{region}-{projectId}.cloudfunctions.net/b2bPortal
Partner API (machine / backend): https://{region}-{projectId}.cloudfunctions.net/partner
```

**Auth headers**

- Portal routes: `Authorization: Bearer {idToken}`
- Partner routes: `X-API-KEY: {apiKey}`

---

## Self-serve onboarding (alternative to Steps 1–2)

A signed-in Firebase user can create their own partner row, become **`org_admin`**, and store KYB/KYC-style data under **`onboarding/{uid}`** without **`admin: true`**. Platform operators can still use **Step 1** and **Step 2** for assisted onboarding.

**Important**

- Self-created partners get Firestore **`status: pending_review`**. The live **`partner`** HTTP API rejects **`X-API-KEY`** for `pending_review` / `pending_kyc` until a platform admin sets **`status: active`** via `PATCH .../platform/partners/{partnerId}`.
- For **integration testing**, use the public **`partnerSandbox`** key and base URL (see [`B2B_SANDBOX.md`](./B2B_SANDBOX.md)); `GET /portal/onboarding` echoes the configured sandbox key for the dashboard.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/b2bPortal/portal/onboarding` | Read `onboarding/{uid}`, `emailVerified`, sandbox key, **`linkToken`**, **`testTransactionDone`**, **`goLiveDone`** |
| `GET` | `/b2bPortal/portal/sandbox/transactions` | Sandbox test payments for dashboard Transactions tab (Firebase Bearer) |
| `POST` | `/b2bPortal/portal/sandbox/payments` | Run sandbox test from dashboard; sets **`progress.testTransactionDone`** |
| `PATCH` | `/b2bPortal/portal/onboarding` | Merge allowed keys: `business`, `owner`, `payments`, `kyc`, `useCases`, `terms`, `progress`, `sandbox` |
| `POST` | `/b2bPortal/portal/onboarding/register-partner` | Body: `{ "name", "settlementCurrency?", "webhookUrl?" }` — creates partner, assigns caller as org admin, returns **`apiKey` once** (idempotent retries omit it) |
| `POST` | `/b2bPortal/portal/onboarding/complete` | Body: `{ "termsAccepted": true, "amlAccepted": true }` — sets onboarding submitted; does **not** activate live API |

After **`register-partner`**, the user should **refresh their ID token** before calling **`GET /b2bPortal/portal/me`**.

**Go live checklist**

- **`progress.goLiveDone`** on `GET /portal/onboarding` is `true` when the linked partner’s Firestore **`status`** is **`active`**, or when platform activation persisted the flag.
- Super admin **`PATCH /platform/partners/{partnerId}`** with `{ "status": "active" }` sets **`goLiveDone`** on the org admin’s `onboarding/{uid}` document automatically.
- Partners already active before deploy still see **`goLiveDone: true`** on the next `GET /portal/onboarding` (derived from partner status).

---

## Step 1 — Create the partner (platform admin)

**Who:** Firebase user with `admin: true`.

**Endpoint:** `POST /b2bPortal/platform/partners`

**Full URL:** `https://{region}-{projectId}.cloudfunctions.net/b2bPortal/platform/partners`

**Body (JSON)**

| Field | Required | Notes |
|-------|----------|--------|
| `name` | Yes | Partner display name |
| `settlementCurrency` | No | Defaults to `KES` |
| `webhookUrl` | No | Optional callback URL stored on the partner |

**Example**

```bash
curl -sS -X POST \
  "https://{region}-{projectId}.cloudfunctions.net/b2bPortal/platform/partners" \
  -H "Authorization: Bearer {idToken}" \
  -H "Content-Type: application/json" \
  -d '{"name":"Acme Hotels","settlementCurrency":"KES","webhookUrl":null}'
```

**What you get**

- `data.partnerId` — use everywhere as `partnerId`
- `data.apiKey` — **save immediately**; it is **only returned at creation** and is not shown again by the API

**Optional follow-up (same admin)**

- `GET .../b2bPortal/platform/partners/{partnerId}` — confirm partner row
- `PATCH .../b2bPortal/platform/partners/{partnerId}` — update `name`, `webhookUrl`, `status`, `settlementAccount`, etc.

---

## Step 2 — Assign the partner org admin (platform admin)

The B2B **org admin** must already exist as a **Firebase Auth** user. You need their **`uid`**.

**Endpoint:** `PUT /b2bPortal/platform/partners/{partnerId}/org-admin`

**Body:** `{ "uid": "<firebase-auth-uid>" }`

**Example**

```bash
curl -sS -X PUT \
  "https://{region}-{projectId}.cloudfunctions.net/b2bPortal/platform/partners/{partnerId}/org-admin" \
  -H "Authorization: Bearer {idToken}" \
  -H "Content-Type: application/json" \
  -d '{"uid":"FIREBASE_UID_OF_ORG_ADMIN"}'
```

**After this**

- The org admin user must **refresh their ID token** (sign out and sign in, or force refresh) so **`partnerId`** and **`partnerRole: org_admin`** appear on the token.

---

## Step 3 — Partner dashboard bootstrap (org admin or any portal user)

**Optional but recommended** right after the org admin signs in: ensure a Firestore `users/{uid}` profile exists for dashboard UIs that read by email.

**Endpoint:** `POST /b2bPortal/portal/ensure-dashboard-profile`  
**Auth:** Bearer token (any valid Firebase user)

**Verify session and partner context**

**Endpoint:** `GET /b2bPortal/portal/me`  
**Auth:** Bearer token with **`partnerId`** + **`partnerRole`**

---

## Step 4 — Add team members (org admin)

**Who:** User with **`partnerRole: org_admin`** for that `partnerId`.

**Endpoint:** `POST /b2bPortal/portal/members`

**Body**

| Field | Required | Notes |
|-------|----------|--------|
| `email` | Yes | |
| `role` | Yes | One of: `member`, `viewer`, `finance`, `support`, `auditor`, `operations` (not `org_admin`) |
| `password` | If creating a new Auth user | Min 8 characters |
| `displayName` | No | |

**Example**

```bash
curl -sS -X POST \
  "https://{region}-{projectId}.cloudfunctions.net/b2bPortal/portal/members" \
  -H "Authorization: Bearer {orgAdminIdToken}" \
  -H "Content-Type: application/json" \
  -d '{"email":"finance@acme.example","role":"finance","password":"********","displayName":"Finance"}'
```

New members should **refresh their ID token** after first sign-in.

**Alternative (platform admin):** the same team can be onboarded without org-admin token by calling  
`POST /b2bPortal/platform/partners/{partnerId}/members` with the same body (requires `admin: true`).

**List members**

- Org admin: `GET /b2bPortal/portal/members`
- Platform admin: `GET /b2bPortal/platform/partners/{partnerId}/members`

---

## Step 5 — Server-side integration (partner backend)

Give the **`apiKey` from Step 1** to the partner’s **server** (never embed in public clients). All calls use the **`partner`** function base URL and **`X-API-KEY`**.

**Smoke test — rates**

```bash
curl -sS \
  "https://{region}-{projectId}.cloudfunctions.net/partner/rates?fiat=KES&asset=USDT" \
  -H "X-API-KEY: {apiKey}"
```

**Typical next calls** (see `B2B_docs.md` §2)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/partner/wallet` | Partner balances |
| `POST` | `/partner/checkout` | Quote helper (does not charge) |
| `POST` | `/partner/payments` | Record an inflow after payment in your channel |
| `GET` | `/partner/transactions` | Transaction history |

---

## Checklist summary

| # | Action | Endpoint |
|---|--------|----------|
| 1 | Create partner + receive API key | `POST /b2bPortal/platform/partners` **or** self-serve `POST /b2bPortal/portal/onboarding/register-partner` |
| 2 | Assign org admin (`uid`) | `PUT /b2bPortal/platform/partners/{partnerId}/org-admin` (not needed if self-serve register assigned you) |
| 3 | (Optional) Ensure user profile doc | `POST /b2bPortal/portal/ensure-dashboard-profile` |
| 3b | (Self-serve) Wizard / KYB fields | `PATCH /b2bPortal/portal/onboarding` |
| 3c | (Self-serve) Terms + submit | `POST /b2bPortal/portal/onboarding/complete` |
| 4 | Confirm partner session | `GET /b2bPortal/portal/me` |
| 5 | Invite team | `POST /b2bPortal/portal/members` (or platform `POST .../platform/partners/{partnerId}/members`) |
| 6 | Integrate servers | `GET/POST .../partner/*` with `X-API-KEY` (live key works only after **`status: active`**) |

---

## Related documentation

- [`B2B_docs.md`](./B2B_docs.md) — full API reference, errors, and portal routes not repeated here.
