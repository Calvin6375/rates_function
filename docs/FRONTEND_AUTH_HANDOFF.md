# TruePay identity & access — frontend handoff

Notes for the **C2B Flutter app** and **B2B / Admin web** teams. Backend implementation lives in `functions/utils/accessControl.js` and related services.

**Do not hardcode passwords.** The built-in super-admin account is identified by email only (`MASTER_ADMIN_EMAIL`, default `calvinrumba8@gmail.com`). Password is set once in Firebase Console or via a secure ops process, then rotated on first login.

---

## Shared model (all clients)

### Identity provider

Firebase Authentication — single IdP for consumer app, partner dashboard, and admin dashboard.

### After login

1. Sign in with Firebase Auth.
2. Read custom claims from the **ID token** (`getIdTokenResult()` / equivalent).
3. Route the user by `userType`.
4. When claims change (onboarding, role assignment), **force token refresh** before calling APIs:
   - Flutter: `user.getIdToken(true)`
   - Web: `user.getIdToken(true)` then retry API calls

### Password — Account Settings (B2B web)

**Update password** (logged in — matches Current / New / Confirm form):

```http
POST /b2bPortal/portal/account/change-password
Authorization: Bearer <idToken>
Content-Type: application/json

{
  "currentPassword": "…",
  "newPassword": "…",
  "confirmPassword": "…"
}
```

- On success: toast + clear the form. Optionally re-auth or `signOut` other devices is not required server-side.
- `NO_PASSWORD_PROVIDER` (400): Google-only account — hide the form or show “Use Google sign-in / set a password via forgot-password after linking email”.
- `INVALID_CURRENT_PASSWORD` (401): wrong current password.

### Platform-created partners — first login → set PIN

Super admin **Create partner** may include `email` + `temporaryPassword`. That user signs in on the partner dashboard; then:

1. Call `GET /b2bPortal/portal/me`
2. If `data.mustChangePassword === true` (or `redirectTo === "set_pin"`), route to the **set new PIN** page (do not enter the main app)
3. Submit:

```http
POST /b2bPortal/portal/account/set-pin
Authorization: Bearer <idToken>
Content-Type: application/json

{
  "temporaryPassword": "<temp from admin>",
  "newPassword": "<new pin/password>",
  "confirmPassword": "<same>"
}
```

4. On success: `emailVerified` becomes **true**, `mustChangePassword` clears. Call `getIdToken(true)`, then continue onboarding / dashboard.

Aliases accepted: `currentPassword`, `pin` / `newPin`, `confirmPin`.

**Forgot password** (login page, no token):

```http
POST /b2bPortal/portal/account/request-password-reset
Content-Type: application/json

{ "email": "ops@hotel.com", "continueUrl": "https://theadmin.truepay.live/login" }
```

Requires server secret `WEB_API_KEY` (same as client Firebase web API key).

### Email verification — use TruePay backend only

**Do not** call Firebase’s built-in mailer anywhere (Flutter or web):

```dart
// ❌ Do not use — sends Firebase’s default template
await FirebaseAuth.instance.currentUser!.sendEmailVerification();
```

```js
// ❌ Do not use
await sendEmailVerification(auth.currentUser);
```

Instead, call our backend (authenticated). It verifies the caller, generates the link with the Admin SDK, and sends a TruePay-branded email via Zoho SMTP.

| Client | Call |
|--------|------|
| **B2B / Admin web** | `POST /b2bPortal/portal/send-verification-email` with `Authorization: Bearer <idToken>` |
| **Flutter / any Firebase client** | Callable `sendEmailVerification` |

**Default `continueUrl`:** `https://theadmin.truepay.live/` (B2B dashboard). Override only if needed.

**Click → dashboard (backend handles this):** the email link hits `GET /b2bPortal/public/verify-email`, which applies the code and **302-redirects** to the dashboard with `?emailVerified=1`. No Firebase interstitial page.

**B2B web — after landing with `?emailVerified=1`:** refresh the Auth session so gated APIs see `email_verified`:

```js
if (new URLSearchParams(location.search).get("emailVerified") === "1") {
  if (auth.currentUser) {
    await auth.currentUser.reload();
    await auth.currentUser.getIdToken(true);
  }
  // optionally strip the query param and continue onboarding / dashboard
}
```

**Flutter example**

```dart
await FirebaseFunctions.instance
    .httpsCallable('sendEmailVerification')
    .call(<String, dynamic>{
      // optional — defaults to B2B dashboard
      'continueUrl': 'https://theadmin.truepay.live/',
    });
```

**Web (B2B portal) example**

```js
await fetch(`${B2B_PORTAL_BASE}/portal/send-verification-email`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${await user.getIdToken()}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({}), // continueUrl defaults to dashboard
});
```

