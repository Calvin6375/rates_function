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

```
functions/
├── index.js              # Main entry point - exports all functions
├── admin.js              # Firebase Admin SDK initialization
├── rates.js              # Binance P2P rate fetching
├── arbitrage.js          # Arbitrage calculation logic
├── payments.js           # IntaSend webhook handler
├── adminActions.js       # Admin dashboard functions
├── customerWallets.js    # Legacy customer wallets REST API
├── userBootstrap.js      # User creation trigger
├── balanceSync.js        # Balance sync trigger
├── users.js              # User Firestore triggers
├── migrateUsers.js       # User migration utilities
├── updatePhoneNumbers.js # Phone number update utilities
└── utils/
    ├── firestore.js      # Firestore helper functions
    ├── realtime.js       # Realtime DB helper functions
    ├── transactions.js   # Transaction logging utilities
    └── validation.js     # Input validation utilities
```

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

### HTTP Endpoints

#### 5. `fetchBinanceRatesHttp`

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

#### 6. `handleTopUpWebhook`

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
- `403 Forbidden`: Invalid signature
- `405 Method Not Allowed`: Not a POST request
- `500 Configuration error`: Webhook secret not configured

**Process**:
1. Verifies HMAC SHA-256 signature
2. Resolves wallet/user ID using multiple strategies:
   - Order lookup (preferred): Query Firestore orders by invoice_id
   - RTDB mapping: Look up `wallet/pendingTopups/{invoice_id}`
   - Metadata user_id: From IntaSend payload
   - Phone lookup (fallback): Resolve account (phone) → Firestore user doc
3. Updates Firestore balance using transaction
4. Syncs balance to Realtime Database at `wallet/{userId}/fiat/{currency}`
5. Logs transaction and admin action

---

#### 7. `api` (Customer Wallets REST API)

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

#### 8. `syncBalance`

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

#### 9. `onUserCreated`

**Type**: Firestore Trigger (onDocumentCreated)  
**Trigger**: `users/{uid}` document created  
**Purpose**: Handle new user document creation (legacy system)

---

### Auth Triggers

#### 10. `userBootstrap`

**Type**: Auth Trigger (auth.user().onCreate)  
**Trigger**: New user created via Firebase Authentication  
**Purpose**: Initialize user documents and wallets for new users

**Process**:
1. Creates user document in Firestore: `/users/{uid}`
2. Initializes balance at `wallet/{uid}/fiat/USD` in Realtime DB
3. Ensures idempotency by checking if user document exists

**Initial User Document**:
```json
{
  "name": null,
  "email": "user@example.com",
  "createdAt": "2024-01-01T00:00:00Z",
  "balance": 0,
  "country": null,
  "updatedAt": "2024-01-01T00:00:00Z"
}
```

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

## Payment Processing

### Top-Up Flow

1. **User Initiates Top-Up** (Flutter App)
   - User enters amount and payment details
   - Creates IntaSend checkout session
   - Stores payment record in Realtime DB

2. **Payment Completion** (IntaSend)
   - User completes payment on IntaSend
   - IntaSend sends webhook to `handleTopUpWebhook`

3. **Webhook Processing** (Cloud Function)
   - Verifies HMAC SHA-256 signature
   - Resolves wallet/user ID using multiple strategies
   - Updates Firestore balance using transaction
   - Syncs to Realtime DB at `wallet/{userId}/fiat/{currency}`

4. **Automatic Sync** (Firestore Trigger)
   - `syncBalance` trigger detects Firestore update
   - Ensures Realtime DB is up-to-date with retry logic

### Wallet ID Resolution Strategies

The webhook handler uses multiple strategies to find the correct user:

1. **Order Lookup** (Preferred): Query Firestore orders by `invoice_id`
   ```javascript
   orders.where("metadata.invoiceId", "==", paymentId)
         .where("orderType", "==", "topup")
   ```

2. **RTDB Mapping** (Fallback): Look up `wallet/pendingTopups/{invoice_id}`

3. **Metadata user_id**: From IntaSend payload metadata

4. **Phone Lookup** (Last Resort): Resolve account (phone) → Firestore user doc

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
| `userBootstrap` | Auth Trigger | System | Initialize new users |
| `syncBalance` | Firestore Trigger | System | Sync balance to RTDB |
| `onUserCreated` | Firestore Trigger | System | Handle user document creation |
| `getUserData` | Callable | Admin | Get user data |
| `updateUserProfile` | Callable | Admin | Update user profile |
| `updateUserBalance` | Callable | Admin | Update user balance |
| `updateKYCStatus` | Callable | Admin | Update KYC status |
| `syncUserBalanceToRealtime` | Callable | Admin | Manual balance sync |
| `migrateExistingUsers` | Callable | Admin | Migrate users to new architecture |
| `migrateUsersHttp` | HTTP | Optional | HTTP endpoint for user migration |
| `updatePhoneNumbers` | Callable | Admin | Update phone number format |
| `updatePhoneNumbersHttp` | HTTP | Optional | HTTP endpoint for phone updates |

---

## Configuration

### Firebase Secrets

Set using Firebase Functions secrets (v7+):

```bash
# Set IntaSend webhook secret
firebase functions:secrets:set INTASEND_SECRET

# Set IntaSend challenge token
firebase functions:secrets:set INTASEND_CHALLENGE
```

**Alternative**: Environment variables (for local development):
```bash
export INTASEND_SECRET="your-secret"
export INTASEND_CHALLENGE="your-challenge"
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
```

**Note**: Secrets are set interactively. Enter the secret value when prompted.

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

### Structured Logging

Functions emit structured JSON logs:
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
