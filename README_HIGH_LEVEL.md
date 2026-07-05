# TruePay Backend — High Level Overview

## What is TruePay?

TruePay is a Firebase-based backend for a cryptocurrency exchange and payments platform serving African markets. It powers:

- **Consumer app (C2B)** — users exchange USD for local fiat (KES, NGN, GHS) via USDT using Binance P2P rates, top up wallets through IntaSend, run swap / send-money flows, and hold **USDC** in Circle developer-controlled wallets.
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
- **Circle** — USDC deposits and on-chain sends via developer-controlled wallets
- Callables: `createPayment`, `createDirectTopup`, `createDirectPayout`, `createSwapOrder`, `createSendMoneyOrder`, `requestPasswordReset`
- Webhooks: `handleTopUpWebhook`, `handleTransFiTopUpWebhook`, `handlePaymentWebhook`, `handleCircleWebhook`
- Idempotent processing; HMAC / challenge verification on webhooks

### 3. Circle USDC crypto wallets

- **Developer-controlled wallets** via Circle API — backend never holds private keys
- REST surface: **`cryptoApi`** — `GET /crypto/wallet`, `/crypto/balance`, `/crypto/transactions`; `POST /crypto/send`
- **Ledger-first balance model** — `cryptoLedger` + `walletAggregates` are source of truth; `pendingReservations` hold send liabilities before on-chain confirmation
- RTDB projection at `wallet/{userId}/crypto/USDC` for Flutter display only (via `rtdbSyncService`)
- Scheduled **`reconcileCircleLedger`** job (every 6h) corrects ledger drift against Circle on-chain balances
- See [`CIRCLE.md`](./CIRCLE.md) (backend) and [`circle_c2b.md`](./circle_c2b.md) (Flutter integration)

### 4. Wallet management

- **Fiat (Firestore)** — master balances and transaction history in `users` / `customerWallets`
- **Fiat (Realtime Database)** — fast cache at `wallet/{userId}/fiat/{currency}` (clients should read here)
- **USDC (Firestore ledger)** — append-only `cryptoLedger`, aggregate cache, reservations; separate from fiat
- **Partner wallets** — separate `wallets` collection with `ownerType: 'partner'`
- Balance writes sync to RTDB via shared helpers (not a separate exported trigger)

### 5. Identity & access

- Firebase Authentication as the single IdP for consumer app, partner dashboard, and platform admin
- **Custom claims** (`userType`, `role`, `partnerId`) — see [`FRONTEND_AUTH_HANDOFF.md`](./FRONTEND_AUTH_HANDOFF.md) and [`auth.md`](./auth.md)
  - Customer: `{ userType: "customer" }`
  - Partner: `{ userType: "partner", partnerId, role }`
  - Platform admin: `{ userType: "admin", role: "super_admin" | "operations_admin" | … }`
- Legacy claims (`admin: true`, `partnerRole`) still accepted during migration
- C2B self-registration: `POST /register` on **`api`** (creates Auth user + Firestore profile + customer claims)
- `userBootstrap` callable and `onUserCreated` trigger initialize profiles and wallets
- `onAuthUserDeleted` cleans up Firestore / RTDB user data

### 6. Admin dashboard (consumer)

- Admin callables in `adminHttp.js` (balance adjust, KYC, commission config, IntaSend status, orphan pruning)
- Custom claim helpers: `setAdminClaim`, `removeAdminClaim`
- Sensitive REST routes on `api` require Firebase custom claim **`admin: true`** (or new `userType: "admin"`)

