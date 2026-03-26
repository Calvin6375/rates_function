# B2B API reference

Documentation for teams building the **B2B dashboard**, **partner admin portal**, and **server-side integrations**. All endpoints are **Firebase Cloud Functions v2** HTTP functions.

Replace placeholders when integrating:

| Placeholder | Meaning |
|-------------|---------|
| `{region}` | Function region (default in repo: `us-central1`; override with env `FUNCTIONS_REGION`) |
| `{projectId}` | Your Firebase / GCP project ID |

**Base URL pattern**

```text
https://{region}-{projectId}.cloudfunctions.net/{functionName}
```

**Functions used for B2B**

| Function name | Purpose |
|---------------|---------|
| `partner` | Machine / backend integrations — **X-API-KEY** auth |
| `b2bPortal` | Human-facing portal — **Firebase ID token** (`Authorization: Bearer`) |

Example bases:

```text
https://us-central1-your-project-id.cloudfunctions.net/partner
https://us-central1-your-project-id.cloudfunctions.net/b2bPortal
```

Append the path from each section below (e.g. `.../partner/rates`, `.../b2bPortal/platform/partners`).

---

## 1. Authentication overview

### 1.1 Partner API (`partner`) — API key

- Send header: **`X-API-KEY: <apiKey>`** (case-insensitive header name is accepted).
- The key is stored on the partner document in Firestore when the partner is created; it is **only returned once** at creation (see `POST /platform/partners`).
- Partners with `status` **`suspended`** or **`inactive`** are rejected.

### 1.2 B2B portal (`b2bPortal`) — Firebase Auth

- Send header: **`Authorization: Bearer <Firebase ID token>`**.
- The ID token must be fresh after any **custom claim** change (sign out / sign in, or force token refresh).

**Custom claims**

| Audience | Required claims | Notes |
|----------|-----------------|--------|
| **Platform super admin** (TruePay operations) | `admin: true` | Same claim as the main TruePay admin dashboard; used for `/platform/*` routes. |
| **Partner org admin** | `partnerId: "<partnerDocId>"`, `partnerRole: "org_admin"` | Set only via platform flow (`PUT .../org-admin`) or server-side; manages `/portal/members` (except self-removal / self role change). |
| **Partner team member** | `partnerId`, `partnerRole` one of the **assignable** roles below | Can call **`GET /portal/me`**. Listing/mutating members requires **`org_admin`**. |

**Roles**

| `partnerRole` | Who sets it | Meaning |
|---------------|-------------|---------|
| `org_admin` | Platform admin (`PUT .../org-admin`) | Institutional admin; single per partner; manages members. |
| `finance` | Org admin | Institutional team — use in your UI/policies for finance workflows. |
| `support` | Org admin | Support / customer-facing ops. |
| `auditor` | Org admin | Read/review-oriented access in your UI (same API surface as other members today). |
| `operations` | Org admin | Day-to-day operations. |
| `member` | Org admin | Generic team user. |
| `viewer` | Org admin | Generic read-oriented team user. |

All values except `org_admin` are stored in the member’s **custom claims** (`partnerRole`) and in **`partners/{partnerId}/members/{uid}`**.

---

## 2. Partner API (`partner`)

**CORS:** `GET`, `POST`, `OPTIONS` — allowed header **`X-API-KEY`**.

**App Check:** not enforced on this function (as deployed in code).

All routes below are relative to the **`partner`** function base URL.

### 2.1 `GET /rates`

Returns Binance P2P–based rate payload (includes fee), for the authenticated partner’s pricing context.

**Query parameters**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `fiat` | `KES` (from config) | e.g. `KES`, `NGN`, `GHS` |
| `asset` | `USDT` | Crypto asset |

**Response** `200`

```json
{ "success": true, "data": { /* marketPrice, customerPrice, feePercentage, currencyPair, … */ } }
```

**Errors** `401` invalid/missing key; `500` server error.

---

### 2.2 `POST /payments`

Records a B2B inflow: **credits the partner’s fiat wallet** and writes a **transaction record** (`b2b_payment`).

**Body (JSON)**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `amount` | number | Yes | Must be &gt; 0 |
| `currency` | string | No | Default `KES` |
| `reference` | string | No | Your reference id |
| `metadata` | object | No | Merged into transaction metadata |

