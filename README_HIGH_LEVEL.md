# TruePay Backend — High Level Overview

## What is TruePay?

TruePay is a Firebase-based backend for a cryptocurrency exchange and payments platform serving African markets. It powers:

- **Consumer app (C2B)** — users exchange USD for local fiat (KES, NGN, GHS) via USDT using Binance P2P rates, top up wallets through IntaSend, and run swap / send-money flows.
- **B2B partners** — hotels, lodges, fintechs, and similar businesses integrate via API key, manage teams in a portal, collect payments through hosted payment links, and settle to bank accounts.
- **Platform operations** — TruePay staff use admin callables and the B2B super-admin portal to manage users, partners, and compliance.

Firebase project ID in this repo: **`truepay-72060`**. Default region: **`us-central1`**.

---

## Core Functionality

### 1. Exchange rate services

- Fetches USDT P2P rates from Binance for KES, NGN, GHS
- Applies configurable service fees (default 1.5% from Firestore `config/fees`)
- Arbitrage paths for USD → USDT → local fiat
- Scheduled rate jobs and Firestore / Realtime Database caching (5–10 minute validity)

### 2. Consumer payment processing

- **IntaSend** — mobile money checkout, webhooks, wallet top-ups
- **TransFi** — additional top-up webhook path
- Callables: `createPayment`, `createDirectTopup`, `createDirectPayout`, `createSwapOrder`, `createSendMoneyOrder`
- Webhooks: `handleTopUpWebhook`, `handleTransFiTopUpWebhook`, `handlePaymentWebhook`
- Idempotent processing; HMAC / challenge verification on webhooks

### 3. Wallet management

- **Firestore** — master balances and transaction history
- **Realtime Database** — fast cache at `wallet/{userId}/fiat/{currency}` (clients should read here)
- **Partner wallets** — separate `wallets` collection with `ownerType: 'partner'`
- Balance writes sync to RTDB via shared helpers (not a separate exported trigger)

### 4. User management

- Firebase Authentication
- `userBootstrap` callable and `onUserCreated` trigger initialize profiles and wallets
- KYC status tracking; supported countries config
- `onAuthUserDeleted` cleans up Firestore / RTDB user data

### 5. Admin dashboard (consumer)

- Admin callables in `adminHttp.js` (balance adjust, KYC, commission config, IntaSend status, orphan pruning)
- Custom claim helpers: `setAdminClaim`, `removeAdminClaim`
- Sensitive REST routes on `api` require Firebase custom claim **`admin: true`**

### 6. B2B platform

Three HTTP surfaces (see [`B2B_docs.md`](./B2B_docs.md)):

| Function | Auth | Purpose |
|----------|------|---------|
| **`partner`** | `X-API-KEY` | Live machine API — rates, payments, wallet, settlements, SafariCoin balance |
| **`partnerSandbox`** | Static public `X-API-KEY` | Integration testing — in-memory mocks, no real funds ([`B2B_SANDBOX.md`](./B2B_SANDBOX.md)) |
| **`b2bPortal`** | Firebase Bearer | Partner dashboard + platform super-admin |

**Partner portal highlights**

- Self-serve onboarding wizard (`onboarding/{uid}`): KYC fields, partner registration, checklist progress
- **Checklist flags** (from `GET /portal/onboarding`):
  - `progress.testTransactionDone` — set when a sandbox test payment is recorded ([`B2B_SANDBOX_DASHBOARD_FRONTEND.md`](./B2B_SANDBOX_DASHBOARD_FRONTEND.md))
  - `progress.goLiveDone` — set when partner `status` is **`active`** (super admin `PATCH /platform/partners/{id}`)
- Portal sandbox routes: `GET/POST /portal/sandbox/transactions|payments` (Firestore-backed test history)
- **Payment links** — hosted IntaSend checkout at `b2bPortal/l/{linkId}`; org-wide reusable product links
- Org admin manages members and roles via custom claims (`partnerId`, `partnerRole`)

**Platform super-admin** (`/platform/*`): partners CRUD, org-admin assignment, payment links, transactions overview, consumer user management.

---

## Architecture

