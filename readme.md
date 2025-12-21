# TruePay Backend - Firebase Cloud Functions

A comprehensive Firebase Cloud Functions backend application that provides real-time cryptocurrency exchange rate services, payment processing, user management, and wallet operations for the TruePay platform.

## Table of Contents

- [Overview](#overview)
- [System Architecture](#system-architecture)
- [Cloud Functions Reference](#cloud-functions-reference)
  - [Scheduled Functions](#scheduled-functions)
  - [Callable Functions](#callable-functions)
  - [HTTP Endpoints](#http-endpoints)
  - [Firestore Triggers](#firestore-triggers)
  - [Auth Triggers](#auth-triggers)
- [Admin Functions](#admin-functions)
- [Database Structure](#database-structure)
- [Payment Processing](#payment-processing)
- [Balance Management](#balance-management)
- [API Reference](#api-reference)
- [Configuration](#configuration)
- [Security](#security)
- [Development](#development)
- [Deployment](#deployment)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)

---

## Overview

This backend system powers the TruePay cryptocurrency exchange platform, providing:

1. **Real-time P2P Exchange Rates**: Fetches USDT exchange rates for multiple African currencies (KES, NGN, GHS) from Binance P2P marketplace
2. **Arbitrage Calculations**: Calculates profitable conversion paths for USD → USDT → Local Fiat currency
3. **Payment Processing**: Handles webhook callbacks from IntaSend payment gateway to update user wallet balances
4. **User Management**: Complete user lifecycle management with Firebase Authentication integration
5. **Wallet Operations**: Secure balance management with transaction logging and real-time sync
6. **Admin Dashboard**: Admin-only functions for user management, balance adjustments, and KYC verification

**Technology Stack:**
- **Firebase Functions v2** - Serverless compute platform
- **Firestore** - Master database for persistent storage and transactions
- **Realtime Database** - Cached mirror for real-time client updates
- **Node.js 22** - Runtime environment

**Architecture:**
- **Refactored (December 2025)**: Codebase restructured for improved maintainability, testability, and scalability
- **Patterns**: Idempotency, Outbox pattern, structured logging, and monitoring
- **Backward Compatible**: All public APIs remain unchanged - no breaking changes

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│              Firebase Cloud Functions                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │  Scheduled   │  │  Callable    │  │     HTTP     │     │
│  │   Functions  │  │  Functions   │  │  Endpoints   │     │
│  │              │  │              │  │              │     │
│  │ • fetchBin   │  │ • getBinance │  │ • fetchBin   │     │
│  │   anceRates  │  │   Rates      │  │   anceRates  │     │
│  │ • fetchArbi  │  │ • getArbitr  │  │   Http       │     │
│  │   trageRates │  │   ageRates   │  │ • handleTop  │     │
│  │              │  │ • updateUser │  │   UpWebhook  │     │
│  │              │  │   Balance    │  │ • api/*      │     │
│  │              │  │ • getUserData│  │   (REST)     │     │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘     │
│         │                 │                  │             │
│  ┌──────┴─────────────────┴──────────────────┴───────┐    │
│  │           Firestore Triggers                      │    │
│  │  • syncBalance (onDocumentUpdated: users/{uid})  │    │
│  │  • onUserCreated (onDocumentCreated: users/{uid})│    │
│  └──────────────────────┬───────────────────────────┘    │
│                         │                                 │
│  ┌──────────────────────┴───────────────────────────┐    │
│  │              Auth Triggers                       │    │
│  │  • userBootstrap (auth.user().onCreate)         │    │
│  └──────────────────────┬───────────────────────────┘    │
└─────────────────────────┼─────────────────────────────────┘
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
│ • adminLogs  │  │              │  │              │
└──────────────┘  └──────────────┘  └──────────────┘
```

### File Structure

The codebase has been refactored into a clean, scalable architecture with clear separation of concerns:

```
functions/
├── index.js                   # Main entry point - exports only, no logic
├── admin.js                   # Firebase Admin SDK initialization
├── config.js                  # NEW: Centralized configuration & feature flags
│
├── http/                      # NEW: HTTP handlers (thin controllers)
│   ├── ratesHttp.js           # Rates HTTP endpoints
│   ├── arbitrageHttp.js       # Arbitrage HTTP endpoints
│   ├── paymentsHttp.js       # Payment webhook & callable handlers
│   ├── customerWalletsHttp.js # Customer wallets REST API
│   ├── adminHttp.js           # Admin callable functions
│   ├── migrateUsersHttp.js   # User migration HTTP handlers
│   └── updatePhoneNumbersHttp.js # Phone update HTTP handlers
│
├── triggers/                  # NEW: Background triggers
│   ├── usersTrigger.js        # Firestore user creation trigger
│   ├── userBootstrap.js       # Auth user creation bootstrap
│   └── balanceSync.js         # Balance sync trigger
│
├── workers/                   # NEW: Ready for async/long-running tasks
│   # (Future: P2P execution, arbitrage, reconciliation workers)
│
├── libs/                      # NEW: Pure business logic (testable, reusable)
│   ├── rates.js               # Rates business logic
│   ├── arbitrage.js           # Arbitrage calculation logic
│   ├── payments.js            # Payment processing logic
│   ├── adminActions.js        # Admin operations logic
│   ├── userWallets.js         # User wallet operations logic
│   ├── migrateUsers.js        # User migration logic
│   ├── updatePhoneNumbers.js  # Phone update logic
│   ├── idempotency.js         # NEW: Idempotency pattern implementation
│   └── outbox.js              # NEW: Outbox pattern for reliable async processing
│
└── utils/                     # Utility modules
    ├── firestore.js           # Firestore helper functions
    ├── realtime.js            # Realtime DB helper functions
    ├── transactions.js        # Transaction logging utilities
    ├── validation.js          # Input validation utilities
    ├── logging.js             # NEW: Structured logging utilities
    └── monitoring.js          # NEW: Performance monitoring utilities
```

### Architecture Improvements

**✅ Separation of Concerns:**
- **Business Logic** (`libs/`): Pure, testable functions with no direct Firebase dependencies
- **HTTP Handlers** (`http/`): Thin controllers that delegate to business logic
- **Triggers** (`triggers/`): Background functions separated from business logic
- **Utilities** (`utils/`): Reusable helper functions

**✅ New Patterns:**
- **Idempotency** (`libs/idempotency.js`): Prevents duplicate operations using Firestore-based keys
- **Outbox Pattern** (`libs/outbox.js`): Reliable async processing with retry mechanism
- **Structured Logging** (`utils/logging.js`): Consistent JSON-formatted logs
- **Monitoring** (`utils/monitoring.js`): Performance metrics and health checks

**✅ Benefits:**
- **Testability**: Business logic can be unit tested without Firebase
- **Maintainability**: Clear folder structure and single responsibility
- **Scalability**: Ready for async workers and Pub/Sub integration
- **Backward Compatible**: All APIs remain unchanged

### Architecture Patterns

#### Idempotency Pattern (`libs/idempotency.js`)

Prevents duplicate operations by generating deterministic keys from request data:

```javascript
const {executeWithIdempotency} = require('./libs/idempotency');

// Automatically handles duplicate detection
const result = await executeWithIdempotency(
  'processPayment',
  async () => {
    // Your operation here
    return await processPayment(data);
  },
  {paymentId, walletId, amount},
  walletId
);
```

**Features:**
- Automatic duplicate detection using Firestore
- 24-hour TTL for idempotency keys
- Integrated into payment processing

#### Outbox Pattern (`libs/outbox.js`)

Reliable async processing with retry mechanism:

```javascript
const {createOutboxMessage} = require('./libs/outbox');

// Create outbox message for async processing
const messageId = await createOutboxMessage(
  'payment.completed',
  {paymentId, userId, amount},
  {priority: 'high', delaySeconds: 0}
);
```

**Features:**
- Retry with exponential backoff (2, 4, 8 minutes)
- Status tracking (pending, processing, completed, failed)
- Ready for Pub/Sub integration

#### Structured Logging (`utils/logging.js`)

Consistent JSON-formatted logs:

```javascript
const {info, error, warn} = require('./utils/logging');

info('Payment processed', {paymentId, amount, userId});
error('Payment failed', error, {paymentId, userId});
```

**Features:**
- JSON-structured output for easy parsing
- Log levels (DEBUG, INFO, WARN, ERROR)
- Function execution tracking

#### Monitoring (`utils/monitoring.js`)

Performance metrics and health checks:

```javascript
const {monitorFunction, checkHealth} = require('./utils/monitoring');

// Wrap function with automatic monitoring
const monitoredFn = monitorFunction('processPayment', processPayment);

// Check system health
const health = await checkHealth();
```

**Features:**
- Automatic performance tracking
- Health checks for Firestore and Realtime DB
- Ready for metrics storage

---

## Cloud Functions Reference

### Scheduled Functions

#### 1. `fetchBinanceRates`

**Type**: Scheduled Function (Cloud Scheduler)  
**Schedule**: `0 0 * * *` (Daily at midnight UTC)  
**Purpose**: Batch updates Binance P2P rates for all supported currency pairs

**Process**:
1. Resets fee cache for fresh configuration read
2. Iterates through currency pairs: `[{fiat: "KES", asset: "USDT"}, {fiat: "NGN", asset: "USDT"}, {fiat: "GHS", asset: "USDT"}]`
3. For each pair:
   - Fetches market rate from Binance P2P API
   - Applies service fee to calculate customer price
   - Writes to both Firestore and Realtime Database atomically
4. Logs structured results with success/failure counts

**Error Handling**: Returns `null` to prevent retry loops

---

#### 2. `fetchArbitrageRates`

**Type**: Scheduled Function (Cloud Scheduler)  
**Schedule**: `0 0 * * *` (Daily at midnight UTC)  
**Purpose**: Calculates arbitrage rates for USD → USDT → Local Fiat conversion paths

**Process**:
1. Resets fee cache
2. Iterates through fiat currencies: `["KES", "NGN", "GHS"]`
3. For each currency:
   - Fetches USD/USDT rate from Binance (BUY)
   - Fetches USDT/Local rate from Binance (SELL)
   - Calculates conversion path with fees
   - Writes to both databases

---

### Callable Functions

#### 3. `getBinanceRates`

**Type**: Firebase Callable Function  
**Authentication**: Required (Firebase Auth)  
**Purpose**: On-demand rate retrieval with caching

**Request**:
```javascript
const { getFunctions, httpsCallable } = require('firebase/functions');
const functions = getFunctions();
const getBinanceRates = httpsCallable(functions, 'getBinanceRates');

const result = await getBinanceRates({
  fiat: 'KES',    // Optional, default: 'KES'
  asset: 'USDT'   // Optional, default: 'USDT'
});
```

**Response**:
```json
{
  "marketPrice": 129.50,
  "customerPrice": 131.44,
  "feePercentage": 1.5,
  "currencyPair": "USDT/KES",
  "asset": "USDT",
  "fiat": "KES",
  "validUntil": "2024-01-01T00:05:00Z",
  "updatedAt": "2024-01-01T00:00:00Z",
  "source": "firestore"  // or "fresh"
}
```

**Caching Logic**:
- Checks Firestore cache first
- Validates currency pair matches
- Checks if `validUntil` timestamp is still valid
- Returns cached data if valid, otherwise fetches fresh data

---

#### 4. `getArbitrageRates`

**Type**: Firebase Callable Function  
**Authentication**: Required  
**Purpose**: On-demand arbitrage rate retrieval

**Request**:
```javascript
const getArbitrageRates = httpsCallable(functions, 'getArbitrageRates');

const result = await getArbitrageRates({
  fiat: 'KES'  // Optional, default: 'KES'
});
```

**Response**:
```json
{
  "usdRate": 1.000,
  "localRate": 129.50,
  "usdAmount": 1000,
  "usdtBought": 1000,
  "localReceived": 129500,
  "feePercentage": 1.5,
  "customerPayout": 127557.5,
  "profit": 1942.5,
  "currencyPair": "USD/KES",
  "fiat": "KES",
  "validUntil": "2024-01-01T00:10:00Z",
  "updatedAt": "2024-01-01T00:00:00Z",
  "source": "firestore"
}
```

---

#### 5. `createPayment`

**Type**: Firebase Callable Function  
**Authentication**: Required (Firebase Auth)  
**Purpose**: Create a payment order record after IntaSend checkout creation

**Request**:
```javascript
const createPayment = httpsCallable(functions, 'createPayment');

const result = await createPayment({
  amount: 1000,                    // Required: Payment amount
  currency: 'KES',                 // Required: Currency code
  invoiceId: 'XMSLWOS',            // Required: IntaSend invoice ID (or provide checkoutUrl)
  checkoutUrl: 'https://...',      // Optional: IntaSend checkout URL (invoiceId extracted from URL)
  phoneNumber: '+254712345678',    // Optional: User's phone number (fetched from user doc if not provided)
  metadata: {}                     // Optional: Additional metadata
});
```

**Response**:
```json
{
  "success": true,
  "orderId": "order_abc123",
  "invoiceId": "XMSLWOS",
  "paymentId": "XMSLWOS",
  "amount": 1000,
  "currency": "KES",
  "status": "pending",
  "checkoutUrl": "https://payment.intasend.com/checkout/XMSLWOS/express/",
  "createdAt": "2024-01-01T00:00:00Z"
}
```

**What it does**:
- Creates order document in Firestore: `/orders/{orderId}`
- Creates invoice mapping in Realtime DB: `/wallet/pendingTopups/{invoiceId}`
- Creates phone-to-invoice mapping: `/wallet/phoneToInvoice/{phoneNumber}/{invoiceId}`
- Stores order metadata for webhook handler to credit the correct user's wallet

**Note**: This function should be called after creating an IntaSend checkout session to ensure the webhook can properly credit the user's wallet.

---

### HTTP Endpoints

#### 6. `fetchBinanceRatesHttp`

**Type**: HTTP Request Function  
**URL**: `https://us-central1-truepay-72060.cloudfunctions.net/fetchBinanceRatesHttp`  
**CORS**: Enabled  
**Methods**: GET, POST, OPTIONS

**Request**:
```bash
# GET request
curl "https://us-central1-truepay-72060.cloudfunctions.net/fetchBinanceRatesHttp?fiat=KES&asset=USDT"

# POST request
curl -X POST "https://us-central1-truepay-72060.cloudfunctions.net/fetchBinanceRatesHttp" \
  -H "Content-Type: application/json" \
  -d '{"fiat": "KES", "asset": "USDT"}'
```

**Response**: Same format as `getBinanceRates` callable function

---

#### 7. `handleTopUpWebhook`

**Type**: HTTP Request Function  
**URL**: `https://us-central1-truepay-72060.cloudfunctions.net/handleTopUpWebhook`  
**Method**: POST only  
**Security**: HMAC SHA-256 signature verification

**Request Headers**:
- `x-intasend-signature`: HMAC SHA-256 signature (hex encoded)
- `Content-Type`: application/json

**Webhook Payload Format** (IntaSend Invoice):
```json
{
  "invoice_id": "Y5JVGZG",
  "state": "COMPLETE",
  "net_amount": "10.66",
  "currency": "KES",
  "value": "11.00",
  "account": "254742844875",
  "metadata": {
    "user_id": "3mRTw4DvHCXPTVbzAt7OQWOqlNF3"
  }
}
```

**Legacy Format** (also supported):
```json
{
  "event": "payment.completed",
  "data": {
    "payment_id": "pay_abc123",
    "amount": 1000,
    "currency": "KES",
    "completed_at": "2024-01-01T00:00:00Z",
    "metadata": {
      "user_id": "user_xyz789"
    }
  }
}
```

**Response**:
- `200 OK`: Payment processed successfully
- `400 Bad Request`: Missing payment identifier or wallet ID
- `403 Forbidden`: Invalid signature or challenge token
- `405 Method Not Allowed`: Not a POST request
- `500 Configuration error`: Neither INTASEND_SECRET nor INTASEND_CHALLENGE configured

**Security Verification**:
- Verifies HMAC SHA-256 signature (if `INTASEND_SECRET` is configured)
- OR verifies challenge token (if `INTASEND_CHALLENGE` is configured)
- At least one verification method must be configured
- Challenge token can be sent in header `x-intasend-challenge`, query parameter `challenge`, or payload `challenge` field

**Process**:
1. Verifies HMAC SHA-256 signature or challenge token
2. Only processes payments with `state: "COMPLETE"` (skips PENDING, PROCESSING, FAILED)
3. Checks for duplicate processing (prevents double credits)
4. Resolves wallet/user ID using multiple strategies (see Wallet ID Resolution Strategies below)
5. Updates Firestore balance using transaction
6. Updates order status to "completed" if order exists
7. Updates `lastTopUp` timestamp in user document
8. Syncs balance to Realtime Database at `wallet/{userId}/fiat/{currency}`
9. Logs transaction and admin action

---

#### 8. `api` (Customer Wallets REST API)

**Type**: HTTP Request Function (Express Router)  
**Base URL**: `https://us-central1-truepay-72060.cloudfunctions.net/api`  
**CORS**: Enabled with credentials support

**Endpoints**:
- `GET /api/customer-wallets` - List all customer wallets (paginated)
- `GET /api/customer-wallets/:id` - Get single customer wallet
- `POST /api/customer-wallets` - Create customer wallet
- `PUT /api/customer-wallets/:id` - Update customer wallet
- `POST /api/customer-wallets/:id/credit` - Credit money to wallet
- `POST /api/customer-wallets/:id/debit` - Debit money from wallet

**Query Parameters** (for GET /customer-wallets):
- `limit` (optional, default: 100) - Number of records
- `offset` (optional, default: 0) - Number to skip

**Note**: These endpoints work with the legacy `customerWallets` collection. For new architecture, use admin callable functions.

---

### Firestore Triggers

#### 9. `syncBalance`

**Type**: Firestore Trigger (onDocumentUpdated)  
**Trigger**: `users/{uid}` document updated  
**Purpose**: Automatic balance sync from Firestore to Realtime Database

**Process**:
1. Detects balance field change in Firestore user document
2. Extracts currency from user data (default: USD)
3. Syncs to Realtime Database at `wallet/{userId}/fiat/{currency}`
4. Uses retry logic (3 attempts with exponential backoff)
5. Cleans up old balance paths automatically

**Path Written**: `wallet/{userId}/fiat/{currency}` (e.g., `wallet/3mRTw4DvHCXPTVbzAt7OQWOqlNF3/fiat/USD`)

---

#### 10. `onUserCreated`

**Type**: Firestore Trigger (onDocumentCreated)  
**Trigger**: `users/{uid}` document created  
**Purpose**: Handle new user document creation (legacy system)

---

### Callable Functions (User Management)

#### 11. `userBootstrap`

**Type**: Firebase Callable Function  
**Authentication**: Required (Firebase Auth)  
**Purpose**: Initialize user documents and wallets for new users after Firebase Authentication signup

**Request**:
```javascript
const userBootstrap = httpsCallable(functions, 'userBootstrap');

// No parameters needed - uses authenticated user's UID
const result = await userBootstrap();
```

**Response**:
```json
{
  "success": true,
  "userId": "user_abc123",
  "firestore": "created",
  "realtimeDb": "created"
}
```

**Process**:
1. Gets authenticated user's UID from request
2. Fetches user data from Firebase Auth (email, displayName)
3. Checks if user document already exists (idempotency)
4. Creates user document in Firestore: `/users/{uid}` (only if doesn't exist)
5. Initializes balance at `wallet/{uid}/fiat/USD` in Realtime DB
6. Merges missing fields if user document already exists

**Initial User Document**:
```json
{
  "name": "John Doe",
  "email": "user@example.com",
  "createdAt": "2024-01-01T00:00:00Z",
  "balance": 0,
  "country": null,
  "updatedAt": "2024-01-01T00:00:00Z"
}
```

**Note**: This is a callable function that should be called by the client after user signup, not an automatic Auth trigger.

---

## Admin Functions

All admin functions require Firebase Authentication and admin role verification. Users must have `role: 'admin'` in their Firestore user document.

**Base URL**: `https://us-central1-truepay-72060.cloudfunctions.net`

### 1. `getUserData`

**Type**: Firebase Callable Function  
**Authentication**: Required (Admin only)

**Request**:
```javascript
const getUserData = httpsCallable(functions, 'getUserData');

const result = await getUserData({
  userId: 'user123'
});
```

**Response**:
```json
{
  "success": true,
  "userId": "user123",
  "userData": {
    "name": "John Doe",
    "email": "john@example.com",
    "balance": 1000.50,
    "country": "KE",
    "phoneNumber": "+254712345678",
    "kycStatus": "approved",
    "kycData": {},
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-01T00:00:00Z"
  }
}
```

---

### 2. `updateUserProfile`

**Type**: Firebase Callable Function  
**Authentication**: Required (Admin only)

**Request**:
```javascript
const updateUserProfile = httpsCallable(functions, 'updateUserProfile');

const result = await updateUserProfile({
  userId: 'user123',
  updates: {
    name: 'John Updated',
    email: 'john.updated@example.com',
    country: 'NG',
    phoneNumber: '+2341234567890',
    kycStatus: 'approved',
    kycData: {
      documentType: 'passport',
      documentNumber: 'A123456'
    }
  }
});
```

**Allowed Fields**:
- `name` (string)
- `email` (string)
- `country` (string)
- `phoneNumber` (string)
- `kycStatus` (string: "pending", "approved", "rejected", "under_review")
- `kycData` (object)

**Note**: Cannot update `balance` through this endpoint. Use `updateUserBalance` instead.

**Response**:
```json
{
  "success": true,
  "userId": "user123",
  "updatedFields": ["name", "email", "country"]
}
```

---

### 3. `updateUserBalance`

**Type**: Firebase Callable Function  
**Authentication**: Required (Admin only)  
**Purpose**: Update user balance with transaction safety and automatic sync

**Request**:
```javascript
const updateUserBalance = httpsCallable(functions, 'updateUserBalance');

// Credit (add money)
const result = await updateUserBalance({
  userId: 'user123',
  amount: 100,  // Positive for credit
  reason: 'Refund for order #456'
});

// Debit (subtract money)
const result = await updateUserBalance({
  userId: 'user123',
  amount: -50,  // Negative for debit
  reason: 'Chargeback adjustment'
});
```

**Response**:
```json
{
  "success": true,
  "userId": "user123",
  "previousBalance": 1000.50,
  "newBalance": 1100.50,
  "amountDelta": 100,
  "transactionId": "tx_1234567890_abc123"
}
```

**What it does**:
- Updates user balance using Firestore transactions (prevents race conditions)
- Logs transaction to `/transactions/{userId}/transactions/{txId}`
- Syncs balance to Realtime Database automatically at `wallet/{userId}/fiat/{currency}`
- Logs admin action to `/adminLogs/{logId}`
- Admins can set negative balances if needed

---

### 4. `updateKYCStatus`

**Type**: Firebase Callable Function  
**Authentication**: Required (Admin only)

**Request**:
```javascript
const updateKYCStatus = httpsCallable(functions, 'updateKYCStatus');

const result = await updateKYCStatus({
  userId: 'user123',
  kycStatus: 'approved',  // "pending", "approved", "rejected", "under_review"
  kycData: {
    documentType: 'passport',
    documentNumber: 'A123456',
    verifiedAt: '2024-01-01T00:00:00Z',
    verifiedBy: 'admin_user_id'
  }
});
```

**Valid Statuses**: `pending`, `approved`, `rejected`, `under_review`

**Response**:
```json
{
  "success": true,
  "userId": "user123",
  "kycStatus": "approved"
}
```

---

### 5. `syncUserBalanceToRealtime`

**Type**: Firebase Callable Function  
**Authentication**: Required (Admin only)  
**Purpose**: Manually sync user balance to Realtime Database (for fixing discrepancies)

**Request**:
```javascript
const syncUserBalanceToRealtime = httpsCallable(functions, 'syncUserBalanceToRealtime');

const result = await syncUserBalanceToRealtime({
  userId: 'user123'
});
```

**Response**:
```json
{
  "success": true,
  "userId": "user123",
  "balance": 1000.50,
  "currency": "USD",
  "message": "Balance synced successfully"
}
```

**Use Cases**:
- Fix balance discrepancies between Firestore and Realtime DB
- Initialize wallet for existing users
- Manual sync after data migration

---

### 6. `getCommissionConfig`

**Type**: Firebase Callable Function  
**Authentication**: Required (Admin only)  
**Purpose**: Retrieve current commission/fee configuration

**Request**:
```javascript
const getCommissionConfig = httpsCallable(functions, 'getCommissionConfig');

const result = await getCommissionConfig();
```

**Response**:
```json
{
  "success": true,
  "config": {
    "arbitrageFee": 1.5,
    "serviceFee": 1.5,
    "updatedAt": 1704067200000
  }
}
```

**Note**: Returns default values (1.5% for both fees) if config document doesn't exist.

---

### 7. `updateCommissionConfig`

**Type**: Firebase Callable Function  
**Authentication**: Required (Admin only)  
**Purpose**: Update commission/fee configuration

**Request**:
```javascript
const updateCommissionConfig = httpsCallable(functions, 'updateCommissionConfig');

const result = await updateCommissionConfig({
  arbitrageFee: 2.0,  // Optional: Arbitrage fee percentage (0-100)
  serviceFee: 1.5      // Optional: Service fee percentage (0-100)
});
```

**Response**:
```json
{
  "success": true,
  "config": {
    "arbitrageFee": 2.0,
    "serviceFee": 1.5,
    "updatedAt": 1704067200000,
    "updatedBy": "admin_user_id"
  },
  "message": "Commission configuration updated successfully"
}
```

**Validation**:
- Fees must be numbers between 0 and 100
- At least one fee (arbitrageFee or serviceFee) must be provided
- Changes are logged to admin logs

---

### 8. `getIntaSendPaymentStatus`

**Type**: Firebase Callable Function  
**Authentication**: Required (Admin only)  
**Purpose**: Check the status of an IntaSend payment by invoice_id

**Request**:
```javascript
const getIntaSendPaymentStatus = httpsCallable(functions, 'getIntaSendPaymentStatus');

const result = await getIntaSendPaymentStatus({
  invoiceId: 'XMSLWOS'  // IntaSend invoice ID
});
```

**Response**:
```json
{
  "success": true,
  "invoiceId": "XMSLWOS",
  "status": {
    "invoice": {
      "id": "XMSLWOS",
      "invoice_id": "XMSLWOS",
      "state": "PENDING",
      "provider": "M-PESA",
      "charges": "0.00",
      "net_amount": 10.36,
      "currency": "KES",
      "value": "10.36",
      "account": "test@example.com",
      "api_ref": "ISL_faa26ef9-eb08-4353-b125-ec6a8f022815",
      "host": "https://sandbox.intasend.com",
      "failed_reason": null,
      "created_at": "2021-04-11T08:37:15.781977+03:00",
      "updated_at": "2021-04-11T08:37:15.782011+03:00"
    },
    "meta": {
      "id": "5aec8e0b-8d96-429b-98b7-5361198160bd",
      "customer": {
        "id": "ZOEW022",
        "phone_number": "",
        "email": "test@example.com",
        "first_name": "FELIX",
        "last_name": "CHERUIYOT",
        "country": "KE",
        "address": "Westlands",
        "city": "Nairobi",
        "state": "Nairobi",
        "zipcode": "2020",
        "provider": "M-PESA",
        "created_at": "2020-08-06T16:24:06.247397+03:00",
        "updated_at": "2021-04-11T08:37:15.755013+03:00"
      },
      "customer_comment": "",
      "created_at": "2021-04-11T08:37:15.810438+03:00",
      "updated_at": "2021-04-11T08:37:15.810475+03:00"
    }
  },
  "invoice": {
    // Same as status.invoice (for convenience)
  },
  "meta": {
    // Same as status.meta (for convenience)
  }
}
```

**Payment States**:
- `PENDING` - Payment is pending
- `PROCESSING` - Payment is being processed
- `COMPLETE` - Payment completed successfully
- `FAILED` - Payment failed

**Configuration**:
This function requires IntaSend API credentials to be configured as Firebase secrets:
```bash
# Set IntaSend API secret key (required)
firebase functions:secrets:set INTASEND_SECRET_KEY

# Set IntaSend publishable key (optional, but recommended)
firebase functions:secrets:set INTASEND_PUBLISHABLE_KEY
```

**Environment Detection**:
- Automatically detects sandbox vs production based on key format or `INTASEND_ENV` environment variable
- Sandbox keys typically contain "sandbox" or "test"
- Uses appropriate IntaSend API base URL (`sandbox.intasend.com` or `payment.intasend.com`)

**Error Handling**:
- `not-found` - Invoice ID not found in IntaSend
- `permission-denied` - Invalid IntaSend API credentials
- `failed-precondition` - IntaSend API keys not configured
- `deadline-exceeded` - IntaSend API request timed out

**Use Cases**:
- Check payment status for reconciliation
- Verify payment completion before manual balance updates
- Debug payment issues in admin dashboard
- Track payment state changes

---

## Database Structure

### Firestore Collections

#### `/users/{userId}` - User Documents (Master Source)

**Structure**:
```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "balance": 1000.50,
  "currency": "USD",
  "country": "KE",
  "phoneNumber": "+254712345678",
  "kycStatus": "approved",
  "kycData": {
    "documentType": "passport",
    "documentNumber": "A123456"
  },
  "role": "user",  // or "admin"
  "createdAt": "2024-01-01T00:00:00Z",
  "updatedAt": "2024-01-01T00:00:00Z",
  "lastTopUp": "2024-01-01T00:00:00Z"
}
```

**Key Fields**:
- `balance` - Master balance (number, always in USD)
- `currency` - User's preferred currency (default: "USD")
- `role` - User role ("user" or "admin")

---

#### `/transactions/{userId}/transactions/{txId}` - Transaction History

**Structure**:
```json
{
  "type": "credit",
  "amount": 100,
  "status": "completed",
  "timestamp": "2024-01-01T00:00:00Z",
  "previousBalance": 1000.50,
  "newBalance": 1100.50,
  "metadata": {
    "paymentId": "pay_abc123",
    "currency": "KES",
    "source": "intasend",
    "adminId": "admin_user_id",
    "reason": "Refund for order #456"
  },
  "userId": "user123"
}
```

**Transaction Types**: `credit`, `debit`, `transfer`, `topup`, `withdrawal`, `refund`

---

#### `/adminLogs/{logId}` - Admin Action Audit Logs

**Structure**:
```json
{
  "adminId": "admin_user_id",
  "userId": "user123",
  "action": "updateBalance",
  "before": {
    "balance": 1000.50
  },
  "after": {
    "balance": 1100.50,
    "amountDelta": 100
  },
  "timestamp": "2024-01-01T00:00:00Z"
}
```

**Action Types**: `updateProfile`, `updateBalance`, `updateKYC`

---

#### `/p2pRates/binance` - Binance P2P Rates

**Structure**:
```json
{
  "USDT/KES": {
    "marketPrice": 129.50,
    "customerPrice": 131.44,
    "feePercentage": 1.5,
    "currencyPair": "USDT/KES",
    "asset": "USDT",
    "fiat": "KES",
    "validUntil": "2024-01-01T00:05:00Z",
    "updatedAt": "2024-01-01T00:00:00Z"
  },
  "USDT/NGN": { ... },
  "USDT/GHS": { ... }
}
```

---

#### `/p2pRates/arbitrage` - Arbitrage Rates

**Structure**:
```json
{
  "USD/KES": {
    "usdRate": 1.000,
    "localRate": 129.50,
    "usdAmount": 1000,
    "usdtBought": 1000,
    "localReceived": 129500,
    "feePercentage": 1.5,
    "customerPayout": 127557.5,
    "profit": 1942.5,
    "currencyPair": "USD/KES",
    "fiat": "KES",
    "validUntil": "2024-01-01T00:10:00Z",
    "updatedAt": "2024-01-01T00:00:00Z"
  }
}
```

---

#### `/config/fees` - Fee Configuration

**Structure**:
```json
{
  "serviceFee": 1.5,      // Service fee percentage (e.g., 1.5 = 1.5%)
  "arbitrageFee": 1.5     // Arbitrage fee percentage
}
```

**Note**: Fees are stored as percentages but converted to decimals (divided by 100) in code.

---

#### `/orders/{orderId}` - Payment Orders

**Structure**:
```json
{
  "userId": "user_abc123",
  "orderType": "topup",
  "status": "pending",
  "amount": 1000,
  "currency": "KES",
  "invoiceId": "XMSLWOS",
  "phoneNumber": "+254712345678",
  "metadata": {
    "invoiceId": "XMSLWOS",
    "paymentId": "XMSLWOS",
    "checkoutUrl": "https://payment.intasend.com/checkout/XMSLWOS/express/",
    "phoneNumber": "+254712345678",
    "createdAt": "2024-01-01T00:00:00Z"
  },
  "createdAt": "2024-01-01T00:00:00Z",
  "updatedAt": "2024-01-01T00:00:00Z"
}
```

**Order Statuses**: `pending`, `completed`, `failed`, `cancelled`

**Note**: Created by `createPayment` callable function. Used by webhook handler to resolve user ID from invoice ID.

---

#### `/customerWallets/{walletId}` - Legacy Customer Wallets

**Note**: Legacy system. Consider migrating to `/users/{userId}` architecture.

---

### Realtime Database Paths

#### `/wallet/{userId}/fiat/{currency}` - Fiat Wallet Balance (NEW)

**Path Format**: `wallet/{userId}/fiat/USD` (or other currency)

**Structure**:
```json
{
  "balance": 1000.50,
  "currency": "USD",
  "createdAt": 1704067200000,
  "updatedAt": 1704067500000
}
```

**Important**: This is the path your Flutter app should read from for balance queries.

---

#### `/wallet/{userId}/crypto/{currencyCode}` - Crypto Wallet Balance

**Path Format**: `wallet/{userId}/crypto/USDT`

**Structure**:
```json
{
  "balance": 0,
  "currency": "USDT",
  "createdAt": "2024-01-01T00:00:00Z",
  "updatedAt": "2024-01-01T00:00:00Z"
}
```

---

#### `/wallet/rates/binance/{currencyPair}` - Cached Rates

**Example**: `wallet/rates/binance/USDT/KES`

**Structure**:
```json
{
  "customerPrice": 131.44,
  "marketPrice": 129.50,
  "feePercentage": 1.5,
  "currencyPair": "USDT/KES",
  "asset": "USDT",
  "fiat": "KES",
  "updatedAt": 1704067200000,
  "validUntil": 1704067500000
}
```

---

#### `/wallet/rates/arbitrage/{currencyPair}` - Cached Arbitrage Rates

**Example**: `wallet/rates/arbitrage/USD/KES`

**Structure**: Same format as Firestore arbitrage rates, but timestamps in milliseconds.

---

#### `/payments/{paymentId}` - Payment Records

**Structure**:
```json
{
  "invoice_id": "Y5JVGZG",
  "state": "COMPLETE",
  "net_amount": "10.66",
  "currency": "KES",
  "value": "11.00",
  "account": "254742844875",
  "user_id": "3mRTw4DvHCXPTVbzAt7OQWOqlNF3",
  "processed_at": "2024-01-01T00:00:01Z"
}
```

---

#### `/users/{userId}/payments/{paymentId}` - User Payment References

**Structure**:
```json
{
  "payment_id": "payment_1764314016476_g24vew2gj",
  "amount": 50,
  "currency": "KES",
  "status": "link_opened",
  "created_at": "2025-11-28T07:13:36.476Z",
  "updated_at": "2025-11-28T07:13:38.625Z"
}
```

---

#### `/wallet/phoneToInvoice/{phoneNumber}/{invoiceId}` - Phone-to-Invoice Mapping

**Path Format**: `wallet/phoneToInvoice/{phoneNumber}/{invoiceId}`

**Structure**:
```json
{
  "userId": "user_abc123",
  "orderId": "order_xyz789",
  "invoiceId": "XMSLWOS",
  "amount": 1000,
  "currency": "KES",
  "createdAt": "2024-01-01T00:00:00Z"
}
```

**Note**: Created by `createPayment` function for direct phone number lookup in webhook handler.

---

## Payment Processing

### Top-Up Flow

1. **User Initiates Top-Up** (Flutter App)
   - User enters amount and payment details
   - Creates IntaSend checkout session
   - Calls `createPayment` callable function to create order record

2. **Order Creation** (Cloud Function: `createPayment`)
   - Creates order document in Firestore: `/orders/{orderId}`
   - Creates invoice mapping in Realtime DB: `/wallet/pendingTopups/{invoiceId}`
   - Creates phone-to-invoice mapping: `/wallet/phoneToInvoice/{phoneNumber}/{invoiceId}`
   - Returns order data with invoice ID

3. **Payment Completion** (IntaSend)
   - User completes payment on IntaSend
   - IntaSend sends webhook to `handleTopUpWebhook`

4. **Webhook Processing** (Cloud Function: `handleTopUpWebhook`)
   - Verifies HMAC SHA-256 signature or challenge token
   - Resolves wallet/user ID using multiple strategies (phone lookup, order lookup, etc.)
   - Updates Firestore balance using transaction
   - Updates order status to "completed"
   - Updates `lastTopUp` timestamp in user document
   - Syncs to Realtime DB at `wallet/{userId}/fiat/{currency}`

5. **Automatic Sync** (Firestore Trigger: `syncBalance`)
   - `syncBalance` trigger detects Firestore update
   - Ensures Realtime DB is up-to-date with retry logic

### Wallet ID Resolution Strategies

The webhook handler uses multiple strategies to find the correct user (in priority order):

1. **Phone Number Lookup** (PRIMARY - Most Reliable): Query Firestore users by phone number
   - Normalizes phone number (removes leading +, ensures consistent format)
   - Tries multiple field variations: `phoneNumber`, `phone`
   - Tries with and without `+` prefix
   - IntaSend always provides `account` field (phone number) in webhook payload

2. **Order Lookup** (Secondary): Query Firestore orders by `invoice_id`
   - Tries `metadata.invoiceId`, `metadata.paymentId`, or `invoiceId` fields
   - Verifies phone number matches order's phone number if available
   - Falls back to amount+currency match for pending topup orders

3. **RTDB Mapping** (Fallback): Look up `wallet/pendingTopups/{invoice_id}`
   - Created by `createPayment` function
   - Automatically cleaned up after use

4. **Metadata user_id** (Last Resort): From IntaSend payload metadata
   - If IntaSend invoice was created with `metadata.user_id` field

---

## Balance Management

### Architecture: Firestore = Master, Realtime DB = Cache

**Master Source**: Firestore `/users/{userId}.balance`  
**Cache Mirror**: Realtime DB `/wallet/{userId}/fiat/{currency}`

### Update Flow

1. **Balance Update** (any source):
   - Admin dashboard: `updateUserBalance()` callable function
   - Payment webhook: `handleTopUpWebhook()` HTTP endpoint
   - Any direct Firestore update

2. **Firestore Transaction**:
   - Uses `updateBalanceWithTransaction()` utility
   - Prevents race conditions with Firestore transactions
   - Logs transaction automatically

3. **Automatic Sync**:
   - `syncBalance` Firestore trigger fires automatically
   - Syncs to Realtime DB at `wallet/{userId}/fiat/{currency}`
   - Includes retry logic (3 attempts)

4. **Direct Sync** (optional):
   - Functions can call `syncBalanceToRealtime()` directly
   - Used for immediate sync in admin functions

### Balance Paths

**Client App Should Read From**:
```
wallet/{userId}/fiat/USD  ✅ CORRECT PATH
```

**Old Paths (being cleaned up)**:
```
wallet/{userId}/balance   ❌ DEPRECATED
```

The sync function automatically cleans up old paths when writing to the new path.

---

## API Reference

### Complete Function List

| Function Name | Type | Authentication | Purpose |
|--------------|------|---------------|---------|
| `fetchBinanceRates` | Scheduled | None | Daily rate updates |
| `fetchArbitrageRates` | Scheduled | None | Daily arbitrage calculations |
| `getBinanceRates` | Callable | Firebase Auth | Get rates on-demand |
| `getArbitrageRates` | Callable | Firebase Auth | Get arbitrage on-demand |
| `fetchBinanceRatesHttp` | HTTP | None | Public REST API for rates |
| `handleTopUpWebhook` | HTTP | Signature | IntaSend payment webhook |
| `api` | HTTP (REST) | Optional | Customer wallets REST API |
| `userBootstrap` | Callable | Firebase Auth | Initialize new users |
| `syncBalance` | Firestore Trigger | System | Sync balance to RTDB |
| `onUserCreated` | Firestore Trigger | System | Handle user document creation |
| `getUserData` | Callable | Admin | Get user data |
| `updateUserProfile` | Callable | Admin | Update user profile |
| `updateUserBalance` | Callable | Admin | Update user balance |
| `updateKYCStatus` | Callable | Admin | Update KYC status |
| `syncUserBalanceToRealtime` | Callable | Admin | Manual balance sync |
| `getCommissionConfig` | Callable | Admin | Get commission/fee configuration |
| `updateCommissionConfig` | Callable | Admin | Update commission/fee configuration |
| `getIntaSendPaymentStatus` | Callable | Admin | Get IntaSend payment status |
| `createPayment` | Callable | Firebase Auth | Create payment order record |
| `migrateExistingUsers` | Callable | Admin | Migrate users to new architecture |
| `migrateUsersHttp` | HTTP | Optional | HTTP endpoint for user migration |
| `updatePhoneNumbers` | Callable | Admin | Update phone number format |
| `updatePhoneNumbersHttp` | HTTP | Optional | HTTP endpoint for phone updates |

---

## Configuration

### Centralized Configuration (`config.js`)

The refactored codebase uses a centralized configuration module (`functions/config.js`) for:

- **Environment Variables**: Region, resource limits, feature flags
- **Collection Names**: All Firestore collection paths
- **Realtime DB Paths**: All Realtime Database paths
- **Feature Flags**: Enable/disable features (idempotency, outbox, detailed logging)
- **API Configuration**: Binance API settings, supported currencies

**Usage:**
```javascript
const config = require('./config');

// Access configuration
const region = config.region; // "us-central1"
const usersCollection = config.collections.users; // "users"
const enableIdempotency = config.features.enableIdempotency; // true
```

**Feature Flags:**
- `ENABLE_IDEMPOTENCY`: Enable idempotency pattern (default: true)
- `ENABLE_OUTBOX`: Enable outbox pattern (default: true)
- `ENABLE_DETAILED_LOGGING`: Enable detailed logging (default: true)

### Firebase Secrets

Set using Firebase Functions secrets (v7+):

```bash
# Set IntaSend webhook secret (for webhook signature verification)
firebase functions:secrets:set INTASEND_SECRET

# Set IntaSend challenge token (for webhook origin validation)
firebase functions:secrets:set INTASEND_CHALLENGE

# Set IntaSend API secret key (for getIntaSendPaymentStatus function)
firebase functions:secrets:set INTASEND_SECRET_KEY

# Set IntaSend publishable key (optional, for getIntaSendPaymentStatus function)
firebase functions:secrets:set INTASEND_PUBLISHABLE_KEY
```

**Alternative**: Environment variables (for local development):
```bash
export INTASEND_SECRET="your-secret"
export INTASEND_CHALLENGE="your-challenge"
export INTASEND_SECRET_KEY="your-api-secret-key"
export INTASEND_PUBLISHABLE_KEY="your-publishable-key"
```

### Firestore Configuration

#### Fee Configuration

Create document at `config/fees`:

```json
{
  "serviceFee": 1.5,      // Service fee percentage (1.5%)
  "arbitrageFee": 1.5     // Arbitrage fee percentage (1.5%)
}
```

**Access**:
```javascript
const feesDoc = await firestore.collection('config').doc('fees').get();
const fees = feesDoc.data();
```

---

### Scheduled Functions

Scheduled functions use Cloud Scheduler with cron syntax:

- `fetchBinanceRates`: `0 0 * * *` (daily at midnight UTC)
- `fetchArbitrageRates`: `0 0 * * *` (daily at midnight UTC)

To modify schedules, update the cron expression in the function definition:
```javascript
exports.fetchBinanceRates = onSchedule("0 */6 * * *", async () => {
  // Runs every 6 hours
});
```

---

## Security

### 1. Webhook Signature Verification

- **Algorithm**: HMAC SHA-256
- **Header**: `x-intasend-signature` or `X-IntaSend-Signature`
- **Secret Storage**: Firebase Functions secrets (encrypted at rest)
- **Comparison**: Timing-safe comparison (`crypto.timingSafeEqual`) to prevent timing attacks

### 2. Firebase Authentication

- Callable functions require Firebase Authentication
- Admin functions verify `role: 'admin'` in user document
- All functions validate auth context before processing

### 3. Admin Role Verification

Admin functions check:
```javascript
const adminDoc = await firestore.collection("users").doc(adminId).get();
const isAdmin = adminDoc.data().role === 'admin';
```

### 4. Input Validation

- Webhook handler validates required fields
- Balance updates validate amounts and user IDs
- All numeric inputs are parsed and validated
- Currency codes are validated against allowed list

### 5. Transaction Safety

- All balance updates use Firestore transactions
- Prevents race conditions and ensures atomicity
- Rollback on errors

### 6. CORS Configuration

HTTP endpoints have CORS enabled with:
- `Access-Control-Allow-Origin`: Configurable (allows Firebase hosting origins)
- `Access-Control-Allow-Methods`: GET, POST, PUT, DELETE, OPTIONS
- `Access-Control-Allow-Headers`: Content-Type, Authorization
- `Access-Control-Allow-Credentials`: true

---

## Development

### Prerequisites

- **Node.js**: 22.x
- **Firebase CLI**: Latest version
- **Firebase Project**: With Firestore, Realtime Database, and Cloud Functions enabled

### Codebase Structure

The codebase follows a clean architecture pattern:

- **`libs/`**: Pure business logic - easily testable, no Firebase dependencies
- **`http/`**: HTTP handlers - thin controllers that delegate to business logic
- **`triggers/`**: Background triggers - Firestore and Auth event handlers
- **`utils/`**: Utility functions - reusable helpers
- **`config.js`**: Centralized configuration

**See `functions/REFACTORING_SUMMARY.md` for detailed migration information.**

### Local Setup

1. **Clone and Install**:
   ```bash
   git clone <repository-url>
   cd rates_function
   cd functions
   npm install
   ```

2. **Firebase Login**:
   ```bash
   firebase login
   firebase use truepay-72060
   ```

3. **Set Secrets** (for local development):
   ```bash
   export INTASEND_SECRET="your-secret"
   export INTASEND_CHALLENGE="your-challenge"
   export INTASEND_SECRET_KEY="your-api-secret-key"
   export INTASEND_PUBLISHABLE_KEY="your-publishable-key"
   ```

4. **Start Emulators**:
   ```bash
   npm run serve
   # or
   firebase emulators:start --only functions
   ```

### Local Testing

**Test Callable Functions**:
```javascript
// In Firebase Emulator UI or using Firebase SDK
const { getFunctions, httpsCallable } = require('firebase/functions');
const functions = getFunctions('http://localhost:5001');
const getBinanceRates = httpsCallable(functions, 'getBinanceRates');
const result = await getBinanceRates({ fiat: 'KES' });
```

**Test HTTP Endpoints**:
```bash
# Local emulator URL
curl "http://localhost:5001/truepay-72060/us-central1/fetchBinanceRatesHttp?fiat=KES"
```

**Test Webhook** (requires ngrok):
```bash
# Start ngrok tunnel
ngrok http 5001

# Use ngrok URL as webhook callback in IntaSend dashboard
curl -X POST "https://your-ngrok-url/handleTopUpWebhook" \
  -H "x-intasend-signature: <signature>" \
  -d '{...}'
```

### Viewing Logs

```bash
# Firebase CLI
firebase functions:log

# Or in Firebase Console
# Functions → Logs
```

---

## Deployment

### Deploy All Functions

```bash
cd functions
npm run deploy
# or
firebase deploy --only functions
```

### Deploy Specific Function

```bash
firebase deploy --only functions:fetchBinanceRates
firebase deploy --only functions:handleTopUpWebhook
firebase deploy --only functions:updateUserBalance
```

### Set Secrets After Deployment

```bash
firebase functions:secrets:set INTASEND_SECRET
firebase functions:secrets:set INTASEND_CHALLENGE
firebase functions:secrets:set INTASEND_SECRET_KEY
firebase functions:secrets:set INTASEND_PUBLISHABLE_KEY
```

**Note**: Secrets are set interactively. Enter the secret value when prompted.

**Important**: After setting secrets, you must redeploy functions that use them:
```bash
firebase deploy --only functions:handleTopUpWebhook,functions:getIntaSendPaymentStatus
```

### Function URLs

After deployment, function URLs are available:
- Firebase Console → Functions
- Or via CLI: `firebase functions:list`

**Example URLs**:
- `https://us-central1-truepay-72060.cloudfunctions.net/fetchBinanceRatesHttp`
- `https://us-central1-truepay-72060.cloudfunctions.net/handleTopUpWebhook`
- `https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets`

---

## Testing

### Test Rate Fetching

```bash
# Test HTTP endpoint
curl "https://us-central1-truepay-72060.cloudfunctions.net/fetchBinanceRatesHttp?fiat=KES"

# Expected: JSON response with rate data
```

### Test Callable Functions

```javascript
// Using Firebase SDK
import { getFunctions, httpsCallable } from 'firebase/functions';

const functions = getFunctions();
const getBinanceRates = httpsCallable(functions, 'getBinanceRates');

try {
  const result = await getBinanceRates({ fiat: 'KES' });
  console.log('Rates:', result.data);
} catch (error) {
  console.error('Error:', error);
}
```

### Test Admin Functions

```javascript
// Must be authenticated as admin
const updateUserBalance = httpsCallable(functions, 'updateUserBalance');

const result = await updateUserBalance({
  userId: 'test_user_id',
  amount: 10,
  reason: 'Test credit'
});

console.log('Balance updated:', result.data);
```

### Verify Database Updates

After webhook call or balance update, verify:
1. **Firestore**: `/users/{userId}` balance incremented
2. **Realtime Database**: `/wallet/{userId}/fiat/USD` balance updated
3. **Transaction Log**: `/transactions/{userId}/transactions/{txId}` created
4. **Admin Log**: `/adminLogs/{logId}` created (if admin action)

---

## Troubleshooting

### Balance Not Syncing to Realtime DB

**Symptoms**: Firestore balance updates but Realtime DB shows old value

**Solutions**:
1. Check `syncBalance` trigger logs in Firebase Console
2. Manually sync using `syncUserBalanceToRealtime` callable function
3. Verify currency is correctly set in user document
4. Check Realtime DB path: Should be `wallet/{userId}/fiat/{currency}`

### Flutter App Shows 0 Balance

**Symptoms**: User has balance in Firestore but Flutter app shows 0

**Possible Causes**:
1. **Path Mismatch**: Flutter app reading from wrong path
   - **Fix**: Update Flutter app to read from `wallet/{userId}/fiat/USD`

2. **Wallet Not Initialized**: User created before wallet initialization
   - **Fix**: Call `syncUserBalanceToRealtime` for existing users

3. **Sync Failed**: Balance sync trigger failed silently
   - **Fix**: Check trigger logs, manually sync if needed

### Webhook Not Processing Payments

**Symptoms**: Payment completed but wallet not credited

**Possible Causes**:
1. **Invalid Signature**: Webhook signature verification failed
   - **Fix**: Verify `INTASEND_SECRET` is correctly set

2. **Wallet ID Not Resolved**: Could not find user from payment data
   - **Fix**: Ensure order contains `metadata.invoiceId` matching webhook `invoice_id`
   - Or create mapping at `wallet/pendingTopups/{invoice_id}`

3. **Currency Mismatch**: Payment currency doesn't match user currency
   - **Fix**: System handles currency conversion automatically, but verify user document has correct currency

### Admin Functions Return Permission Denied

**Symptoms**: Admin function calls return "permission-denied" error

**Possible Causes**:
1. **User Not Admin**: User document missing `role: 'admin'`
   - **Fix**: Update user document in Firestore to include `role: 'admin'`

2. **Auth Token Missing**: Function called without authentication
   - **Fix**: Ensure Firebase Auth token is included in request

---

## Monitoring

### Firebase Console

- **Functions → Logs**: View function execution logs
- **Functions → Usage**: Monitor function invocations and errors
- **Cloud Logging**: Advanced log filtering and analysis

### Monitoring Utilities (`utils/monitoring.js`)

The refactored codebase includes built-in monitoring:

```javascript
const {monitorFunction, checkHealth, recordMetrics} = require('./utils/monitoring');

// Automatic function monitoring
const monitoredFn = monitorFunction('processPayment', processPayment);

// Health checks
const health = await checkHealth();
// Returns: {status: "healthy", checks: {firestore: "ok", realtimeDb: "ok"}}

// Manual metrics recording
await recordMetrics('myFunction', 150, true, {userId: 'abc123'});
```

### Structured Logging (`utils/logging.js`)

Functions emit structured JSON logs using the logging utility:
```json
{
  "event": "rates_updated",
  "source": "binance",
  "currencyPair": "USDT/KES",
  "customerPrice": 131.44,
  "marketPrice": 129.50,
  "feePercentage": 1.5,
  "firestore": "success",
  "rtdb": "success",
  "timestamp": "2024-01-01T00:00:00Z"
}
```

### Error Monitoring

- Errors are logged with descriptive messages
- Batch completion logs include success/failure counts
- Webhook errors include payment ID and user ID for tracking

---

## Dependencies

- **firebase-admin**: ^13.6.0 - Firebase Admin SDK for server-side operations
- **firebase-functions**: ^7.0.0 - Firebase Cloud Functions runtime
- **axios**: ^1.12.2 - HTTP client for Binance API requests
- **express**: ^5.2.0 - Web framework for REST API endpoints
- **node-cron**: ^4.2.1 - Cron expression parser (for scheduled functions)

---

## Best Practices

### Balance Updates

1. **Always use transactions**: Use `updateBalanceWithTransaction()` for all balance changes
2. **Check Firestore first**: Firestore is the master source of truth
3. **Let triggers sync**: Don't manually sync unless fixing discrepancies
4. **Log all changes**: All balance updates are automatically logged

### Client App Integration

1. **Read from Realtime DB**: Use Realtime Database for real-time balance display
2. **Read from Firestore for validation**: Use Firestore for critical operations
3. **Handle missing wallets**: Return 0 balance if wallet doesn't exist
4. **Use correct paths**: Read from `wallet/{userId}/fiat/{currency}` (not `/balance`)

### Webhook Security

1. **Always verify signatures**: Never process webhooks without signature verification
2. **Use secrets**: Store webhook secrets in Firebase Functions secrets
3. **Log all webhook attempts**: Monitor for suspicious activity
4. **Idempotency**: Handle duplicate webhook calls gracefully

---

## License

Private - All rights reserved
