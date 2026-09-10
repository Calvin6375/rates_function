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
| `partnerSandbox` | Public test Partner API — **static** `X-API-KEY`, in-memory mocks ([`B2B_SANDBOX.md`](./B2B_SANDBOX.md)) |
| `b2bPortal` | Human-facing portal — **Firebase ID token** (`Authorization: Bearer`) |

Example bases:

```text
https://us-central1-your-project-id.cloudfunctions.net/partner
https://us-central1-your-project-id.cloudfunctions.net/partnerSandbox
https://us-central1-your-project-id.cloudfunctions.net/b2bPortal
```

Append the path from each section below (e.g. `.../partner/rates`, `.../partnerSandbox/rates`, `.../b2bPortal/platform/partners`).

---

## 1. Authentication overview

### 1.1 Partner API (`partner`) — API key

- Send header: **`X-API-KEY: <apiKey>`** (case-insensitive header name is accepted).
- The key is stored on the partner document in Firestore when the partner is created; it is **only returned once** at creation (see `POST /platform/partners`).
- Partners with `status` **`suspended`** or **`inactive`** are rejected.

For a **separate** sandbox with a **static public** API key and its own base URL, use the **`partnerSandbox`** function — see [`B2B_SANDBOX.md`](./B2B_SANDBOX.md).

### 1.2 B2B portal (`b2bPortal`) — Firebase Auth

- Send header: **`Authorization: Bearer <Firebase ID token>`**.
- The ID token must be fresh after any **custom claim** change (sign out / sign in, or force token refresh).

**Custom claims**

| Audience | Required claims | Notes |
|----------|-----------------|--------|
| **Platform super admin** | `userType: "admin"`, `role: "super_admin"`, `admin: true`, `sessionScope: "platform_admin"` | Built-in master email. Full `/platform/*`. |
| **TruePay operations teammate** | `userType: "admin"`, `role: finance_admin \| support_admin \| operations_admin`, `admin: true`, **no `partnerId`** | Invite with **`POST /platform/admins`** (super admin). Not Partner team. |
| **Partner org admin** | `userType: "partner"`, `partnerId`, `role: "owner"` (legacy `partnerRole: "org_admin"`) | Create partner + email, or `PUT .../org-admin`. **`sessionScope: "partner"`**. `/portal/*` only. |
| **Partner team member** | `userType: "partner"`, `partnerId`, `role` finance/support/operations/viewer, `admin` must not be true | **`POST /platform/partners/{id}/members`** or `/portal/members`. That org only. |

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

**Fixture rates (no Binance):** Use **`partnerSandbox`** — see [`B2B_SANDBOX.md`](./B2B_SANDBOX.md).

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

Requires **`sessionScope: "platform_admin"`** (`userType: "admin"`). Partner sessions (`userType: "partner"`) are rejected on `/platform/*` even if leftover `admin: true` remains on the token.

**TruePay operations team** (not Partner team):

| Method | Path | Who |
|--------|------|-----|
| `POST` | `/platform/admins` | Super admin — body `{ email, role, temporaryPassword?, displayName? }`. `role`: `finance_admin` \| `support_admin` \| `operations_admin`. |
| `GET` | `/platform/admins` | Super admin — list operations teammates. |
| `DELETE` | `/platform/admins/:userId` | Super admin. |
| `GET` | `/platform/me` | Any operations teammate — `{ userType, role, admin: true, sessionScope: "platform_admin" }`. |

`POST /platform/partners` + email still creates a **partner owner** (`sessionScope: "partner"`). `POST /platform/partners/{id}/members` still creates a **partner teammate** only.

#### `GET /platform/partners`

List all B2B partners (API keys **masked** in list items).

**Query**

| Parameter | Default | Max |
|-----------|---------|-----|
| `limit`   | 50      | 100 |

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
Optionally provisions the **org admin** Firebase user with email + temporary password (Create partner modal).

**Body (JSON)**

| Field | Type | Required |
|-------|------|----------|
| `name` | string | Yes |
| `settlementCurrency` | string | No (default `KES`) |
| `webhookUrl` | string | No |
| `email` | string | No — if set, creates/assigns org admin |
| `temporaryPassword` | string | Required when `email` is set (min 8). Alias: `password` |
| `displayName` | string | No |

**Response** `201` (with org admin)