**Response** `201`

```json
{
  "success": true,
  "data": {
    "transactionId": "...",
    "amount": 0,
    "currency": "KES",
    "previousBalance": 0,
    "newBalance": 0,
    "reference": null
  }
}
```

**Errors** `400` invalid amount; `401`; `500`.

---

### 2.3 `GET /transactions`

Lists **transaction records** for the authenticated partner.

**Query parameters**

| Parameter | Default | Max |
|-----------|---------|-----|
| `limit` | 50 | 100 |

**Response** `200`

```json
{ "success": true, "data": { "transactions": [ /* … */ ] } }
```

**Note:** Pagination cursor in query is not wired yet (`startAfter` TODO in backend).

---

### 2.4 `POST /checkout`

Helper endpoint: returns **amount**, **currency**, **customer-facing rate** (`customerPrice`), and **`partnerId`**. Does **not** create a payment server-side; after the customer pays through your channel, call **`POST /payments`** to record it.

**Body (JSON)**

| Field | Type | Required |
|-------|------|----------|
| `amount` | number | Yes (&gt; 0) |
| `currency` | string | No (default `KES`) |

**Response** `200`

```json
{
  "success": true,
  "data": {
    "amount": 0,
    "currency": "KES",
    "rate": 0,
    "partnerId": "...",
    "message": "Complete payment via your preferred channel; use POST /partner/payments to record after payment."
  }
}
```

---

### 2.5 `GET /settlements`

Lists settlements for this partner.

**Query parameters**

| Parameter | Default |
|-----------|---------|
| `limit` | 50 (max 100) |

**Response** `200`

```json
{ "success": true, "data": { "settlements": [ /* … */ ] } }
```

---

### 2.6 `GET /wallet`

Returns the partner’s **fiat/crypto-style balance map** in the `wallets` collection (`ownerType: partner`). Creates the wallet document if missing.

**Response** `200`

```json
{
  "success": true,
  "data": {
    "walletId": "...",
    "balances": { "USD": 0, "KES": 0, "USDT": 0 }
  }
}
```

---

### 2.7 `GET /safaricoin/balance`

Returns **SafariCoin** balance for this partner (`partnerId` as wallet id in **`safariCoinWallets`**).

**Important:** Backend **`safariCoinService` is a mock** (no blockchain). Treat as placeholder for dashboard/demo until replaced.

**Response** `200`

```json
{ "success": true, "data": { "balance": 0 } }
```

---

## 3. B2B portal API (`b2bPortal`)

**CORS:** `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS` — allowed header **`Authorization`**.

**App Check:** not enforced on this function (as deployed in code).

Paths below are relative to the **`b2bPortal`** function base URL.

### 3.1 Platform super admin — partner lifecycle

Requires Firebase ID token with **`admin: true`**.

#### `GET /platform/partners`

List all B2B partners (API keys **masked** in list items).

**Query**

| Parameter | Default | Max |
|-----------|---------|-----|
| `limit` | 50 | 100 |

**Response** `200`

```json
{
  "success": true,
  "data": {
    "partners": [ /* id, name, status, orgAdminUid, apiKeyMasked, … */ ],
    "nextPageCursor": "last-document-id-or-null"
  }
}
```

**Note:** Full cursor pagination is not fully implemented server-side (`startAfter` not exposed); `nextPageCursor` is the last doc id for future use.

---

#### `POST /platform/partners`

Creates a partner and issues an **API key** (shown **only here**).

**Body (JSON)**

| Field | Type | Required |
|-------|------|----------|
| `name` | string | Yes |
| `settlementCurrency` | string | No (default `KES`) |
| `webhookUrl` | string | No |

**Response** `201`

```json
{
  "success": true,
  "data": {
    "partnerId": "...",
    "apiKey": "<store securely>",
    "partner": { "id": "...", "name": "...", "orgAdminUid": null }
  },
  "message": "Store apiKey securely; it is only shown once. Assign org admin with PUT .../org-admin"
}
```

---

#### `GET /platform/partners/:partnerId`

Single partner detail (no raw `apiKey`; includes `apiKeyMasked` where applicable).

