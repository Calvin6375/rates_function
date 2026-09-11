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

## Partner dashboard onboarding (API contract)

The partner portal frontend keeps **existing portal APIs unchanged**. The main behavioral change is **when** calls happen: simplified signup defers **`register-partner`** and partner API key creation until the user clicks **Generate API Credentials** on the checklist.

Legacy wizard flow (`VITE_USE_SIMPLIFIED_ONBOARDING=false`) continues to call the same endpoints at the original steps. No new endpoints are required.

### 1. Every signup and login (critical)

**Endpoint:** `POST /b2bPortal/portal/ensure-dashboard-profile`  
**When:** Immediately after Firebase auth — simplified signup, legacy wizard, and every login.

**Body:**

```json
{
  "Institution": "PartnerDashboard",
  "Channel": "B2B"
}
```

**Backend must:**

| Responsibility | Notes |
|----------------|--------|
| Create or patch `users/{firebaseUid}` | Idempotent; must complete within a few seconds |
| Tag B2B dashboard user | Set `institution` + `channel` on the user doc |
| Sensible profile defaults | Email from Auth; `name` / display name when available; `balance: 0`, `country: null`; `permissions` for B2B dashboard users |

**Frontend dependency:** After this call, the dashboard polls Firestore for up to ~12s. If no `users/{uid}` doc appears, signup/login fails with *“No dashboard profile in Firestore…”*.

**Current implementation:** `b2bMemberService.ensureUserDashboardProfileFromAuthUid` — on create sets `status: Active`, email, `name` / `firstName` / `lastName` (from Auth display name), `balance`, `country`, `institution`, `channel`, and default `permissions` (`dashboard.view`, `notifications.view`, `settings.view`) for B2B partner-dashboard users. Idempotent patches fill missing fields only; existing non-empty `permissions` are never overwritten.

---

### 1b. Owner contact at account creation (signup UX update)

No new endpoints or onboarding schema fields. **Timing and payloads** changed: personal contact is collected at signup (step 1) and written to `onboarding/{uid}` immediately — before partner registration or API keys.

**Call order after Firebase auth (email/password and Google):**

1. `POST /portal/ensure-dashboard-profile` — `{ "Institution": "PartnerDashboard", "Channel": "B2B" }`
2. `PATCH /portal/onboarding` — owner contact (below)
3. Firestore read of `users/{uid}` for session bootstrap (client-side poll, up to ~12s)

**Owner PATCH at signup:**

```json
{
  "owner": {
    "fullName": "Jane Doe",
    "role": "Founder",
    "phone": "+254712345678"
  }
}
```

| Field | Source |
|-------|--------|
| `owner.fullName` | Trimmed `firstName + " " + lastName` from the signup form |
| `owner.role` | Default `"Founder"` at signup; user may change later on profile/owner step |
| `owner.phone` | E.164-style: dial code + national digits, no spaces (e.g. `+254712345678`) |

Firebase **`updateProfile(displayName)`** runs **client-side only** — not a backend call. Auth display name may lag behind `owner.fullName` on the onboarding doc.

**Email/password signup**

- Email from the form (work or personal)
- Verification: call **`POST /b2bPortal/portal/send-verification-email`** (Bearer token) or callable **`sendEmailVerification`** — Zoho SMTP branded mail (not Firebase’s default template). Email link hits **`GET /public/verify-email`**, which verifies and **redirects to the B2B dashboard** (`theadmin.truepay.live`).
- Then `ensure-dashboard-profile` → owner PATCH (above)

**Google (login only — not on `/signup`)**

- Collect name/phone on the email signup form. Google is **not** a signup button.
- Login: `POST /portal/auth/google` `{ idToken }` (Google JWT) → `signInWithCustomToken` → same uid as email signup when emails match. See [`FRONTEND_AUTH_HANDOFF.md`](./FRONTEND_AUTH_HANDOFF.md).
- Then `ensure-dashboard-profile` → owner PATCH (above)
- Google accounts are usually **`email_verified: true` immediately**, so `ensure-dashboard-profile` / `GET /portal/onboarding` / `GET /portal/me` may **auto-create** the partner org and set Auth claims in the same request.
- **Required frontend step:** if the response has `claimsNeedRefresh: true` (or `data.partnerOrg` / `data.partnerId` while the token still lacks `partnerId`), call **`getIdToken(true)`** before relying on partner-gated routes. Do **not** treat a missing partner claim as a hard failure — `GET /portal/me` returns **200** with `onboardingIncomplete` / `owner` / `onboardingStatus` so the checklist can render.

