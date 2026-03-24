# TruePay Backend Architecture

This document describes the refactored TruePay backend: modular services, B2B Partner API, ledger, and SafariCoin placeholder. **Existing consumer app APIs and behavior are unchanged.**

---

## Folder Structure

```
functions/
├── index.js                    # Entry point; exports all Cloud Functions
├── config.js                   # Region, secrets, collections, feature flags
├── admin.js                    # Firebase Admin SDK
│
├── libs/                       # Shared data access and auth
│   ├── firestore.js            # Firestore client, collection(), serverTimestamp()
│   ├── realtime.js             # Realtime DB client, ref()
│   ├── auth.js                 # verifyFirebaseAuth(), verifyPartnerApiKey(), verifyPartnerRequest()
│   ├── rates.js                # (existing) Binance P2P fetch, Firestore cache
│   ├── payments.js             # (existing) Webhook verify/parse/process, invoiceMappings
│   ├── userWallets.js         # (existing) Customer wallet CRUD, credit/debit
│   └── ...
│
├── services/                   # Business logic layer
│   ├── walletService.js        # User + partner wallets, balance updates, RTDB sync
│   ├── transactionService.js   # Transaction engine (create/update/list records)
│   ├── rateService.js          # Rates (Binance P2P, fee, cache)
│   ├── partnerService.js      # Partner CRUD, API key
│   ├── settlementService.js   # B2B settlements (create/list/update status)
│   ├── ledgerService.js       # Double-entry ledger (debit/credit)
│   └── safariCoinService.js   # **MOCK ONLY** – mint/burn/convert SFRC (TODO: blockchain)
│
├── http/                       # HTTP and callable handlers
│   ├── webhookApi.js           # IntaSend + TransFi webhooks (handleTopUpWebhook, handleTransFiTopUpWebhook)
│   ├── partnerApi.js          # B2B REST under /partner (X-API-KEY)
│   ├── paymentsHttp.js        # Callables: createPayment, createSwapOrder, createSendMoneyOrder, handlePaymentWebhook
│   ├── customerWalletsHttp.js # Consumer REST: api (rates, customer-wallets, credit/debit)
│   ├── transactionsHttp.js   # Consumer REST: transactionsApi
│   ├── notificationsHttp.js  # Consumer REST: notificationsApi
│   ├── ratesHttp.js           # Scheduled + callable + HTTP for Binance rates
│   ├── adminHttp.js           # Admin callables
│   └── ...
│
├── triggers/
│   ├── usersTrigger.js        # Firestore onCreate(users): default wallet fields
│   ├── userBootstrap.js       # Callable: post-auth user bootstrap
│   └── balanceSync.js         # Helpers: syncUserBalance(), syncUserBalancesBatch()
│
├── jobs/
│   └── rateUpdater.js         # runRateUpdater() – fetch rates, optional RTDB cache
│
└── utils/                      # (existing) Balance tx, RTDB sync, transactions, validation, etc.
```

---

## Core Services

### Wallet Service (`services/walletService.js`)

- **User wallets:** Source of truth remains Firestore `users` (unchanged for consumer app).
- **Partner wallets:** Stored in `wallets` with `ownerType: 'partner'`, `ownerId`, `balances: { USD, KES, USDT }`.
- Exposes: `getUserWalletBalances`, `getOrCreatePartnerWallet`, `getPartnerWallet`, `updatePartnerWalletBalance`, `syncUserBalanceToRealtime`, `cacheRatesInRealtime`.

### Transaction Engine (`services/transactionService.js`)

- **Types:** `topup`, `withdrawal`, `crypto_onramp`, `crypto_offramp`, `b2b_payment`, `settlement`.
- **Statuses:** `created`, `pending`, `processing`, `completed`, `failed`.
- Writes to `transactionRecords`; optionally logs to legacy `transactions/{userId}/transactions` and/or creates ledger entries.
- Exposes: `createTransactionRecord`, `updateTransactionStatus`, `getTransactionRecord`, `listTransactionRecords`.

### Ledger Service (`services/ledgerService.js`)

- Double-entry: every movement creates debit + credit entries in `ledger_entries`.
- Account identifiers: `user_wallet:{id}`, `partner_wallet:{id}`, `platform_revenue`, `liquidity_pool`, `settlement_account`.
- Exposes: `createLedgerEntry`, `createDoubleEntry`, `listLedgerEntries`.