Exports live in `functions/index.js`. Business logic sits in **`services/`**; HTTP handlers in **`http/`** are thin controllers.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                     Firebase Cloud Functions (v2)                              │
│  Scheduled · Callable · HTTP · Webhooks · Firestore / Auth triggers           │
└─────────────────────────────────────────────────────────────────────────────────┘

   CONSUMER APP                 B2B INTEGRATIONS              B2B PORTAL
   Firebase Auth                X-API-KEY                     Bearer + claims
        │                       (partners.apiKey)             (admin / partnerId)
        ▼                              │                                │
 ┌──────────────┐              ┌──────────────┐              ┌──────────────┐
 │ api          │              │ partner      │              │ b2bPortal    │
 │ transactions │              │ partnerSandbox│             │              │
 │ notifications│              │              │              │ /platform/*  │
 │ callables    │              │ rates        │              │ /portal/*    │
 │ webhooks     │              │ payments     │              │ onboarding   │
 └──────┬───────┘              │ checkout     │              │ payment links│
        │                      │ wallet, tx   │              │ sandbox tests│
        │                      └──────┬───────┘              └──────┬───────┘
        │                             │                             │
        └─────────────────────────────┼─────────────────────────────┘
                                      ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ services/ · libs/                                                             │
 │ walletService · transactionService · partnerService · paymentLinkService ·    │
 │ b2bOnboardingService · b2bPortalSandboxService · paymentRailService · …       │
 └──────────────────────────────────────────────────────────────────────────────┘
                                      │
         ┌────────────────────────────┼────────────────────────────┐
         ▼                            ▼                            ▼
 ┌───────────────┐           ┌───────────────┐           ┌───────────────┐
 │ Firestore     │           │ Realtime DB   │           │ External APIs │
 │ users, orders │           │ wallet cache  │           │ Binance P2P   │
 │ partners      │           │ rates         │           │ IntaSend      │
 │ wallets       │           │               │           │ TransFi       │
 │ onboarding    │           │               │           │               │
 │ paymentLinks  │           │               │           │               │
 │ transaction   │           │               │           │               │
 │ Records       │           │               │           │               │
 └───────────────┘           └───────────────┘           └───────────────┘
```

**How to read this**

- **Consumer app** → `api`, `transactionsApi`, `notificationsApi`, payment callables, webhooks. Data in `users`, `customerWallets`, orders, RTDB wallet paths.
- **B2B integrations** → `partner` with per-partner API key; use `partnerSandbox` for pre-live testing without Firestore partner activation.
- **B2B portal** → `b2bPortal` for humans: platform admins manage partners; org admins manage members, payment links, and onboarding. Live Partner API stays blocked until partner `status` is **`active`**.

### Design patterns

- **Service layer** — business logic in `services/`, not in HTTP handlers
- **Idempotency** — duplicate-safe payment and webhook handling
- **Outbox** — reliable async processing with retries
- **Centralized config** — `config.js` (region, collections, feature flags, sandbox keys)
- **Backward compatibility** — consumer app APIs preserved across refactors

See [`functions/BACKEND_ARCHITECTURE.md`](./functions/BACKEND_ARCHITECTURE.md) for service-level detail.

---

## Key technologies

- **Firebase Cloud Functions v2** — serverless compute
- **Firestore** — primary data store
- **Firebase Realtime Database** — balance / rate cache for mobile clients
- **Firebase Authentication** — user auth and custom claims
- **Node.js 22**
- **Express** — HTTP routing for REST functions
- **IntaSend** — consumer and B2B payment links
- **Binance P2P API** — exchange rate source

---

## Main components

### Exchange rates

- Binance P2P fetch for KES, NGN, GHS vs USDT
- Fee from `config/fees`; cache in `p2pRates` and RTDB
- Scheduled updates via `jobs/rateUpdater.js` and `ratesHttp` exports

### Payment system (consumer)

1. Client creates order via callable or REST
2. User pays on IntaSend / TransFi
3. Webhook verifies signature and resolves user (phone, order, metadata)
4. Firestore balance update (transaction-safe) → RTDB sync → audit log

### B2B payment links

- Org-wide product links (`paymentLinks` collection) with hosted checkout HTML
- IntaSend settlement credits partner wallet via `b2bPaymentLinkCheckoutService` / webhooks
- Payer name collected at checkout; links stay reusable until expiry/cancel

### B2B onboarding checklist

| Step | Backend signal |
|------|----------------|
| Run test transaction | `progress.testTransactionDone` — sandbox payment via portal or `partnerSandbox` + `linkToken` |
| Go live | `progress.goLiveDone` — partner `status: active` (platform admin PATCH) |

---

## Security features

- **Webhook verification** — IntaSend HMAC / challenge; TransFi secret
- **Firebase Auth** — required on callables and portal routes
- **Admin access** — custom claim `admin: true` (or master UID allowlist for super-admin)
- **Partner API** — `X-API-KEY`; rejected when partner `status` is not active
- **Partner portal** — `partnerId` + `partnerRole` claims; org_admin for member mutations
- **Firestore transactions** — atomic balance updates
- **Input validation** — shared validators in `utils/validation.js`

---

## Supported currencies

- **Fiat:** KES, NGN, GHS (+ USD as base)
- **Crypto:** USDT
- **SafariCoin (SFRC):** mock placeholder only (`safariCoinService` / `safariCoinWallets`)

---

## Project structure

```
functions/
├── index.js                    # Exports all Cloud Functions (no business logic)
├── admin.js                    # Firebase Admin SDK init
├── config.js                   # Region, secrets, collections, feature flags
│
├── http/                       # Thin HTTP / callable handlers
│   ├── customerWalletsHttp.js  # api — rates, wallets, admin REST
│   ├── paymentsHttp.js         # Payment callables
│   ├── webhookApi.js           # IntaSend + TransFi webhooks
│   ├── ratesHttp.js            # Scheduled + callable rates
│   ├── arbitrageHttp.js
│   ├── transactionsHttp.js     # transactionsApi
│   ├── notificationsHttp.js
│   ├── adminHttp.js            # Admin callables
│   ├── adminClaimsHttp.js
│   ├── customerAuthHttp.js
│   ├── partnerApi.js           # B2B Partner API (live)
│   ├── partnerSandboxHttp.js   # B2B sandbox API
│   └── b2bPortalHttp.js        # B2B portal + platform admin
│
├── services/                   # Business logic
│   ├── walletService.js
│   ├── transactionService.js
│   ├── partnerService.js
│   ├── paymentLinkService.js
│   ├── b2bOnboardingService.js
│   ├── b2bPortalSandboxService.js
│   ├── b2bMemberService.js
│   ├── b2bPaymentLinkCheckoutService.js
│   ├── paymentRailService.js
│   └── …
│
├── libs/                       # Shared data access, auth, legacy logic
│   ├── firestore.js
│   ├── auth.js
│   ├── rates.js
│   ├── payments.js
│   ├── b2bPayments.js
│   └── …
│
├── triggers/
│   ├── usersTrigger.js
│   ├── userBootstrap.js
│   └── authUserCleanup.js
│
├── jobs/
│   └── rateUpdater.js
│
└── utils/                      # Logging, validation, checkout HTML, claims, …
```

---

## Quick start

1. **Prerequisites** — Node.js 22, Firebase CLI, project with Functions + Firestore + RTDB

2. **Install**
   ```bash
   cd functions
   npm install
   ```

3. **Local emulators**
   ```bash
   npm run serve
   ```
   From repo root: `node test-functions.js` (with emulators running)

4. **Secrets / config**
   - Firebase secrets: `INTASEND_SECRET`, `INTASEND_CHALLENGE`, `INTASEND_SECRET_KEY`, `INTASEND_PUBLISHABLE_KEY`, `TRANSFI_WEBHOOK_SECRET`
   - Optional: `B2B_SANDBOX_PUBLIC_API_KEY`, `FIREBASE_WEB_API_KEY`, `PAYMENT_LINK_BASE_URL`
   - Firestore `config/fees` document

5. **Deploy**
   ```bash
   firebase deploy --only functions
   ```
   Targeted example (B2B portal + sandbox only):
   ```bash
   firebase deploy --only functions:b2bPortal,functions:partnerSandbox
   ```

---

## Documentation index

| Document | Audience | Contents |
|----------|----------|----------|
| [`readme.md`](./readme.md) | Backend / ops | Full function reference, troubleshooting |
| [`api.md`](./api.md) | Consumer frontend | REST + callable integration |
| [`B2B_docs.md`](./B2B_docs.md) | B2B integrators | Partner API + portal API reference |
| [`B2B_SANDBOX.md`](./B2B_SANDBOX.md) | B2B testers | Public sandbox API (`partnerSandbox`) |
| [`B2B_SANDBOX_DASHBOARD_FRONTEND.md`](./B2B_SANDBOX_DASHBOARD_FRONTEND.md) | B2B dashboard UI | Onboarding checklist + sandbox transactions |
| [`B2B_FRONTEND_INSTRUCTIONS.md`](./B2B_FRONTEND_INSTRUCTIONS.md) | B2B dashboard UI | Payment links, portal transactions |
| [`onboarding.md`](./onboarding.md) | B2B ops / partners | Ordered onboarding steps and endpoints |
| [`functions/BACKEND_ARCHITECTURE.md`](./functions/BACKEND_ARCHITECTURE.md) | Backend maintainers | Services, ledger, data model |
| [`AGENTS.md`](./AGENTS.md) | Contributors | Repo conventions and commands |
| [`TRANSACTIONS_API.md`](./TRANSACTIONS_API.md) | Consumer frontend | Transactions REST API |

---

## License

Private — All rights reserved