**Normal post-signup onboarding doc state**

| Field | When first written | Notes |
|-------|-------------------|--------|
| `owner.fullName`, `owner.phone`, `owner.role` | Account creation | May exist **before** `registeredPartnerId` or sandbox partner key |
| `business.*` | Later (profile wizard or minimal simplified defaults) | Unchanged shape |
| `registeredPartnerId`, partner `apiKey` | `POST /portal/onboarding/register-partner` | **Not** at signup on simplified path |

It is **normal** for a new user to have `owner` populated while `registeredPartnerId` is absent and no API key exists yet.

**Later profile steps — partial owner PATCH**

If `owner.fullName` and `owner.phone` were saved at signup, the UI shows name/phone as read-only and may PATCH only role changes:

```json
{
  "owner": {
    "fullName": "Jane Doe",
    "role": "CEO",
    "phone": "+254712345678"
  }
}
```

Backend **deep merge** on `PATCH /portal/onboarding` must preserve existing `owner.*` fields when only `role` changes.

**Go-live eligibility (frontend gates — backend should return data for these checks):**

- `owner.fullName` + `owner.phone`  
- `payments.currencies`  
- KYC URLs  
- API key (after `register-partner`)  
- Test payment done  
- Verified email  

**Email verification UX:** Login no longer hard-blocks the whole dashboard for unverified email (banner instead). Backend still returns `emailVerified` on `GET /portal/onboarding` and enforces verified email on **`register-partner`** (403 `EMAIL_NOT_VERIFIED`).

**Feature flag (QA):**

| Flag | Behavior |
|------|----------|
| `VITE_USE_SIMPLIFIED_ONBOARDING=false` (default) | Legacy multi-step wizard at `/signup` |
| `true` | Single-screen signup → dashboard checklist; no partner/key at signup |

Both paths use the **same backend APIs**; only **when** `register-partner` runs differs.

**No migration required:** Existing onboarding docs remain valid. Users who signed up before owner-at-signup may have empty `owner` until they complete the profile step; the UI falls back to editable name/phone.

---

### 2. Onboarding document (unchanged routes)

**Read:** `GET /b2bPortal/portal/onboarding`

Returns merged `onboarding/{uid}` plus:

| Field | Source |
|-------|--------|
| `emailVerified` | Firebase ID token `email_verified` |
| `sandbox` | Shared sandbox key, `linkToken`, `testTransactionDone`, `goLiveDone`, `partnerSandboxBaseUrl` |
| `onboarding.registeredPartnerId` | Set after **`register-partner`** — indicates partner org exists |

**Write:** `PATCH /b2bPortal/portal/onboarding`

Server-side merge of partial updates. Allowed top-level keys: `business`, `owner`, `payments`, `kyc`, `useCases`, `terms`, `progress`, `sandbox`, **`onboardingStatus`**.

**`onboardingStatus` (PATCH):** Client may advance through `draft` → `email_verified` → `profile_complete` → `credentials_ready` → `payment_links_ready` → `submitted` → `active`. The backend **never downgrades** (including from terminal `submitted` / `active`). Compliance submission still sets `submitted` via **`POST /portal/onboarding/complete`**.

**When the frontend PATCHes:**

| Section | When |
|---------|------|
| `owner` | **Immediately after signup** (fullName, role, phone); later role-only updates if name/phone already set |
| `business` | Minimal defaults after signup and/or Business Profile page |
| `payments`, `useCases` | Business Profile page |
| `kyc` | Business Verification page (URLs after Firebase Storage upload) |
| `progress.sandboxReadyAt` | After **`register-partner`** succeeds (frontend) |
| `progress.testTransactionDone` | After sandbox test payment (backend sets on payment) |
| `progress.goLiveDone` | Ops/backend when partner goes live |

**Backend must:** Merge PATCH payloads without wiping unrelated fields. **Deep merge within each section** is implemented (e.g. PATCH `{ "business": { "country": "X" } }` preserves other `business.*` keys).