```json
{
  "success": true,
  "data": {
    "partnerId": "...",
    "apiKey": "<store securely>",
    "partner": { "id": "...", "name": "...", "orgAdminUid": "…" },
    "orgAdmin": {
      "userId": "…",
      "email": "client@hotel.com",
      "mustChangePassword": true,
      "emailVerified": false,
      "redirectTo": "set_pin"
    }
  }
}
```

Share **email + temporary password** with the client. On first login, `GET /portal/me` returns `mustChangePassword: true` and `redirectTo: "set_pin"`. They call `POST /portal/account/set-pin` to set a new password; backend marks **`emailVerified: true`**.

Without `email`, behavior is unchanged — assign later with `PUT .../org-admin`.

---

#### `GET /platform/partners/:partnerId`

Single partner detail (includes `apiKey` for platform admins where applicable).

Also includes **`onboardingOwner`**: contact from the org admin’s `onboarding/{orgAdminUid}.owner` map (`fullName`, `phone`, `role` / job title). Distinct from member role `"owner"`. `null` if no org admin or no owner contact saved.

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

#### `GET /platform/reports`

**Super-admin Reports & Analytics.** Revenue is **TruePay service fees** (not face amounts), broken down by **collection**, **pay**, **send**, and **exchange**. Same host and Bearer token as `GET /platform/dashboard`.

Do **not** reuse `GET /platform/dashboard` for this page — that overview sums transaction face amounts.

**Partner:** `GET /portal/reports` (same `period`; scoped to the caller’s `partnerId`; no `channel=all`).

**Query**

| Parameter | Default | Notes |
|-----------|---------|--------|
| `period` | `month` | `month` (calendar this month), `7d`, `30d`, `90d` |
| `partnerId` | — | Super admin only; restrict to one partner |

**What counts as revenue**

| Bucket | Sources | Fee field |
|--------|---------|-----------|
| `collection` | B2B payment links / checkout (`b2b_payment`) | `metadata.platformFee` |
| `pay` | C2B Till / PayBill (`MPESA_B2B`, `merchant_payment`) | payout `fee` |
| `send` | C2B B2C / bank / SafariTap and B2B send | payout `fee` or `fees.ourFee` (not rail `paymentFee`) |
| `exchange` | Swap orders | order `fee` (converted to KES when `exchangeRate` is present) |

Local top-up / Add Money surcharge is **not** included.

**Response** `200` — map KPIs from `data.kpis` / `data.summary`; Sales Overview from `data.salesChart` (`amount` is fee revenue); Revenue by Channel from `data.revenueByChannel`. Export can download this JSON.