**Errors** `404` not found.

---

#### `PATCH /platform/partners/:partnerId`

Updates allowed partner fields.

**Body (JSON)** — any subset of:

| Field | Description |
|-------|-------------|
| `name` | Display name |
| `settlementCurrency` | e.g. `KES` |
| `webhookUrl` | Callback URL |
| `status` | e.g. `active`, `suspended`, `inactive` |
| `settlementAccount` | Bank / settlement details (object) |

**Response** `200` — payload includes **`apiKeyMasked`** if key exists.

**Errors** `404` partner not found.

---

#### `PUT /platform/partners/:partnerId/org-admin`

Assigns or **replaces** the single **org admin** Firebase user for this partner. Updates **custom claims** (`partnerId`, `partnerRole: org_admin`) and **`partners/{partnerId}/members`**. Previous org admin loses partner access when replaced.

**Body (JSON)**

| Field | Type | Required |
|-------|------|----------|
| `uid` | string | Yes — existing **Firebase Auth UID** |

**Response** `200`

```json
{
  "success": true,
  "data": { "partnerId": "...", "orgAdminUid": "..." },
  "message": "User must refresh their ID token (sign out/in) for partner claims to apply."
}
```

**Errors** `400` validation / business rules (e.g. user already org admin elsewhere); `404` partner not found.

---

#### `GET /platform/partners/:partnerId/members`

Lists all members under **`partners/{partnerId}/members`**.

**Response** `200`

```json
{
  "success": true,
  "data": {
    "members": [
      {
        "userId": "...",
        "email": "...",
        "displayName": "...",
        "role": "org_admin|member|viewer|finance|support|auditor|operations",
        "status": "active",
        "createdAt": "ISO-8601",
        "updatedAt": "ISO-8601",
        "createdByUid": "..."
      }
    ]
  }
}
```

---

#### `GET /platform/overview`

**Super-admin dashboard.** Aggregate **read-only** counts: customer-app users (Firestore `users`) and B2B partners (`partners`).

**Response** `200`

```json
{
  "success": true,
  "data": {
    "consumerUserCount": 0,
    "partnerCount": 0
  }
}
```

---

#### `GET /platform/consumer-users`

**Super-admin dashboard.** Paginated list of **customer app** profiles (`users` collection). Order is by Firestore document ID (stable cursor).

**Query**

| Parameter | Default | Max |
|-----------|---------|-----|
| `limit` | 50 | 100 |
| `startAfter` | — | Last `userId` from previous page’s `nextCursor` |

**Response** `200`

```json
{
  "success": true,
  "data": {
    "users": [
      {
        "userId": "...",
        "email": null,
        "name": null,
        "phoneNumber": null,
        "country": null,
        "kycStatus": null,
        "balance": null,
        "fiatBalance": null,
        "cryptoBalance": null,
        "currency": null,
        "createdAt": "ISO-8601",
        "updatedAt": "ISO-8601"
      }
    ],
    "nextCursor": "last-user-id-or-null"
  }
}
```

**Note:** For **writes** (balance, KYC, profile) continue to use existing **admin callables** (`adminHttp`). This route is for **listing / overview** alongside B2B partners.

---

#### `GET /platform/consumer-users/:userId`

**Super-admin dashboard.** Single consumer user summary (read-only). Large `kycData` objects may be truncated to a key list.

**Errors** `404` if no `users/{userId}` document.

---

### 3.2 Partner portal — org admin & team

Org admin must have **`partnerRole: org_admin`** and matching **`partnerId`** in the ID token.

#### `GET /portal/me`

Any B2B user with valid **`partnerId`** + **`partnerRole`** (including institutional roles below).

**Response** `200`

```json
{
  "success": true,
  "data": {
    "userId": "...",
    "partnerId": "...",
    "partnerRole": "org_admin",
    "partner": { /* getPartner shape; masked api key */ }
  }
}
```

**Errors** `403` if token lacks partner claims.

---

#### `GET /portal/members`

**Org admin only.** Lists members for the token’s `partnerId`.

**Response** `200` — same member array shape as platform `GET .../members`.

**Errors** `403` if not `org_admin`.

---

#### `POST /portal/members`