### 7. B2B platform

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
- Org admin manages members and roles via custom claims (`partnerId`, `role` / legacy `partnerRole`)

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
        │                       (partners.apiKey)             (userType / partnerId)
        ▼                              │                                │
 ┌──────────────┐              ┌──────────────┐              ┌──────────────┐
 │ api          │              │ partner      │              │ b2bPortal    │
 │ cryptoApi    │              │ partnerSandbox│             │              │
 │ transactions │              │              │              │ /platform/*  │
 │ notifications│              │ rates        │              │ /portal/*    │
 │ callables    │              │ payments     │              │ onboarding   │
 │ webhooks     │              │ checkout     │              │ payment links│
 └──────┬───────┘              │ wallet, tx   │              │ sandbox tests│
        │                      └──────┬───────┘              └──────┬───────┘
        │                             │                             │
        └─────────────────────────────┼─────────────────────────────┘
                                      ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ services/ · libs/                                                             │
 │ walletService · transactionService · partnerService · paymentLinkService ·    │
 │ b2bOnboardingService · b2bPortalSandboxService · paymentRailService ·         │
 │ circle/* (circleService, circleRailAdapter, circleWebhookService) ·           │
 │ ledger/* (ledgerService, reservationService) · sync/rtdbSyncService · …       │
 └──────────────────────────────────────────────────────────────────────────────┘
                                      │
         ┌────────────────────────────┼────────────────────────────┐
         ▼                            ▼                            ▼
 ┌───────────────┐           ┌───────────────┐           ┌───────────────┐
 │ Firestore     │           │ Realtime DB   │           │ External APIs │
 │ users, orders │           │ fiat wallet   │           │ Binance P2P   │
 │ partners      │           │ crypto USDC   │           │ IntaSend      │
 │ wallets       │           │ rates         │           │ TransFi       │
 │ onboarding    │           │               │           │ Circle        │
 │ paymentLinks  │           │               │           │               │
 │ cryptoLedger  │           │               │           │               │
 │ walletAggreg. │           │               │           │               │
 │ transaction   │           │               │           │               │
 │ Records       │           │               │           │               │
 └───────────────┘           └───────────────┘           └───────────────┘
```

**How to read this**

- **Consumer app (fiat)** → `api`, `transactionsApi`, `notificationsApi`, payment callables, IntaSend/TransFi webhooks. Data in `users`, `customerWallets`, orders, RTDB fiat wallet paths.
- **Consumer app (USDC)** → `cryptoApi`, `handleCircleWebhook`, `reconcileCircleLedger`. Ledger in `cryptoLedger` / `walletAggregates`; RTDB at `wallet/{uid}/crypto/USDC` is display-only.
- **B2B integrations** → `partner` with per-partner API key; use `partnerSandbox` for pre-live testing without Firestore partner activation.
- **B2B portal** → `b2bPortal` for humans: platform admins manage partners; org admins manage members, payment links, and onboarding. Live Partner API stays blocked until partner `status` is **`active`**.

### Design patterns

- **Service layer** — business logic in `services/`, not in HTTP handlers
- **Idempotency** — duplicate-safe payment, webhook, and send handling (`sendIdempotencyKeys`, webhook locks)
- **Ledger-first crypto** — USDC balances computed from append-only ledger, not from transaction logs or RTDB
- **Outbox** — reliable async processing with retries
- **Centralized config** — `config.js` (region, collections, feature flags, sandbox keys, Circle env)
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
- **Circle Developer-Controlled Wallets** — USDC wallet creation, on-chain transfers, webhooks

---

## Main components

### Exchange rates

- Binance P2P fetch for KES, NGN, GHS vs USDT
- Fee from `config/fees`; cache in `p2pRates` and RTDB
- Scheduled updates via `jobs/rateUpdater.js` and `ratesHttp` exports

### Payment system (consumer fiat)

1. Client creates order via callable or REST
2. User pays on IntaSend / TransFi
3. Webhook verifies signature and resolves user (phone, order, metadata)
4. Firestore balance update (transaction-safe) → RTDB sync → audit log

### Circle USDC (consumer crypto)

1. `GET /crypto/wallet` provisions a Circle wallet and returns deposit address + QR
2. On-chain deposit → `handleCircleWebhook` → ledger credit → RTDB projection
3. `POST /crypto/send` reserves funds, calls Circle transfer, completes via webhook
4. `reconcileCircleLedger` scheduled job aligns ledger with on-chain balances

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

- **Webhook verification** — IntaSend HMAC / challenge; TransFi secret; Circle entity secret / signature
- **Firebase Auth** — required on callables, `cryptoApi`, and portal routes
- **Admin access** — `userType: "admin"` or legacy custom claim `admin: true` (master UID allowlist for super-admin)
- **Partner API** — `X-API-KEY`; rejected when partner `status` is not active
- **Partner portal** — `userType: "partner"` + `partnerId` + `role` claims; owner role for member mutations
- **Send rate limiting** — `cryptoApi` POST /crypto/send throttled per user
- **Firestore transactions** — atomic balance and ledger updates
- **Input validation** — shared validators in `utils/validation.js`

---

## Supported currencies

- **Fiat:** KES, NGN, GHS (+ USD as base)
- **Crypto (P2P rates):** USDT
- **Crypto (Circle wallets):** USDC — separate ledger and RTDB path from fiat/USDT
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
│   ├── customerWalletsHttp.js  # api — rates, wallets, register, admin REST
│   ├── cryptoApi.js            # cryptoApi — USDC wallet, balance, send
│   ├── circleWebhookHttp.js    # handleCircleWebhook
│   ├── paymentsHttp.js         # Payment callables
│   ├── webhookApi.js           # IntaSend + TransFi webhooks
│   ├── ratesHttp.js            # Scheduled + callable rates
│   ├── arbitrageHttp.js
│   ├── transactionsHttp.js     # transactionsApi
│   ├── notificationsHttp.js
│   ├── adminHttp.js            # Admin callables
│   ├── adminClaimsHttp.js
│   ├── customerAuthHttp.js     # requestPasswordReset
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
│   ├── customerSelfRegistrationService.js
│   ├── platformConsumerService.js
│   ├── circle/                 # Circle USDC integration
│   │   ├── circleService.js
│   │   ├── circleRailAdapter.js
│   │   ├── circleWalletService.js
│   │   ├── circleWebhookService.js
│   │   └── sendIdempotencyService.js
│   ├── ledger/                 # Append-only crypto ledger
│   │   ├── ledgerService.js
│   │   └── reservationService.js
│   └── sync/
│       └── rtdbSyncService.js  # RTDB projection from ledger
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
│   ├── rateUpdater.js
│   └── reconcileCircleLedger.js
│
├── scripts/                    # One-off ops / backfill scripts
│   ├── register-circle-entity-secret.js
│   ├── backfill-c2b-customer-claims.js
│   ├── backfill-b2b-partner-orgs.js
│   └── bootstrap-super-admin.js
│
└── utils/                      # Logging, validation, access control, claims, …
    ├── accessControl.js        # userType / role claims
    └── …
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
   - Circle: `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET` (+ env: `CIRCLE_WALLET_SET_ID`, `CIRCLE_BLOCKCHAIN`, `CIRCLE_USDC_TOKEN_ID`, `CIRCLE_ENV`)
   - Optional: `B2B_SANDBOX_PUBLIC_API_KEY`, `FIREBASE_WEB_API_KEY`, `PAYMENT_LINK_BASE_URL`, `MASTER_ADMIN_EMAIL`
   - Firestore `config/fees` document

5. **Ops scripts** (from `functions/`)
   ```bash
   npm run circle:register-secret      # Register Circle entity secret
   npm run auth:bootstrap-super-admin  # Bootstrap platform super-admin claims
   npm run c2b:backfill-customer-claims
   npm run b2b:backfill-partners
   ```

6. **Deploy**
   ```bash
   firebase deploy --only functions
   ```
   Targeted examples:
   ```bash
   firebase deploy --only functions:b2bPortal,functions:partnerSandbox
   firebase deploy --only functions:cryptoApi,functions:handleCircleWebhook,functions:reconcileCircleLedger
   ```

---

## Documentation index

| Document | Audience | Contents |
|----------|----------|----------|
| [`readme.md`](./readme.md) | Backend / ops | Full function reference, troubleshooting |
| [`api.md`](./api.md) | Consumer frontend | REST + callable integration |
| [`CIRCLE.md`](./CIRCLE.md) | Backend / ops | Circle USDC architecture, ledger model, webhooks |
| [`circle_c2b.md`](./circle_c2b.md) | Consumer frontend (Flutter) | cryptoApi integration guide |
| [`auth.md`](./auth.md) | All frontend teams | Authentication and authorization model |
| [`FRONTEND_AUTH_HANDOFF.md`](./FRONTEND_AUTH_HANDOFF.md) | All frontend teams | userType claims, routing, token refresh |
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