```json
{
  "success": true,
  "data": {
    "scope": "platform",
    "period": { "key": "month", "label": "This month" },
    "currency": "KES",
    "revenueMeaning": "service_fee",
    "summary": {
      "totalRevenue": 0,
      "previousRevenue": 0,
      "transactionCount": 0,
      "completedCount": 0,
      "conversionRate": 0,
      "averageOrder": 0,
      "averageFee": 0
    },
    "breakdown": {
      "collection": { "revenue": 0, "count": 0, "unconverted": 0, "currency": "KES" },
      "pay": { "revenue": 0, "count": 0, "unconverted": 0, "currency": "KES" },
      "send": { "revenue": 0, "count": 0, "unconverted": 0, "currency": "KES" },
      "exchange": { "revenue": 0, "count": 0, "unconverted": 0, "currency": "KES" }
    },
    "revenueByChannel": [
      { "key": "collection", "label": "Collection", "revenue": 0, "count": 0, "currency": "KES" }
    ],
    "salesChart": { "granularity": "day", "current": [], "previous": [] }
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

**Note:** List / overview only. To **edit** a Safari Tap / C2B profile from the Users table use **`PATCH /platform/users/:userId`**. Balance adjustments remain on admin callables (`updateUserBalance`).

---

#### `PATCH /platform/users/:userId`

**Super-admin dashboard.** Edit a Firestore `users/{userId}` profile and sync Firebase Auth (email, display name, phone, disabled).

**Auth:** Bearer Firebase ID token + **super admin only** (master email or `userType: admin` + `role: super_admin`). Other platform admin roles get `403`.

**Body** (at least one field):

```json
{
  "firstName": "Abdullahi",
  "lastName": "Hassan",
  "name": "Abdullahi Hassan",
  "email": "abdalaalifanax@gmail.com",
  "phoneNumber": "+254712137171",
  "country": "KE",
  "status": "active"
}
```

| Field | Notes |
|-------|--------|
| `email` | Same C2B validation as `POST /api/register` (rejects `gmail.coma`) |
| `phoneNumber` | E.164, e.g. `+254712137171` |
| `status` | `active` or `inactive` (also accepts `Active` / `Inactive`). Inactive disables Auth. |
| `name` | Optional; otherwise rebuilt from `firstName` + `lastName` |

Does **not** change balances, `channel`, `institution`, or partner roles.

**Response** `200`

```json
{
  "success": true,
  "data": {
    "userId": "...",
    "updatedFields": ["email"],
    "user": { "userId": "...", "email": "...", "status": "active" }
  }
}
```

**Errors:** `400` invalid fields, `403` cannot edit owner/admin (unless super-admin) or deactivate yourself, `404` missing user, `409` email already in Auth.

---

#### `POST /platform/notifications`

**Super admin only.** Compose a custom in-app notification + FCM push.

**Auth:** Bearer Firebase ID token + super admin.

**Body**

```json
{
  "title": "Rates update",
  "message": "UGX top-ups are live in Safari Tap.",
  "userId": "vFEshV4ZdYOrnEGKKAwWRq6K44G2",
  "userIds": ["uid_2", "uid_3"],
  "audience": "c2b",
  "actionUrl": "/wallet"
}
```

| Field | Required | Notes |
|-------|----------|--------|
| `title` | Yes | Max 80 chars |
| `message` | Yes | Max 500 chars |
| `userId` | One of | Single recipient |
| `userIds` | One of | Up to 100 explicit UIDs |
| `audience` | One of | `"c2b"` (or `"all"`) — up to 300 C2B `users` |
| `actionUrl` | No | Optional deep link for the app |

Push is sent only when `users/{uid}.fcmToken` is set. Inbox row is always written.

**Response** `200`

```json
{
  "success": true,
  "data": {
    "requested": 1,
    "inboxWritten": 1,
    "pushSent": 1,
    "failed": 0,
    "results": [{ "userId": "...", "notificationId": "...", "pushSent": true }]
  }
}
```

**Errors:** `400` missing title/message/targets, `403` not super admin.

---

#### `GET /platform/consumer-users/:userId`

**Super-admin dashboard.** Single consumer user summary (read-only). Large `kycData` objects may be truncated to a key list.

**Errors** `404` if no `users/{userId}` document.

---

### 3.2 Partner portal — org admin & team

Org admin must have **`partnerRole: org_admin`** and matching **`partnerId`** in the ID token.

#### `POST /portal/account/change-password`

**Account Settings → Password & Security → Update Password.** Any authenticated Firebase user (Bearer ID token).

**Body (JSON)**

| Field | Required | Notes |
|-------|----------|--------|
| `currentPassword` | Yes | Min 8 characters |
| `newPassword` | Yes | Min 8; must differ from current |
| `confirmPassword` | No | If sent, must equal `newPassword` |

**Response** `200`

```json
{ "success": true, "message": "Password updated. Sign in again on other devices if needed." }
```

**Errors**

| HTTP | `error` | When |
|------|---------|------|
| `400` | `NO_PASSWORD_PROVIDER` | Google-only (or other OAuth) account — no password to change |
| `400` | `WEAK_PASSWORD` / `PASSWORD_MISMATCH` / `PASSWORD_UNCHANGED` | Validation |
| `401` | `INVALID_CURRENT_PASSWORD` | Wrong current password |
| `503` | `FAILED_PRECONDITION` | `WEB_API_KEY` secret not configured on the function |

#### `POST /portal/account/request-password-reset`

**Forgot password** (public — no auth). Sends Firebase Auth reset email. Unknown emails still return success.

**Body:** `{ "email": "ops@hotel.com", "continueUrl?": "https://theadmin.truepay.live/login" }`

**Response** `200` — `{ "success": true, "message": "If an account exists…" }`

Callable equivalent (consumer app): **`requestPasswordReset`**.

#### `POST /portal/ensure-dashboard-profile`

**Any authenticated user** (Bearer Firebase ID token). Idempotently creates or patches the Firestore **`users/{uid}`** document (same shape as `userBootstrap`). Use this **immediately after** email/password sign-in if the dashboard loads profile data from the `users` collection (including queries by email). Does not require B2B partner claims.

**Response** `200` — `{ "success": true, "message": "Dashboard profile ensured" }`

**Errors** `401` if token missing/invalid.

#### `POST /portal/send-verification-email`

**Any authenticated user**. Generates a Firebase email-verification link, rewrites it to **`GET /public/verify-email`**, and sends a TruePay-branded Zoho email (From address = Secret Manager `SMTP_USER`).

**Click flow:** user opens link → backend applies `oobCode` → **HTTP 302** to the B2B dashboard (`https://theadmin.truepay.live/` by default, or `continueUrl`) with `?emailVerified=1`.