### Partner Service (`services/partnerService.js`)

- Partners in `partners` with `name`, `apiKey`, `settlementAccount`, `settlementCurrency`, `webhookUrl`, `status`.
- Exposes: `createPartner`, `getPartner`, `getPartnerByApiKey`, `updatePartner`, `listPartners`, `generateApiKey`.

### Settlement Service (`services/settlementService.js`)

- Settlements in `settlements`: `partnerId`, `amount`, `currency`, `bankAccount`, `status` (pending, scheduled, processing, completed, failed).
- Flow: payment → partner wallet credited → settlement created → (later) bank payout.
- Exposes: `createSettlement`, `getSettlement`, `listSettlements`, `updateSettlementStatus`.

### Rate Service (`services/rateService.js`)

- Delegates to existing `libs/rates.js`. Adds optional `cacheRatesToRealtime()` for frontend.
- Exposes: `getRates`, `fetchAndStoreRates`, `getServiceFee`, `cacheRatesToRealtime`.

### SafariCoin Service (`services/safariCoinService.js`) — **MOCK ONLY**

- **TODO: Replace with blockchain integration.** No real chain; balances in `safariCoinWallets`.
- Mock rate: 1 SFRC = 1 USD.
- Exposes: `mintSafariCoin`, `burnSafariCoin`, `convertToSafariCoin`, `convertFromSafariCoin`, `getSafariCoinBalance`, `getOrCreateSafariCoinWallet`.

---

## Partner API (B2B)

- **Base path:** Firebase function name `partner` → `https://<region>-<project>.cloudfunctions.net/partner`
- **Auth:** `X-API-KEY` header (partner’s `apiKey` from `partners`).

| Method | Path | Description |
|--------|------|-------------|
| GET | /partner/rates | Current rates (query: `fiat`, `asset`) |
| POST | /partner/payments | Record B2B payment (body: `amount`, `currency`, `reference?`) |
| GET | /partner/transactions | List partner transactions |
| POST | /partner/checkout | Checkout session (amount, currency, rate) |
| GET | /partner/settlements | List partner settlements |
| GET | /partner/wallet | Partner wallet balances |
| GET | /partner/safaricoin/balance | SafariCoin balance (mock) |

---

## Webhooks

- **IntaSend:** `handleTopUpWebhook` (exported from `http/webhookApi.js`). Verify signature/challenge → resolve user → credit wallet via `libs/payments.js`.
- **TransFi:** `handleTransFiTopUpWebhook` (exported from `http/webhookApi.js`). Same flow via `libs/payments.js`.

Existing webhook URLs and behavior are unchanged; only the implementing module was moved to `webhookApi.js`.

---

## Backwards Compatibility

- **User wallet structure:** Still in Firestore `users` (e.g. `usdBalance`, `kesBalance`, `usdtBalance`, `wallets`). No schema change.
- **Mobile app APIs:** `api`, `transactionsApi`, `notificationsApi`, callables (`createPayment`, `createSwapOrder`, `createSendMoneyOrder`, `getBinanceRates`, `userBootstrap`, etc.) unchanged.
- **Exchange rate endpoints:** Same behavior; `getBinanceRates`, `fetchBinanceRates`, customer rates via `api` unchanged.
- **IntaSend payment flow:** Same verification and processing; handlers now live in `webhookApi.js` but same export names and URLs.

---

## New Firestore Collections

- `partners` – B2B partner config and API keys  
- `wallets` – Partner wallets (ownerType: partner)  
- `transactionRecords` – Unified transaction log  
- `ledger_entries` – Double-entry ledger  
- `settlements` – B2B settlement records  
- `safariCoinWallets` – Mock SafariCoin balances  

---

## Jobs and Triggers

- **Rate updater:** `jobs/rateUpdater.js` – `runRateUpdater()`. Can be used by the existing scheduled function or on demand; optionally caches to Realtime DB.
- **Balance sync:** `triggers/balanceSync.js` – `syncUserBalance(userId)`, `syncUserBalancesBatch(userIds)`. Used for one-off or batch sync of Firestore → Realtime DB.