**Org admin only.** Creates a new Firebase user **or** attaches an existing user (by email) to this partner.

**Body (JSON)**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `email` | string | Yes | Normalized to lower-case |
| `role` | string | Yes | **`member`**, **`viewer`**, **`finance`**, **`support`**, **`auditor`**, or **`operations`** (not `org_admin`) |
| `password` | string | Required for **new** users | Min **8** characters |
| `password` | string | Optional for **existing** users | If provided (≥8 chars), password is updated |
| `displayName` | string | No | |

**Response** `201`

```json
{
  "success": true,
  "data": { "userId": "...", "email": "...", "role": "member" },
  "message": "User should sign in and refresh token to receive partner claims."
}
```

**Errors** `400` validation; user already on **another** partner, etc.

---

#### `PATCH /portal/members/:userId`

**Org admin only.** Updates role to any **assignable** institutional role. Cannot target the **org_admin** row or **your own** uid.

**Body (JSON)**

| Field | Type | Required |
|-------|------|----------|
| `role` | string | Yes — assignable role (not `org_admin`) |

**Response** `200` — includes message to refresh ID token.

**Errors** `400` / `404` as applicable.

---

#### `DELETE /portal/members/:userId`

**Org admin only.** Removes user from partner (clears partner claims, deletes member doc). Cannot delete yourself.

**Response** `200`

```json
{ "success": true, "message": "Member removed from partner" }
```

---

## 4. Error shape

Most failures return JSON:

```json
{ "success": false, "error": "Human-readable message" }
```

Typical HTTP status codes:

| Code | Meaning |
|------|---------|
| `401` | Missing/invalid API key or Bearer token |
| `403` | Authenticated but wrong role/claims |
| `404` | Partner or member not found |
| `400` | Validation / business rule |
| `500` | Server error |

---

## 5. Dashboard implementation checklist

1. **Platform (TruePay) super-admin UI**  
   - Use **`b2bPortal`** + user with **`admin: true`** (set via existing **`setAdminClaim`** / Console — not tied to a specific email in code).  
   - **Unified read model:** **`GET /platform/overview`**, **`GET /platform/consumer-users`**, **`GET /platform/partners`**, and partner detail / members routes.  
   - **Writes** to consumer balances/KYC still use **admin callables** (`adminHttp`), not `b2bPortal`.  
   - After **`POST /platform/partners`**, persist **`apiKey`** securely; assign institutional admin with **`PUT .../org-admin`** (Firebase **UID** must exist).

2. **Partner org admin UI**  
   - Sign in with Firebase Auth; after claims are set, **refresh the ID token**.  
   - Use **`GET /portal/me`**, **`GET/POST/PATCH/DELETE /portal/members`**.  
   - Optional: display read-only info from **`GET /platform/partners/:id`** is **not** available to org admins — use **`GET /portal/me`** + **`partner`** API with stored **API key** for operational data (wallet, rates), or build a small proxy using your backend.

3. **Server / PMS / POS integration**  
   - Use **`partner`** with **`X-API-KEY`** only (no Firebase user required).  
   - Typical flow: **`GET /rates`** → **`POST /checkout`** (optional UX helper) → collect payment → **`POST /payments`**.

4. **SafariCoin**  
   - **`GET /partner/safaricoin/balance`** only; balances are **mock** until real integration replaces `safariCoinService`.

5. **Token refresh**  
   - After any **`org-admin`** or **member role** change, affected users must obtain a **new ID token** before calling portal endpoints that rely on claims.

---

## 6. Related code (for backend maintainers)

| Area | Path |
|------|------|
| Partner HTTP app | `functions/http/partnerApi.js` |
| B2B portal HTTP app | `functions/http/b2bPortalHttp.js` |
| API key verification | `functions/libs/auth.js` (`verifyPartnerRequest`) |
| Partner Firestore CRUD | `functions/services/partnerService.js` |
| Members / org admin / institutional roles | `functions/services/b2bMemberService.js` |
| Super-admin consumer user list & counts | `functions/services/platformConsumerService.js` |
| Claim merge helper | `functions/utils/customClaimsMerge.js` |
| Exports | `functions/index.js` (`partner`, `b2bPortal`) |
