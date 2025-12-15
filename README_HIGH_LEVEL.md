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
- Processes webhook callbacks to automatically credit user wallets upon payment completion
- Supports multiple payment resolution strategies (phone number lookup, order matching, etc.)
- Secure webhook signature verification using HMAC SHA-256

### 3. **Wallet Management**
- Dual-database architecture:
  - **Firestore**: Master source of truth for user balances and transactions
  - **Realtime Database**: Fast, real-time cache for client applications
- Automatic balance synchronization between databases
- Transaction logging and audit trails
- Support for multiple currencies (USD, KES, NGN, GHS)

### 4. **User Management**
- Firebase Authentication integration
- User profile management (name, email, phone, country)
- KYC (Know Your Customer) status tracking
- User bootstrap process for new account initialization

### 5. **Admin Dashboard**
- Admin-only functions for user management
- Balance adjustments (credit/debit operations)
- KYC verification and status updates
- Commission/fee configuration management
- Payment status tracking via IntaSend API

## Architecture

```
┌─────────────────────────────────────────┐
│     Firebase Cloud Functions            │
│  (Serverless Backend - Node.js 22)      │
├─────────────────────────────────────────┤
│                                         │
│  • Scheduled Functions                 │
│    - Daily rate updates                │
│    - Arbitrage calculations            │
│                                         │
│  • Callable Functions                 │
│    - Get exchange rates                │
│    - User operations                   │
│    - Admin functions                   │
│                                         │
│  • HTTP Endpoints                      │
│    - REST API                          │
│    - Payment webhooks                  │
│                                         │
│  • Database Triggers                   │
│    - Balance synchronization           │
│    - User lifecycle events             │
│                                         │
└──────────────┬──────────────────────────┘
               │
    ┌──────────┼──────────┐
    │          │          │
    ▼          ▼          ▼
┌─────────┐ ┌─────────┐ ┌─────────┐
│Firestore│ │Realtime │ │ Binance │
│         │ │Database │ │  P2P    │
│Master DB│ │  Cache  │ │   API   │
└─────────┘ └─────────┘ └─────────┘
```

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
- Applies configurable service fees (default: 1.5%)
- Caches rates in Firestore and Realtime Database
- Validates rate freshness (5-10 minute validity windows)

### Arbitrage Engine
- Calculates USD → USDT → Local Fiat conversion paths
- Computes profit margins and customer payouts
- Applies arbitrage fees (default: 1.5%)
- Provides conversion rate transparency

### Payment System
- Receives IntaSend webhook callbacks
- Resolves user accounts via multiple strategies:
  1. Phone number lookup (primary)
  2. Order/invoice matching
  3. Metadata user ID
- Credits user wallets automatically
- Prevents duplicate processing (idempotency)

### Balance Management
- Firestore transactions ensure atomic balance updates
- Automatic sync to Realtime Database for real-time client updates
- Transaction history logging
- Admin audit logs for all balance changes

## Data Flow

### Payment Flow
1. User initiates payment via IntaSend checkout
2. `createPayment` function creates order record
3. User completes payment on IntaSend
4. IntaSend sends webhook to `handleTopUpWebhook`
5. Webhook verifies signature and resolves user account
6. User balance updated in Firestore (transaction-safe)
7. Balance automatically synced to Realtime Database
8. Transaction logged for audit trail

### Rate Update Flow
1. Scheduled function runs daily (midnight UTC)
2. Fetches latest rates from Binance P2P API
3. Applies service fees from configuration
4. Writes to Firestore (`/p2pRates/binance`)
5. Writes to Realtime Database (`/wallet/rates/binance`)
6. Rates cached for 5-10 minutes validity

## Security Features

- **Webhook Signature Verification** - HMAC SHA-256 signature validation
- **Firebase Authentication** - All callable functions require auth
- **Admin Role Verification** - Admin functions check user role
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
✅ Dual-database architecture for performance  
✅ Transaction-safe balance management  
✅ Admin dashboard for user management  
✅ KYC status tracking  
✅ Configurable commission/fee system  
✅ Comprehensive audit logging  
✅ Multi-currency support  
✅ Phone number-based payment resolution  

## Project Structure

```
functions/
├── index.js              # Main entry point
├── http/                 # HTTP endpoint handlers
│   ├── ratesHttp.js      # Exchange rate endpoints
│   ├── arbitrageHttp.js  # Arbitrage endpoints
│   ├── paymentsHttp.js   # Payment webhook handler
│   ├── adminHttp.js      # Admin function endpoints
│   └── ...
├── libs/                 # Business logic modules
│   ├── rates.js          # Rate fetching logic
│   ├── arbitrage.js      # Arbitrage calculations
│   ├── payments.js       # Payment processing
│   └── ...
├── triggers/             # Database triggers
│   ├── balanceSync.js    # Balance sync trigger
│   ├── userBootstrap.js  # User initialization
│   └── ...
└── utils/                # Utility functions
    ├── firestore.js      # Firestore helpers
    ├── realtime.js       # Realtime DB helpers
    └── ...
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
   - Set Firebase secrets for IntaSend integration
   - Configure Firestore `config/fees` document
   - Set up Cloud Scheduler for scheduled functions

4. **Deployment**
   ```bash
   firebase deploy --only functions
   ```

## Documentation

- **Detailed README**: See `readme.md` for comprehensive documentation
- **API Reference**: See `api.md` for frontend integration guide
- **Function Reference**: See `readme.md` for all function details

## License

Private - All rights reserved