**KYC uploads (no upload API):** Frontend writes to Firebase Storage at `onboarding/{userId}/{storageKey}`, then PATCHes:

```json
{
  "kyc": {
    "idDocumentUrl": "...",
    "businessRegistrationUrl": "...",
    "selfieUrl": "..."
  }
}
```

---

### 3. Simplified signup — what is **not** called initially

With simplified onboarding enabled, signup runs:

1. Firebase auth (email/password or Google) + client-side profile updates  
2. `POST /portal/ensure-dashboard-profile`  
3. `PATCH /portal/onboarding` with **`owner`** (fullName, role, phone)  
4. Optional minimal `business` PATCH  
5. Firestore read for session bootstrap  

It does **not** call:

- `POST /portal/onboarding/register-partner`  
- `POST /portal/onboarding/complete`  

**Backend must tolerate** an onboarding doc that has `business` / `owner` but **no** `registeredPartnerId`, **no** partner API key, and **no** `onboardingStatus: submitted`. This is the normal post-signup state until the checklist step runs.

---

### 4. Partner + API credentials (same API, later timing)

**Endpoint:** `POST /b2bPortal/portal/onboarding/register-partner`  
**When:** User clicks **Generate API Credentials** on the checklist (or legacy wizard sandbox / terms step).

**Body:**

```json
{
  "name": "<business name>",
  "settlementCurrency": "KES",
  "webhookUrl": null
}
```

**Backend must (unchanged behavior):**

| Step | Detail |
|------|--------|
| Create org | `partners/{id}` with `status: pending_review` |
| Issue key | Return partner **`apiKey` once** on first create |
| Link onboarding | Set `registeredPartnerId` on `onboarding/{uid}` |
| Assign org admin | Firebase custom claims `partnerId`, `partnerRole: org_admin` |
| Idempotent retries | `{ alreadyRegistered: true }`; omit `apiKey` on retry |

**Then (frontend):** Token refresh → `GET /portal/me` → `PATCH` `progress.sandboxReadyAt`.

**Email gate:** Frontend disables credential generation until email is verified. Backend enforces on **`register-partner`**: HTTP 403 with `error: "EMAIL_NOT_VERIFIED"`.

**Sandbox key on `GET /portal/onboarding`:** Response always includes shared `sandbox.publicApiKey` (config) for `partnerSandbox` integration tests. Partner-specific **`apiKey`** from **`register-partner`** is for the live `partner` API once activated.

---

### 5. Test payment

**Endpoint:** `POST /b2bPortal/portal/sandbox/payments`  
**Body:** `{ "amount": 100, "currency": "KES", "reference": "sandbox-test-001" }`

**Backend must:** Process sandbox payment and set **`progress.testTransactionDone: true`** (or derive done from sandbox transaction history on `GET /portal/onboarding`).

Frontend polls `GET /portal/onboarding` until `progress.testTransactionDone` or `sandbox.testTransactionDone` is true.

---

### 6. Go live

#### Request go-live (partner → super admin notification)

**Endpoint:** `POST /b2bPortal/portal/onboarding/request-go-live`  
**Auth:** Bearer Firebase ID token (partner owner)  
**When:** Checklist “Request Go Live” CTA after profile / KYC / credentials / test payment / verified email.

**Backend:**

- Requires `email_verified` on token (403 `EMAIL_NOT_VERIFIED`)
- Requires `registeredPartnerId` / partner org (400 `PARTNER_NOT_REGISTERED`)
- Owner only (403 `FORBIDDEN` for non-owners)
- Sets `progress.goLiveRequested: true` (+ timestamp), advances `onboardingStatus` at most to `submitted`
- Stamps `partners/{id}.goLiveRequestedAt`
- Creates **system** notification `go_live_request_admin_alert` for super-admin dashboard + FCM to `platformAdmins` / master admin
- Idempotent if already requested (no duplicate notification)

**Response** `201` (first request) / `200` (already requested or already live)

```json
{
  "success": true,
  "data": {
    "partnerId": "partner_…",
    "goLiveRequested": true,
    "alreadyRequested": false,
    "alreadyLive": false,
    "notificationId": "…"
  },
  "message": "Go-live request sent to platform admin for review."
}
```