After the user clicks the link, they land on the dashboard automatically. Force-refresh the ID token before calling gated APIs (e.g. `register-partner`).

### Claim shapes (new — preferred)

| User type | Claims on ID token |
|-----------|-------------------|
| Customer | `{ "userType": "customer" }` |
| Partner | `{ "userType": "partner", "partnerId": "partner_123", "role": "owner" }` |
| Platform admin | `{ "userType": "admin", "role": "super_admin" \| "operations_admin" \| "support_admin" \| "finance_admin" }` |

### Legacy claims (still accepted during migration)

| Legacy | Maps to |
|--------|---------|
| No `userType`, no partner claims | Treat as customer if signed up via C2B only |
| `admin: true` | Platform admin (`super_admin` unless `role` is set) |
| `partnerId` + `partnerRole: "org_admin"` | Partner `role: "owner"` |
| `partnerRole: "member"` | Partner `role: "viewer"` |

Backend writes **both** new and legacy partner claims during migration so older tokens keep working until users refresh.

### Dashboard routing

```text
Login → Firebase Auth → read claims → route:

  userType === "customer"  → C2B app (Flutter)
  userType === "partner"   → https://partner.truepay.africa
  userType === "admin"     → https://admin.truepay.africa
```

If `userType` is missing, use legacy rules:

- `partnerId` present → partner dashboard
- `admin === true` or known super-admin email → admin dashboard
- otherwise → customer app (if profile exists) or onboarding/signup

---

## C2B Flutter app team

### What changed on the backend

- `POST /api/register` now sets `{ userType: "customer" }` on the Firebase user and writes `userType: "customer"`, `status: "active"` on `users/{uid}`.
- No partner or admin claims are ever set from C2B registration.

### What you should implement

1. **Post-login routing**
   - After `signInWithEmailAndPassword` (or other provider), call `getIdTokenResult()`.
   - If `claims.userType === "customer"` → stay in consumer app.
   - If `claims.userType === "partner"` → deep-link or open partner dashboard URL (do not treat as consumer).
   - If `claims.userType === "admin"` → deep-link or open admin dashboard URL.

2. **Registration**
   - Keep sending `Institution: "Customer App"` and `Channel: "C2B"` on register (unchanged).
   - After successful register + sign-in, expect `userType: "customer"` on token (may require one token refresh right after register).

3. **Token refresh**
   - Refresh ID token after any backend action that might change claims (rare for pure customers).
   - Always send `Authorization: Bearer <idToken>` to Cloud Functions / REST APIs.

4. **Do not rely on**
   - Firestore `users/{uid}.permissions` for API security (UI-only for some dashboards).
   - `institution` / `channel` alone for routing — use `userType` from token first.

5. **Edge cases**
   - User with partner claims opening the consumer app → show message and link to partner dashboard (wrong app).
   - User with no `userType` and no partner/admin claims → treat as legacy customer if `users/{uid}` exists.

### Customer claim example

```json
{
  "userType": "customer"
}
```

---

## B2B partner dashboard & admin web team

Hosts: **Partner** `https://partner.truepay.africa` · **Admin** `https://admin.truepay.africa`

### What changed on the backend

| Area | Change |
|------|--------|
| Partner owner role | `org_admin` → **`owner`** (legacy `partnerRole: org_admin` still on token during migration) |
| Assignable partner roles | **`finance`**, **`support`**, **`operations`**, **`viewer`** (removed `member` / `auditor` for new invites; legacy values normalized to `viewer`) |
| Platform admins | New `userType: "admin"` + `role` (`super_admin`, `operations_admin`, `support_admin`, `finance_admin`) |
| `GET /portal/me` | Returns `userType`, `role`, plus `partnerRole` (legacy alias) for partner users |
| `GET /platform/me` | Returns `userType`, `role` for admin users |
| Member APIs | Owner-only mutations (was org_admin-only) |

### Partner roles (separate from platform admin roles)

| Role | Capabilities (product-level; enforce in UI) |
|------|---------------------------------------------|
| `owner` | Full partner portal: members, payment links, onboarding, settings |
| `finance` | Finance-oriented views |
| `support` | Support tools, read users/transactions as allowed |
| `operations` | Operations-oriented portal features |
| `viewer` | Read-heavy access |

Backend enforces **owner** for: member CRUD, payment-link mutations, onboarding completion.

### Platform admin roles

| Role | Typical UI access |
|------|-------------------|
| `super_admin` | Full platform — only built-in account (`calvinrumba8@gmail.com` unless env override) |
| `operations_admin` | Partners, onboarding approval, settlements, transactions — not platform settings |
| `support_admin` | Users, partners, support tools — not settlements approval |
| `finance_admin` | Transactions, settlements, reports — not user management |

