# TruePay Backend - High Level Overview

## What is TruePay?

TruePay is a cryptocurrency exchange platform backend that enables users to exchange USD for African fiat currencies (KES, NGN, GHS) through USDT using Binance P2P marketplace rates. The platform provides real-time exchange rates, wallet management, and payment processing for African markets.

## Core Functionality

### 1. **Exchange Rate Services**
- Fetches real-time USDT exchange rates from Binance P2P marketplace for African currencies (KES, NGN, GHS)
- Calculates customer prices with configurable service fees
- Provides arbitrage rate calculations for USD → USDT → Local Fiat conversion paths
- Rates are cached and updated daily via scheduled functions

### 2. **Payment Processing**
- Integrates with IntaSend payment gateway for mobile money payments (M-PESA, etc.)
- `createPayment` callable function creates order records after IntaSend checkout
- `handleTopUpWebhook` processes webhook callbacks to automatically credit user wallets upon payment completion
- Supports multiple payment resolution strategies (phone number lookup, order matching, metadata user_id)
- Secure webhook signature verification (HMAC SHA-256 or challenge token)
- Idempotency prevents duplicate payment processing

### 3. **Wallet Management**
- Dual-database architecture:
  - **Firestore**: Master source of truth for user balances and transactions
  - **Realtime Database**: Fast, real-time cache at `wallet/{userId}/fiat/{currency}`
- Automatic balance synchronization via `syncBalance` Firestore trigger
- Transaction logging and audit trails
- Support for multiple currencies (USD, KES, NGN, GHS)

### 4. **User Management**
- Firebase Authentication integration
- User profile management (name, email, phone, country)
- KYC (Know Your Customer) status tracking
- `userBootstrap` callable function initializes new user documents and wallets (called by client after signup)

