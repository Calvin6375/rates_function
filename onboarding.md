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
| 1 | Create partner + receive API key | `POST /b2bPortal/platform/partners` |
| 2 | Assign org admin (`uid`) | `PUT /b2bPortal/platform/partners/{partnerId}/org-admin` |
| 3 | (Optional) Ensure user profile doc | `POST /b2bPortal/portal/ensure-dashboard-profile` |
| 4 | Confirm partner session | `GET /b2bPortal/portal/me` |
| 5 | Invite team | `POST /b2bPortal/portal/members` (or platform `POST .../platform/partners/{partnerId}/members`) |
| 6 | Integrate servers | `GET/POST .../partner/*` with `X-API-KEY` |

---

## Related documentation

- [`B2B_docs.md`](./B2B_docs.md) — full API reference, errors, and portal routes not repeated here.
