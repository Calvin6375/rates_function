# TruePay Backend

Firebase Cloud Functions backend for **TruePay** — a cryptocurrency exchange and payments platform for African markets.

**Firebase project:** `truepay-72060` · **Region:** `us-central1` · **Runtime:** Node.js 22

## What this repo does

| Surface | Users | Examples |
|---------|-------|----------|
| **Consumer (C2B)** | Tourist / retail Flutter app | Wallet top-up (Paystack), pay merchants (USD → KES via Daraja), **Safari Card** M-Pesa payouts (Till / PayBill / Pochi / Send Money), swap, USDC (Circle) |
| **B2B** | Partners & portals | Partner API (`X-API-KEY`), hosted payment links, team portal, sandbox |
| **Platform** | Ops & admin | User/partner management, funding reconciliation, settlement retries |

Wallet balances for the Flutter app are projected to **Realtime Database** (`wallet/{uid}/fiat/…`, `wallet/{uid}/crypto/USDC`). Firestore holds ledgers, orders, and audit trails.

C2B **Cloud Function** HTTP APIs optionally support **AES-256-GCM payload encryption** (opt-in via `X-TruePay-Encrypted: 1`). RTDB reads and B2B/webhook traffic are unchanged. See [`docs/C2B_PAYLOAD_ENCRYPTION.md`](./docs/C2B_PAYLOAD_ENCRYPTION.md).

## Repository layout

```
rates_function/
├── docs/                  # All documentation (see docs/INDEX.md)
├── functions/
│   ├── http/              # REST, callables, webhooks (thin handlers)
│   ├── services/          # Business logic
│   ├── libs/              # Shared data access & legacy helpers
│   ├── triggers/          # Auth / Firestore triggers
│   ├── jobs/              # Scheduled reconciliation & retries
│   └── utils/             # Logging, validation, types
├── firebase.json
├── firestore.rules
├── firestore.indexes.json
├── AGENTS.md              # Contributor conventions
└── test-functions.js      # Local HTTP smoke tests (emulators)
```

Business logic belongs in `functions/services/`, not in HTTP handlers. See [`AGENTS.md`](./AGENTS.md).

## Main APIs

Base URL: `https://us-central1-truepay-72060.cloudfunctions.net/<name>`

| Export | Auth | Purpose |
|--------|------|---------|
| [`api`](./docs/api.md) | Firebase Bearer | Customer REST — wallets, funding, merchant payments, register |
| [`transactionsApi`](./docs/TRANSACTIONS_API.md) | Firebase Bearer | Transaction history feed (labels, Safari Card enrichment) |
| [`notificationsApi`](./docs/api.md) | Firebase Bearer | In-app notifications |
| [`cryptoApi`](./docs/circle_c2b.md) | Firebase Bearer | Circle USDC wallet & send |
| [`safariCardApi`](./docs/pay.md) | Firebase Bearer | Safari Card validate / pay / payout (IntaSend disbursement) |
| [`partner`](./docs/B2B_docs.md) | `X-API-KEY` | B2B Partner API |
| [`b2bPortal`](./docs/B2B_docs.md) | Firebase Bearer | Partner dashboard & platform admin |
| [`partnerSandbox`](./docs/B2B_SANDBOX.md) | Static sandbox key | In-memory B2B mocks |

**Safari Card (C2B pay tab)** — all flows use one endpoint:

```
POST /safari-card/payouts
GET  /safari-card/payouts/by-client-request/{clientRequestId}
```

PayBill, Buy Goods (Till), Pochi, and Send Money differ only in request body (`accountType`, `recipient`). Flutter generates **`clientRequestId`** (UUID) per Pay tap for idempotency and polling.

**Callables:** `createPayment`, `createDirectTopup`, `createSwapOrder`, `createSendMoneyOrder`, `userBootstrap`, …