**Required client change:** stop calling Firebase Auth `sendEmailVerification()` / `currentUser.sendEmailVerification()`. Use this endpoint (or the callable below) only.

**Body (JSON, optional)**

| Field | Description |
|-------|-------------|
| `continueUrl` | Post-verify dashboard URL (default **`B2B_DASHBOARD_URL`** / `https://theadmin.truepay.live`). Must be an allowed host. |
| `canHandleCodeInApp` | `true` for mobile deep-link handling |

**Response** `200`

```json
{
  "success": true,
  "data": {
    "alreadyVerified": false,
    "email": "user@example.com",
    "continueUrl": "https://theadmin.truepay.live/"
  }
}
```

**Errors** `401` unauthenticated · `400` bad `continueUrl` · `503` SMTP not configured

#### `GET /public/verify-email`

**Unauthenticated.** Email click target. Query: `oobCode`, `continueUrl`, `mode`. Applies verification then redirects to the dashboard. Do not call from app JS — users hit this from the email link.

Callable equivalent: **`sendEmailVerification`** (same payload; requires Auth).

#### `GET /portal/me`

- Partner users with **`partnerId` + role** on the token: full partner session.
- Platform admins without partner claims: admin session (`partnerId: null`).
- **Mid-onboarding** (common after **Google signup**): **200** with `partnerId` (if org was auto-provisioned), `owner`, `onboardingStatus`, `claimsNeedRefresh`, `onboardingIncomplete` — **not** 403. Refresh the ID token when `claimsNeedRefresh` is true.

**Response** `200` (partner session)

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

**Response** `200` (mid-onboarding / claims not on token yet)

```json
{
  "success": true,
  "data": {
    "userId": "...",
    "partnerId": "partner_… or null",
    "partnerRole": null,
    "emailVerified": true,
    "onboardingStatus": "credentials_ready",
    "owner": { "fullName": "…", "phone": "…", "role": "Founder" },
    "claimsNeedRefresh": true,
    "onboardingIncomplete": false
  }
}
```

---

#### `GET /portal/members`

**Org admin only.** Lists members for the token’s `partnerId`.

**Response** `200` — same member array shape as platform `GET .../members`.

**Errors** `403` if not `org_admin`.

---

#### `GET /portal/profile-qr`

**Any partner role** with `partnerId` claims. Returns the **merchant profile QR** (open amount) plus **`merchantId`**. This is **not** a product payment-link QR (`/l/:linkId`).

SafariTap Pay scans this QR (or the payer types `merchantId`) and enters an amount from their KES wallet. Funds credit the partner wallet as `b2b_payment` with `metadata.source = "truepay_merchant_profile"`.

**Response** `200`

```json
{
  "success": true,
  "data": {
    "kind": "profile",
    "merchantId": "partner_…",
    "partnerId": "partner_…",
    "partnerName": "Tru Pay",
    "status": "active",
    "acceptingPayments": true,
    "settlementCurrency": "KES",
    "payUrl": "https://…/b2bPortal/p/partner_…",
    "qrPayload": "https://…/b2bPortal/p/partner_…",
    "qrCode": "data:image/png;base64,…",
    "instructions": "Display this QR for SafariTap Pay. …"
  }
}
```

Dashboard: show `qrCode` (or encode `qrPayload` / `payUrl` locally) and copyable **`merchantId`**. Put this on **Business Profile**, not on product Payment Links.

Platform admin: **`GET /platform/partners/:partnerId/profile-qr`** (same payload).

Public helpers (no auth):