Only **`super_admin`** can grant/revoke platform admin roles (`setAdminClaim` callable).

### What you should implement

1. **Login routing (both web apps)**
   ```javascript
   const { claims } = await user.getIdTokenResult(true);
   switch (claims.userType) {
     case "admin":
       if (onPartnerSite) redirectToAdminDashboard();
       break;
     case "partner":
       if (onAdminSite && !claims.admin) redirectToPartnerDashboard();
       break;
     case "customer":
       redirectToConsumerAppOrBlock();
       break;
     default:
       // legacy
       if (claims.partnerId) usePartnerDashboard();
       else if (claims.admin) useAdminDashboard();
   }
   ```

2. **Replace `org_admin` checks in UI**
   - Use `role === "owner"` **or** legacy `partnerRole === "org_admin"`.
   - Prefer `GET /portal/me` response: `role` (normalized) + `partnerRole` (legacy).

3. **After onboarding / role changes**
   - Call `getIdToken(true)` before `GET /portal/me` or any `/portal/*` write.
   - Show “refresh session” if API returns 403 after claim assignment.

4. **Signup bootstrap (unchanged flow, new fields)**
   - After Firebase sign-in: `POST /b2bPortal/portal/ensure-dashboard-profile` with `Institution: "PartnerDashboard"`, `Channel: "B2B"`.
   - Onboarding: `POST /portal/onboarding/register-partner` (requires **verified email** on token).
   - Successful registration assigns **`owner`** + `partnerId`.

5. **Admin dashboard**
   - Gate `/platform/*` API calls on `userType === "admin"` (or legacy `admin === true`).
   - Use `role` for feature flags (e.g. hide “Platform settings” unless `super_admin`).
   - `GET /platform/me` returns `{ userType, role, admin: true }`.

6. **Member management UI**
   - Role dropdown options: `finance`, `support`, `operations`, `viewer` (not `org_admin` — owner is assigned by platform or self-serve register-partner).
   - Display label “Owner” for `owner` / legacy `org_admin`.

7. **Notifications**
   - Default inbox = caller’s `uid`.
   - System inbox (`userId=system`) only for platform super-admin tokens.
   - Do not pass `userId=system` unless user is super admin.

### API session payloads

**Partner — `GET /portal/me`**

```json
{
  "userId": "...",
  "userType": "partner",
  "role": "owner",
  "partnerId": "partner_123",
  "partnerRole": "org_admin",
  "roleLegacy": "org_admin",
  "partner": { "id": "partner_123", "name": "..." }
}
```

**Google / mid-onboarding:** If the token has no `partnerId` yet, this returns **200** (not 403) with `owner`, `onboardingStatus`, `claimsNeedRefresh`, and possibly `partnerId` after auto-provision. When `claimsNeedRefresh` is true, call `getIdToken(true)` then retry. Use `GET /portal/onboarding` for the checklist; never block the whole shell on a hard 403 from `/portal/me`.

**Admin — `GET /platform/me`**

```json
{
  "userId": "...",
  "userType": "admin",
  "role": "operations_admin",
  "admin": true,
  "email": "..."
}
```

### Firestore (read-only awareness)

| Collection | Purpose |
|------------|---------|
| `users/{uid}` | Profile; includes `userType`, `role`, `partnerId`, `status` when synced |
| `partners/{partnerId}/members/{uid}` | Partner membership + role |
| `platformAdmins/{uid}` | Platform admin role registry (backend-managed) |

Clients should **not** write claims or `platformAdmins` directly — all via backend / callables.

---

## Ops: bootstrap super-admin (not frontend)

From `functions/` (no password in script):

```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json npm run auth:bootstrap-super-admin
GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json npm run auth:bootstrap-super-admin -- --apply
```

Then set password in Firebase Console → Authentication and rotate on first login.

---

## Migration checklist (frontend)

- [ ] Read `userType` + `role` from ID token on every app launch
- [ ] Replace hardcoded `org_admin` checks with `owner` (+ legacy fallback)
- [ ] Force token refresh after onboarding complete / member role change
- [ ] Split admin vs partner routing by host + claims
- [ ] Update role pickers to new partner role list
- [ ] Admin UI: feature-gate by `role` (not only `admin: true`)
- [ ] Remove any hardcoded super-admin passwords from docs, env samples, or tests
- [ ] Replace all `sendEmailVerification()` / client Auth mailers with `sendEmailVerification` callable or `POST /portal/send-verification-email`

---

## Related backend docs

- [`auth.md`](./auth.md) — full backend auth reference
- [`onboarding.md`](./onboarding.md) — B2B signup and API checklist