Dashboard should poll `GET /portal/onboarding` — `progress.goLiveRequested` / `progress.goLiveDone`.

#### Terms complete (legacy)

**Endpoint:** `POST /b2bPortal/portal/onboarding/complete`  
**When:** Terms/AML formally submitted (legacy wizard terms step; may be wired from compliance flows).

**Backend must:**

- Require `registeredPartnerId` exists  
- Set `onboardingStatus: submitted`  
- Record `termsAccepted` + `amlAccepted`  

**Go-live completion (ops-driven):**

- Set `progress.goLiveDone` or partner `status: active` via `PATCH /platform/partners/{partnerId}`  
- Frontend treats partner **`active`** as go-live done via `GET /portal/me` / `GET /portal/onboarding`
- Super-admin sees the request under **system** notifications (`type: go_live_request_admin_alert`)

---

### Backend checklist (simplified signup)

| Requirement | New? | Status in repo |
|-------------|------|----------------|
| `ensure-dashboard-profile` provisions Firestore user quickly | No | Implemented — verify latency in prod |
| Onboarding GET/PATCH merge semantics | No | Deep merge implemented |
| `register-partner` after signup, not during | Timing only | Supported — no auto-register on signup |
| Valid onboarding doc without partner/key after signup | Should work | Supported |
| `register-partner` idempotent + key on first call | No | Implemented |
| Test payment sets `testTransactionDone` | No | Implemented |
| Go-live flags / partner `active` | No | Implemented |
| Storage rules: `onboarding/{uid}/*` | No | Verify in `storage.rules` |
| Email verified before `register-partner` | Recommended | **Enforced** — 403 `EMAIL_NOT_VERIFIED` |
| `GET /platform/consumer-users` exposes `partnerId`, `partnerRole`, `partnerName` | Admin UI | Implemented |
| Onboarding PATCH deep merge at section level | Recommended | **Implemented** |
| `ensure-dashboard-profile` sets `status`, `firstName`, `lastName` on create | Recommended | **Implemented** |
| Default `permissions` on B2B dashboard user create | Required | **Implemented** — `dashboard.view`, `notifications.view`, `settings.view`; not overwritten if already set |

**Not required:** new endpoints, onboarding doc migration, auto-register on account creation, or API changes when legacy wizard flag is off.

---

### Practical verification (backend QA)

1. Simplified or Google sign-up → `users/{uid}` exists within seconds of **`ensure-dashboard-profile`**.  
2. **`PATCH /portal/onboarding`** receives `owner` with E.164 `phone` **before** any **`register-partner`** call.  
3. `GET /portal/onboarding` → `owner` populated; `registeredPartnerId` may still be absent.  
4. Later PATCH with only `owner.role` changed → deep merge preserves `fullName` and `phone`.  
5. After email verify + **Generate API Credentials** → **`register-partner`** once → key on response; `registeredPartnerId` on next GET.  
6. Sandbox payment → `testTransactionDone` true.  
7. Ops sets partner **`active`** → `goLiveDone` true on GET.  
8. Super-admin **`GET /platform/consumer-users`** → `partnerId` / `partnerName` populated after step 5.

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

**Users vs partner orgs (super-admin UI)**

| Step | When | Endpoint | Creates | Admin UI |
|------|------|----------|---------|----------|
| Profile bootstrap | Signup / login | `POST /portal/ensure-dashboard-profile` | `users/{uid}` tagged B2B | Enterprise directory |
| Org registration | Checklist “Generate API Credentials” or legacy wizard | `POST /portal/onboarding/register-partner` | `partners/{id}`, claims | Partners (B2B) tab |

See **Partner dashboard onboarding (API contract)** above for simplified signup timing.

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

## Step 3 — Partner dashboard bootstrap (every signup and login)

**Required** on every Firebase sign-in (not optional for the partner dashboard).

**Endpoint:** `POST /b2bPortal/portal/ensure-dashboard-profile`  
**Auth:** Bearer token (any valid Firebase user)

**Body:** `{ "Institution": "PartnerDashboard", "Channel": "B2B" }` — idempotent; creates or patches `users/{uid}` only. Does **not** create a partner org.

**Verify session and partner context** (after **`register-partner`** + token refresh)

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