### 5. **Admin Dashboard**
- Admin-only functions for user management
- Balance adjustments (credit/debit via `updateUserBalance`)
- KYC verification and status updates
- Commission/fee configuration management
- Payment status tracking via `getIntaSendPaymentStatus` (IntaSend API)
- User migration (`migrateExistingUsers`) and phone number format updates (`updatePhoneNumbers`)

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│              Firebase Cloud Functions                    │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │  Scheduled   │  │  Callable    │  │     HTTP     │    │
│  │   Functions  │  │  Functions   │  │  Endpoints   │    │
│  │              │  │              │  │              │    │
│  │ • fetchBin   │  │ • getBinance │  │ • fetchBin   │    │
│  │   anceRates  │  │   Rates      │  │   anceRates  │    │
│  │ • fetchArbi  │  │ • getArbitr  │  │   Http       │    │
│  │   trageRates │  │   ageRates   │  │ • handleTop  │    │
│  │              │  │ • createPay  │  │   UpWebhook  │    │
│  │              │  │   ment       │  │ • api/*      │    │
│  │              │  │ • userBoot   │  │   (REST)     │    │
│  │              │  │   strap      │  │              │    │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘    │
│         │                 │                 │            │
│  ┌──────┴─────────────────┴─────────────────┴───────┐    │
│  │           Firestore Triggers                     │    │
│  │  • syncBalance (onDocumentUpdated: users/{uid})  │    │
│  │  • onUserCreated (onDocumentCreated: users/{uid})│    │
│  └──────────────────────┬───────────────────────────┘    │
│                         │                                │
│  ┌──────────────────────┴───────────────────────────┐    │
│  │              Auth Triggers                       │    │
│  │  • userBootstrap (auth.user().onCreate)          │    │
│  └──────────────────────┬───────────────────────────┘    │
└─────────────────────────┼────────────────────────────────┘
                          │
         ┌────────────────┼────────────────┐
         │                │                │
         ▼                ▼                ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  Firestore   │  │  Realtime DB │  │   Binance    │
│              │  │              │  │   P2P API    │
│ • users      │  │ • wallet/    │  │              │
│ • p2pRates   │  │   {uid}/fiat │  │              │
│ • config     │  │ • wallet/    │  │              │
│ • transact   │  │   rates      │  │              │
│   ions       │  │ • payments   │  │              │
│ • adminLogs  │  │ • pending    │  │              │
│ • orders     │  │   Topups     │  │              │
└──────────────┘  └──────────────┘  └──────────────┘
```

### Architecture Improvements (December 2025 Refactor)

- **Separation of Concerns**: Business logic in `libs/` (testable), thin HTTP handlers in `http/`, triggers in `triggers/`
- **Idempotency Pattern**: Prevents duplicate operations (especially payment processing)
- **Outbox Pattern**: Reliable async processing with retry mechanism
- **Structured Logging & Monitoring**: JSON-formatted logs, performance metrics, health checks
- **Centralized Configuration**: `config.js` for feature flags, collection paths, API settings
- **Backward Compatible**: All public APIs remain unchanged

## Key Technologies

- **Firebase Cloud Functions v2** - Serverless compute platform
- **Firestore** - NoSQL database (master data store)
- **Firebase Realtime Database** - Real-time data cache
- **Firebase Authentication** - User authentication
- **Node.js 22** - Runtime environment
- **IntaSend API** - Payment gateway integration
- **Binance P2P API** - Exchange rate data source

## Main Components

### Exchange Rates
- Fetches USDT rates for KES, NGN, GHS from Binance P2P
- Applies configurable service fees (default: 1.5%) from `config/fees`
- Caches rates in Firestore (`/p2pRates/binance`) and Realtime Database (`/wallet/rates/binance`)
- Validates rate freshness (5-10 minute validity windows)

### Arbitrage Engine
- Calculates USD → USDT → Local Fiat conversion paths
- Computes profit margins and customer payouts
- Applies arbitrage fees (default: 1.5%)
- Provides conversion rate transparency

### Payment System
- `createPayment` creates order records and mappings (`/orders`, `/wallet/pendingTopups`, `/wallet/phoneToInvoice`)
- Receives IntaSend webhook callbacks at `handleTopUpWebhook`
- Resolves user accounts via: phone number lookup (primary) → order lookup → RTDB mapping → metadata user_id
- Credits user wallets automatically with transaction safety
- Prevents duplicate processing (idempotency)

### Balance Management
- Firestore transactions ensure atomic balance updates
- `syncBalance` trigger syncs to Realtime Database at `wallet/{userId}/fiat/{currency}`
- **Client apps should read from**: `wallet/{userId}/fiat/USD` (old `wallet/{userId}/balance` path deprecated)
- Transaction history and admin audit logs

## Data Flow

### Payment Flow
1. User initiates payment via IntaSend checkout
2. Client calls `createPayment` to create order record and mappings
3. User completes payment on IntaSend
4. IntaSend sends webhook to `handleTopUpWebhook`
5. Webhook verifies signature/challenge and resolves user account
6. User balance updated in Firestore (transaction-safe)
7. `syncBalance` trigger syncs to Realtime Database
8. Transaction logged for audit trail

### Rate Update Flow
1. Scheduled functions run daily (midnight UTC)
2. Fetches latest rates from Binance P2P API
3. Applies service fees from `config/fees`
4. Writes to Firestore (`/p2pRates/binance`) and Realtime Database (`/wallet/rates/binance`)
5. Rates cached for 5-10 minutes validity

## Security Features

- **Webhook Signature Verification** - HMAC SHA-256 or challenge token (INTASEND_SECRET or INTASEND_CHALLENGE)
- **Firebase Authentication** - All callable functions require auth
- **Admin Role Verification** - Admin functions check `role: 'admin'` in user document
- **Transaction Safety** - Firestore transactions prevent race conditions
- **Input Validation** - All inputs validated before processing
- **Idempotency** - Prevents duplicate payment processing

## Supported Currencies

- **Fiat**: KES (Kenyan Shilling), NGN (Nigerian Naira), GHS (Ghanaian Cedi)
- **Crypto**: USDT (Tether)
- **Base**: USD (US Dollar)

## Key Features

✅ Real-time exchange rate fetching and caching  
✅ Automatic payment processing via webhooks  
✅ `createPayment` order creation for reliable user resolution  
✅ Dual-database architecture for performance  
✅ Transaction-safe balance management  
✅ Admin dashboard for user management  
✅ KYC status tracking  
✅ Configurable commission/fee system  
✅ Comprehensive audit logging  
✅ Multi-currency support  
✅ Phone number-based payment resolution  
✅ Idempotency and outbox patterns for reliability  
✅ Structured logging and monitoring  

## Project Structure

```
functions/
├── index.js                   # Main entry point - exports only
├── admin.js                   # Firebase Admin SDK initialization
├── config.js                  # Centralized configuration & feature flags
│
├── http/                      # HTTP handlers (thin controllers)
│   ├── ratesHttp.js           # Exchange rate endpoints
│   ├── arbitrageHttp.js       # Arbitrage endpoints
│   ├── paymentsHttp.js        # Payment webhook & createPayment handlers
│   ├── customerWalletsHttp.js # Customer wallets REST API
│   ├── adminHttp.js           # Admin callable functions
│   ├── migrateUsersHttp.js    # User migration HTTP handlers
│   └── updatePhoneNumbersHttp.js # Phone update HTTP handlers
│
├── triggers/                  # Background triggers
│   ├── usersTrigger.js        # Firestore user creation trigger
│   ├── userBootstrap.js       # Auth user creation bootstrap
│   └── balanceSync.js         # Balance sync trigger
│
├── workers/                   # Ready for async/long-running tasks
│
├── libs/                      # Pure business logic (testable)
│   ├── rates.js               # Rate fetching logic
│   ├── arbitrage.js           # Arbitrage calculations
│   ├── payments.js            # Payment processing logic
│   ├── adminActions.js        # Admin operations logic
│   ├── userWallets.js         # User wallet operations logic
│   ├── migrateUsers.js        # User migration logic
│   ├── updatePhoneNumbers.js  # Phone update logic
│   ├── idempotency.js         # Idempotency pattern implementation
│   └── outbox.js              # Outbox pattern for reliable async processing
│
└── utils/                     # Utility functions
    ├── firestore.js           # Firestore helpers
    ├── realtime.js            # Realtime DB helpers
    ├── transactions.js        # Transaction logging utilities
    ├── validation.js          # Input validation utilities
    ├── logging.js             # Structured logging utilities
    └── monitoring.js          # Performance monitoring utilities
```

## Quick Start

1. **Prerequisites**
   - Node.js 22
   - Firebase CLI
   - Firebase project with Functions, Firestore, and Realtime Database enabled

2. **Installation**
   ```bash
   cd functions
   npm install
   ```

3. **Configuration**
   - Set Firebase secrets: `INTASEND_SECRET`, `INTASEND_CHALLENGE`, `INTASEND_SECRET_KEY`, `INTASEND_PUBLISHABLE_KEY`
   - Configure Firestore `config/fees` document
   - Set up Cloud Scheduler for scheduled functions

4. **Deployment**
   ```bash
   firebase deploy --only functions
   ```

## Documentation

- **Detailed README**: See `readme.md` for comprehensive documentation, function reference, API details, and troubleshooting
- **API Reference**: See `api.md` for frontend integration guide
- **Refactoring**: See `functions/REFACTORING_SUMMARY.md` for migration information

## License

Private - All rights reserved
