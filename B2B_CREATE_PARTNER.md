# Platform Create Partner + first-login set PIN — frontend handoff

Base URL:

```
https://us-central1-truepay-72060.cloudfunctions.net/b2bPortal
```

Auth for all routes below (except noted):

```
Authorization: Bearer <Firebase ID token>
```

---

## A) Super admin — Create partner modal

**Screen:** Users → Partners (B2B) → **+ New**

### Fields to add

| Field | Required | Notes |
|-------|----------|--------|
| Name | Yes | existing |
| Settlement currency | No | default `KES` |
| Webhook URL | No | existing |
| **Email** | Yes* | org admin login email |
| **Temporary password** | Yes* | min 8 chars; share with client out-of-band |
| Display name | No | defaults to partner name |

\*Required when provisioning a login. You can still create a partner without email (legacy), then assign org admin later via `PUT .../org-admin`.

### API

```http
POST /platform/partners
Content-Type: application/json

{
  "name": "Acme Hotels",
  "settlementCurrency": "KES",
  "webhookUrl": null,
  "email": "ops@acme.com",
  "temporaryPassword": "TempPass12",
  "displayName": "Acme Ops"
}
```

`password` is accepted as an alias for `temporaryPassword`.

### Success `201`

```json
{
  "success": true,
  "data": {
    "partnerId": "partner_…",
    "apiKey": "<show once — store securely>",
    "partner": {
      "id": "partner_…",
      "name": "Acme Hotels",
      "orgAdminUid": "…"
    },
    "orgAdmin": {
      "userId": "…",
      "email": "ops@acme.com",
      "mustChangePassword": true,
      "emailVerified": false,
      "redirectTo": "set_pin"
    }
  },
  "message": "…"
}
```

### UI after create

1. Show **API key** once (copy + warning).
2. Show **email + temporary password** so ops can share with the client (do not store the temp password in your DB).
3. Refresh partners list — org admin is already assigned (no separate org-admin step needed).

### Errors

| HTTP | `error` | Meaning |
|------|---------|---------|
| 400 | `INVALID_EMAIL` / `WEAK_PASSWORD` | Fix form validation |
| 409 | `EMAIL_IN_USE` | Email already tied to another partner |

---

## B) Partner dashboard — first login → set PIN

### Flow

```
Sign in (email + temp password)
  → GET /portal/me
  → if mustChangePassword / redirectTo === "set_pin"
       → route to /set-pin (or your Set PIN page)
       → POST /portal/account/set-pin
       → getIdToken(true)
       → continue dashboard / onboarding
  → else normal app
```

### Gate on every session bootstrap

After Firebase `signInWithEmailAndPassword` (and after token refresh):

```http
GET /portal/me
```

Relevant fields:

```json
{
  "success": true,
  "data": {
    "userId": "…",
    "partnerId": "partner_…",
    "emailVerified": false,
    "mustChangePassword": true,
    "redirectTo": "set_pin",
    "claimsNeedRefresh": true,
    "message": "First login — set a new PIN/password at /set-pin before continuing."
  }
}
```

**Routing rule:** if `data.mustChangePassword === true` **or** `data.redirectTo === "set_pin"`, **do not** enter the main app. Force the Set PIN page.

Also treat this as higher priority than onboarding / email-verification banners.

### Set PIN page

Collect:

- Temporary password (current) — prefill optional; user can retype
- New PIN / password (min 8)
- Confirm

```http
POST /portal/account/set-pin
Content-Type: application/json

{
  "temporaryPassword": "TempPass12",
  "newPassword": "NewSecure99",
  "confirmPassword": "NewSecure99"
}
```

Aliases accepted: `currentPassword`, `pin` / `newPin`, `confirmPin`.

### Success `200`

```json
{
  "success": true,
  "data": {
    "success": true,
    "emailVerified": true,
    "mustChangePassword": false,
    "redirectTo": null,
    "claimsNeedRefresh": true
  },
  "message": "PIN/password updated and email verified. Refresh your ID token (getIdToken(true))."
}
```

**Required next step on the client:**

```js
await firebaseAuth.currentUser.getIdToken(true);
// then GET /portal/me again — mustChangePassword should be false, emailVerified true
```

### Errors

| HTTP | `error` | UI |
|------|---------|-----|
| 400 | `NOT_REQUIRED` | Account already completed — leave set-pin |
| 401 | `INVALID_CURRENT_PASSWORD` | Wrong temporary password |
| 400 | `WEAK_PASSWORD` / `PASSWORD_MISMATCH` / `PASSWORD_UNCHANGED` | Form validation |

---

## C) What backend does for you

| Step | Backend effect |
|------|----------------|
| Create with email | Firebase Auth user + partner + org admin claims + `mustChangePassword` |
| First login `/portal/me` | Tells UI `redirectTo: "set_pin"` |
| `POST /portal/account/set-pin` | New password + **`emailVerified: true`** + clears flag |

No separate “send verification email” is required for this platform-provisioned path — completing set-pin verifies email.

Self-serve signup (Google / user registers themselves) is unchanged.

---

## D) Dashboard greeting (“Good morning, …”)

`GET /portal/me` includes:

```json
{ "greetingName": "Acme Hotels" }
```

| Stage | `greetingName` source |
|-------|------------------------|
| Just created (no KYB yet) | Create-partner **display name** (`greetingDisplayName`) |
| After **Business name** saved on company profile | Onboarding `business.businessName` (also synced to `partners.name`) |

Wire header: prefer `me.greetingName`, then `me.partner.name`, then local user name. Refetch `/portal/me` after saving business profile.

---

## E) Suggested frontend checklist

**Admin app**

- [ ] Add Email + Temporary password to Create partner modal
- [ ] Call updated `POST /platform/partners`
- [ ] Show one-time API key + credentials to share
- [ ] Handle `EMAIL_IN_USE` / weak password errors

**Partner app**

- [ ] After login, always call `GET /portal/me`
- [ ] If `redirectTo === "set_pin"`, hard-redirect to Set PIN page
- [ ] Wire Set PIN form → `POST /portal/account/set-pin`
- [ ] On success: `getIdToken(true)` then re-fetch `/portal/me` and enter app
- [ ] Block main nav until `mustChangePassword` is false

---

## Deploy (backend)

`POST /portal/account/set-pin` verifies the temporary password via Identity Toolkit and needs the Firebase **Web API key** on `b2bPortal` (same value as client `VITE_FIREBASE_API_KEY` / `src/firebase.ts` `apiKey`).

Secret Manager **rejects** names starting with `FIREBASE_`, so the secret is named **`WEB_API_KEY`**.

If Set PIN returns `FAILED_PRECONDITION` / `Password change is not configured (WEB_API_KEY)`:

```bash
# fetch key if needed:
firebase apps:sdkconfig web --project truepay-72060

firebase functions:secrets:set WEB_API_KEY --project truepay-72060
# paste the apiKey from sdkconfig (e.g. AIzaSy…)

firebase deploy --only functions:b2bPortal --project truepay-72060
```

This is **backend config**, not a frontend bug. The Set PIN payload is fine; without that secret bound, `b2bPortal` cannot confirm the temp password before setting the new one.

Related: [`FRONTEND_AUTH_HANDOFF.md`](./FRONTEND_AUTH_HANDOFF.md), [`B2B_docs.md`](./B2B_docs.md) (`POST /platform/partners`).