| Method | Path | Use |
|--------|------|-----|
| `GET` | `/p/:merchantId` | HTML fallback if a generic camera opens the QR URL |
| `GET` | `/public/merchants/:merchantId` | JSON name + `merchantId` |
| `POST` | `/public/qr/resolve` | Body `{ "payload": "<scanned string>" }` — `kind: profile` or `kind: product` |

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
   - For **integration tests / demos** without a real partner key, use **`partnerSandbox`** ([`B2B_SANDBOX.md`](./B2B_SANDBOX.md)).

4. **SafariCoin**  
   - **`GET /partner/safaricoin/balance`** (live) or **`GET /partnerSandbox/safaricoin/balance`** (full sandbox fixture); backend **`safariCoinService`** is still **mock** (no blockchain) for the live path.

5. **Token refresh**  
   - After any **`org-admin`** or **member role** change, affected users must obtain a **new ID token** before calling portal endpoints that rely on claims.

---

#### `POST /portal/onboarding/request-go-live`

Partner owner asks platform super admin to activate the live Partner API.

**Auth:** Bearer Firebase ID token · **email verified** · partner owner

**Body (optional):** `{ "note": "Ready for production" }`

**Response** `201` / `200`

```json
{
  "success": true,
  "data": {
    "partnerId": "partner_…",
    "goLiveRequested": true,
    "alreadyRequested": false,
    "alreadyLive": false,
    "notificationId": "…"
  }
}
```

Creates a **system** notification (`go_live_request_admin_alert`) visible to super admins via `notificationsApi` with `userId=system`. Ops then `PATCH /platform/partners/{id}` `{ "status": "active" }`.

---

### Platform admin — partner wallet credit / debit

Manual top-up (same idea as C2B `POST /api/customer-wallets/:id/credit`):

| Method | Path |
|--------|------|
| `GET` | `/platform/partners/:partnerId/wallet` |
| `POST` | `/platform/partners/:partnerId/wallet/credit` |
| `POST` | `/platform/partners/:partnerId/wallet/debit` |

Frontend handoff: [`B2B_ADMIN_WALLET.md`](./B2B_ADMIN_WALLET.md).

---

## 5b. Send / Pay (outbound)

Partner Send UI: recipients, corridor quote, create payment.

| Method | Path |
|--------|------|
| `GET/POST` | `/portal/send/recipients` |
| `GET/PATCH/DELETE` | `/portal/send/recipients/:recipientId` |
| `POST` | `/portal/send/quote` |
| `GET` | `/portal/send/corridors` |
| `POST/GET` | `/portal/send/payments` |
| `GET` | `/platform/send/payments` (platform admin) |
| `PATCH` | `/platform/send/payments/:paymentId` (super admin — success or fail + reversal) |

Full contract: [`B2B_SEND.md`](./B2B_SEND.md).

---

## 5c. Add Money — partner KES self-topup (Paystack)

Dashboard **Pay → Add Money** funds the partner **KES** wallet via Paystack hosted checkout.

| Method | Path |
|--------|------|
| `POST` | `/portal/funding/checkout` |
| `GET` | `/portal/funding/orders/:orderId` |
| `POST` | `/portal/funding/confirm` |

Full frontend contract: [`B2B_ADD_MONEY.md`](./B2B_ADD_MONEY.md).

---

## 6. Related code (for backend maintainers)

| Area | Path |
|------|------|
| Partner HTTP app | `functions/http/partnerApi.js` |
| Partner sandbox HTTP app | `functions/http/partnerSandboxHttp.js` |
| Sandbox in-memory logic | `functions/services/b2bSandboxPartnerService.js` |
| B2B portal HTTP app | `functions/http/b2bPortalHttp.js` |
| B2B Add Money bridge | `functions/services/funding/b2bFundingBridgeService.js` |
| API key verification | `functions/libs/auth.js` (`verifyPartnerRequest`) |
| Partner Firestore CRUD | `functions/services/partnerService.js` |
| Members / org admin / institutional roles | `functions/services/b2bMemberService.js` |
| Super-admin consumer user list & counts | `functions/services/platformConsumerService.js` |
| Claim merge helper | `functions/utils/customClaimsMerge.js` |
| Exports | `functions/index.js` (`partner`, `partnerSandbox`, `b2bPortal`) |