**Webhooks:** `handlePaystackWebhook`, `handleTopUpWebhook`, `handleDarajaCallback`, `handleCircleWebhook`, `handleIntaSendDisbursementWebhook`, …

Full export list and troubleshooting: [`docs/readme.md`](./docs/readme.md).

## Documentation

All guides live in **[`docs/`](./docs/)**. Start with [`docs/INDEX.md`](./docs/INDEX.md).

| Doc | When to read |
|-----|----------------|
| [`docs/README_HIGH_LEVEL.md`](./docs/README_HIGH_LEVEL.md) | Architecture & data model overview |
| [`docs/BACKEND_ARCHITECTURE.md`](./docs/BACKEND_ARCHITECTURE.md) | Service layer conventions |
| [`docs/api.md`](./docs/api.md) | Consumer Flutter / REST integration |
| [`docs/rates.md`](./docs/rates.md) | P2P / customer rates & cross-pair quotes |
| [`docs/pay.md`](./docs/pay.md) | Safari Card Flutter integration |
| [`docs/SAFARI_CARD_PAYOUTS.md`](./docs/SAFARI_CARD_PAYOUTS.md) | Safari Card backend (IntaSend, webhooks, Firestore) |
| [`docs/TRANSACTIONS_API.md`](./docs/TRANSACTIONS_API.md) | Transaction feed API |
| [`docs/C2B_PAYLOAD_ENCRYPTION.md`](./docs/C2B_PAYLOAD_ENCRYPTION.md) | Optional C2B request/response encryption |
| [`docs/B2B_docs.md`](./docs/B2B_docs.md) | B2B Partner & portal API reference |
| [`docs/PAYSTACK_TOURIST.md`](./docs/PAYSTACK_TOURIST.md) | C2B Paystack top-up flow |
| [`docs/PAYMENT_LIFECYCLE.md`](./docs/PAYMENT_LIFECYCLE.md) | Funding + merchant settlement lifecycle |

> **Note:** On macOS, `README.md` and `readme.md` refer to this file at the repo root. The detailed backend reference is [`docs/readme.md`](./docs/readme.md) (lowercase, under `docs/`).

## Quick start

```bash
cd functions
npm install
npm run serve          # Firebase emulators
```

From the repo root (with emulators running):

```bash
node test-functions.js
```

Deploy:

```bash
cd functions
npm run deploy                              # all functions

# Common partial deploys
firebase deploy --only functions:api,functions:transactionsApi,functions:safariCardApi,functions:cryptoApi
firebase deploy --only functions:handleIntaSendDisbursementWebhook
firebase deploy --only firestore:indexes
```

Stream logs:

```bash
cd functions && npm run logs
```

Unit tests:

```bash
cd functions && npm test
cd functions && npm test -- --testPathPattern=safariCard
```

## Environment & secrets

Configured via Firebase params / secrets and `functions/config.js`. Common keys:

| Area | Secrets / config |
|------|------------------|
| Paystack / Transak | `PAYSTACK_*`, `TRANSAK_*` |
| Circle USDC | `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET` |
| Daraja settlement | `DARAJA_*` |
| IntaSend collection + Safari Card disbursement | `INTASEND_*` |
| C2B payload encryption (optional) | `C2B_PAYLOAD_ENCRYPTION_KEY` |
| Email / auth helpers | `SMTP_*`, `WEB_API_KEY` |

Set a secret:

```bash
firebase functions:secrets:set C2B_PAYLOAD_ENCRYPTION_KEY
```

Ops runbooks: [`docs/FUNDING_OPS.md`](./docs/FUNDING_OPS.md) · [`docs/readme.md`](./docs/readme.md)

## Contributing

Follow [`AGENTS.md`](./AGENTS.md) — service pattern, ESLint (`eslint-config-google`), descriptive commits (`feat:`, `fix:`, `docs:`, …). Preserve backwards compatibility for consumer app APIs documented in [`docs/README_HIGH_LEVEL.md`](./docs/README_HIGH_LEVEL.md).