## Super-admin dashboard: listing users vs partner orgs

Platform operators with **`admin: true`** use two different portal routes. Do not expect the same row count.

| Admin UI | API | What it lists |
|----------|-----|----------------|
| **Partners (B2B)** tab | `GET /b2bPortal/platform/partners` | Partner **organizations** (`partners/{id}`) — all statuses, ordered by `createdAt` |
| **Enterprise (B2B) directory** (Consumer tab) | `GET /b2bPortal/platform/consumer-users` | Individual **user profiles** (`users/{uid}`) tagged B2B dashboard |

Each user in **`GET /platform/consumer-users`** includes optional linkage fields (from Auth claims + onboarding):

| Field | Meaning |
|-------|---------|
| `partnerId` | Linked org id, or `null` if the user never completed org registration |
| `partnerRole` | e.g. `org_admin`, `member` — from custom claims only |
| `partnerName` | Display name from `partners/{partnerId}` when `partnerId` is set |

A B2B dashboard user with `partnerId: null` signed up via **`ensure-dashboard-profile`** but has no **`partners/{id}`** row yet.

**Deploy** (after backend changes to `b2bPortal`):

```bash
firebase deploy --only functions:b2bPortal
```

---

## Repair orphaned B2B signups (backfill script)

When enterprise users exist without a matching partner org, run the one-off script from **`functions/`**. It finds `users` with `channel: B2B` and `institution: PartnerDashboard`, then repairs or creates missing `partners/{id}` rows and assigns org-admin claims.

**Credentials:** Firebase Admin SDK service account JSON (Firebase Console → Project settings → Service accounts → **Generate new private key**). Do not commit the key file.

```bash
cd functions
export GOOGLE_APPLICATION_CREDENTIALS="$HOME/keys/truepay-adminsdk.json"

# Dry-run (audit only)
npm run b2b:backfill-partners

# Apply repairs
npm run b2b:backfill-partners -- --apply
```

**Typical outcomes**

| Status | Meaning |
|--------|---------|
| `ok` | User already has `partnerId` claim and partner doc |
| `would-repair-claims` / `repaired-claims` | `onboarding.registeredPartnerId` exists; claims were missing |
| `would-create-partner` / `created-partner` | No partner row — creates `pending_review` org (name from onboarding `business.name`, else email prefix) |
| `needs-manual-name` | No usable name — fix in Firestore onboarding, then re-run |

After **`--apply`**, affected users must **sign out and sign in** so **`partnerId`** / **`partnerRole`** appear on their ID token.

---

## Checklist summary

| # | Action | Endpoint |
|---|--------|----------|
| 0 | Ensure dashboard user doc (every login) | `POST /b2bPortal/portal/ensure-dashboard-profile` |
| 1 | Create partner + receive API key | `POST /b2bPortal/platform/partners` (optional `email` + `temporaryPassword` provisions org admin) **or** checklist / self-serve `POST /b2bPortal/portal/onboarding/register-partner` |
| 1b | First login set PIN (platform-provisioned) | If `GET /portal/me` → `redirectTo: "set_pin"`, call `POST /portal/account/set-pin` (verifies email) |
| 2 | Assign org admin (`uid`) | `PUT /b2bPortal/platform/partners/{partnerId}/org-admin` (skip if create included email, or self-serve register assigned you) |
| 3 | Wizard / KYB fields | `PATCH /b2bPortal/portal/onboarding` |
| 4 | Terms + submit (legacy / compliance) | `POST /b2bPortal/portal/onboarding/complete` |
| 5 | Confirm partner session | `GET /b2bPortal/portal/me` |
| 6 | Invite team | `POST /b2bPortal/portal/members` (or platform `POST .../platform/partners/{partnerId}/members`) |
| 7 | Integrate servers | `GET/POST .../partner/*` with `X-API-KEY` (live key works only after **`status: active`**) |

---

## Related documentation

- [`B2B_docs.md`](./B2B_docs.md) — full API reference, errors, and portal routes not repeated here.

**Frontend reference (partner portal repo):** onboarding logic under `src/features/onboarding/` — `provisionAccountContact.ts`, `OnboardingSignupPage.tsx`, `completeB2bSignup.ts`.
