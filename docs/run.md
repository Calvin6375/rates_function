# Running TruePay Backend Functions Locally

This guide provides step-by-step instructions for running and testing all Firebase Cloud Functions locally using the Firebase Emulator.

## Quick Start

```bash
# 1. Install dependencies
cd functions && npm install

# 2. Login to Firebase
firebase login
firebase use truepay-72060

# 3. Start all emulators (recommended)
firebase emulators:start

# 4. Open Emulator UI
# http://localhost:4000
```

**Important**: Start all emulators (not just functions) for full functionality. Most functions require Firestore and Realtime Database.

## Prerequisites

1. **Node.js 22** - Required runtime version
2. **Firebase CLI** - Install globally: `npm install -g firebase-tools`
3. **Firebase Project** - You need access to the `truepay-72060` Firebase project

## Initial Setup

### 1. Install Dependencies

```bash
cd functions
npm install
```

### 2. Login to Firebase

```bash
firebase login
firebase use truepay-72060
```

### 3. Set Environment Variables (Optional)

For local testing, you can set environment variables for IntaSend integration:

```bash
export INTASEND_SECRET="your-secret"
export INTASEND_CHALLENGE="your-challenge"
export INTASEND_SECRET_KEY="your-api-secret-key"
export INTASEND_PUBLISHABLE_KEY="your-publishable-key"
```

**Note**: These are optional for most functions. Only required for:
- `handleTopUpWebhook` - Requires INTASEND_SECRET or INTASEND_CHALLENGE
- `getIntaSendPaymentStatus` - Requires INTASEND_SECRET_KEY

## Starting the Emulator

### Start Functions Emulator Only

```bash
cd functions
npm run serve
# or
firebase emulators:start --only functions
```

The emulator will start on:
- **Functions Emulator UI**: http://localhost:4000
- **Functions Endpoint**: http://localhost:5001

### Start All Emulators (Functions + Firestore + Realtime DB)

```bash
firebase emulators:start
```

This starts:
- Functions: http://localhost:5001
- Firestore: http://localhost:8080
- Realtime Database: http://localhost:9000
- Emulator UI: http://localhost:4000

## Available Functions

### Scheduled Functions (Manual Trigger Required in Emulator)

These functions are scheduled to run daily but can be manually triggered in the emulator:

1. **fetchBinanceRates** - Fetches Binance P2P rates for KES, NGN, GHS
2. **fetchArbitrageRates** - Calculates arbitrage rates for USD → USDT → Local Fiat

### Callable Functions (Require Firebase Auth)

These functions require authentication. Test using Firebase SDK or emulator UI:

3. **getBinanceRates** - Get Binance rates on-demand
4. **getArbitrageRates** - Get arbitrage rates on-demand
5. **createPayment** - Create payment order record
6. **userBootstrap** - Initialize new user account
7. **getUserData** - Get user data (Admin only)
8. **updateUserProfile** - Update user profile (Admin only)
9. **updateUserBalance** - Update user balance (Admin only)
10. **updateKYCStatus** - Update KYC status (Admin only)
11. **syncUserBalanceToRealtime** - Manual balance sync (Admin only)
12. **getCommissionConfig** - Get commission config (Admin only)
13. **updateCommissionConfig** - Update commission config (Admin only)
14. **getIntaSendPaymentStatus** - Get IntaSend payment status (Admin only)
15. **migrateExistingUsers** - Migrate users to new architecture (Admin only)
16. **updatePhoneNumbers** - Update phone number format (Admin only)

### HTTP Endpoints (No Auth Required)

These can be tested directly with curl or HTTP client:

17. **fetchBinanceRatesHttp** - HTTP endpoint for Binance rates
18. **handleTopUpWebhook** - IntaSend payment webhook handler
19. **api** - REST API for customer wallets
20. **migrateUsersHttp** - HTTP endpoint for user migration
21. **updatePhoneNumbersHttp** - HTTP endpoint for phone updates

### Firestore Triggers (Automatic)

These trigger automatically when Firestore documents change:

22. **syncBalance** - Syncs balance from Firestore to Realtime DB
23. **onUserCreated** - Initializes default fields for new users

## Testing Functions

### Testing HTTP Endpoints

#### 1. fetchBinanceRatesHttp

```bash
# GET request
curl "http://localhost:5001/truepay-72060/us-central1/fetchBinanceRatesHttp?fiat=KES&asset=USDT"

# POST request
curl -X POST "http://localhost:5001/truepay-72060/us-central1/fetchBinanceRatesHttp" \
  -H "Content-Type: application/json" \
  -d '{"fiat": "KES", "asset": "USDT"}'
```

#### 2. Customer Wallets REST API

```bash
# Get Binance rates
curl "http://localhost:5001/truepay-72060/us-central1/api/binance/rates?fiat=KES"

# List customer wallets
curl "http://localhost:5001/truepay-72060/us-central1/api/customer-wallets?limit=10&offset=0"

# Get specific wallet
curl "http://localhost:5001/truepay-72060/us-central1/api/customer-wallets/{walletId}"

# Create wallet
curl -X POST "http://localhost:5001/truepay-72060/us-central1/api/customer-wallets" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test User",
    "email": "test@example.com",
    "phone": "+254712345678",
    "initialBalance": 100
  }'

# Credit wallet
curl -X POST "http://localhost:5001/truepay-72060/us-central1/api/customer-wallets/{walletId}/credit" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 50,
    "description": "Test credit"
  }'

# Debit wallet
curl -X POST "http://localhost:5001/truepay-72060/us-central1/api/customer-wallets/{walletId}/debit" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 25,
    "description": "Test debit"
  }'
```

#### 3. Migration Endpoints

```bash
# Migrate users
curl -X POST "http://localhost:5001/truepay-72060/us-central1/migrateUsersHttp/migrateUsers" \
  -H "Content-Type: application/json"

# Update phone numbers
curl -X POST "http://localhost:5001/truepay-72060/us-central1/updatePhoneNumbersHttp/updatePhoneNumbers" \
  -H "Content-Type: application/json"
```

#### 4. Webhook Handler (handleTopUpWebhook)

```bash
# Test webhook (requires signature or challenge)
curl -X POST "http://localhost:5001/truepay-72060/us-central1/handleTopUpWebhook" \
  -H "Content-Type: application/json" \
  -H "x-intasend-signature: <signature>" \
  -d '{
    "invoice_id": "TEST123",
    "state": "COMPLETE",
    "net_amount": "100.00",
    "currency": "KES",
    "value": "100.00",
    "account": "254712345678",
    "metadata": {
      "user_id": "test_user_id"
    }
  }'
```

### Testing Callable Functions

Callable functions require Firebase Authentication. Use the Firebase Emulator UI or Firebase SDK.

#### Using Firebase Emulator UI

1. Open http://localhost:4000
2. Navigate to "Functions" tab
3. Select a callable function
4. Enter test data and click "Run"

#### Using Firebase SDK (Node.js)

Create a test script:

```javascript
const { initializeApp } = require('firebase/app');
const { getFunctions, httpsCallable, connectFunctionsEmulator } = require('firebase/functions');
const { getAuth, signInWithEmailAndPassword } = require('firebase/auth');

const firebaseConfig = {
  projectId: 'truepay-72060',
};

const app = initializeApp(firebaseConfig);
const functions = getFunctions(app);
const auth = getAuth(app);

// Connect to emulator
connectFunctionsEmulator(functions, 'localhost', 5001);

// Sign in (you'll need a test user)
await signInWithEmailAndPassword(auth, 'test@example.com', 'password');

// Test getBinanceRates
const getBinanceRates = httpsCallable(functions, 'getBinanceRates');
const result = await getBinanceRates({ fiat: 'KES', asset: 'USDT' });
console.log('Rates:', result.data);
```

### Testing Scheduled Functions

Scheduled functions can be manually triggered in the emulator UI:

1. Open http://localhost:4000
2. Navigate to "Functions" tab
3. Find the scheduled function
4. Click "Trigger" button

### Testing Firestore Triggers

Triggers fire automatically when documents change:

1. Create/update a user document in Firestore emulator
2. Watch the function logs in the emulator UI
3. Check Realtime Database for synced data

## Important: Running with All Emulators

**⚠️ Most functions require Firestore and Realtime Database emulators to be running.**

For full functionality, start all emulators:

```bash
firebase emulators:start
```

This will start:
- **Functions Emulator**: http://localhost:5001
- **Firestore Emulator**: http://localhost:8080  
- **Realtime Database Emulator**: http://localhost:9000
- **Emulator UI**: http://localhost:4000

**Why?** Most functions interact with Firestore (user data, rates, orders) and Realtime Database (wallet balances, cached rates). Without these emulators, you'll see authentication errors like:

```
"Getting metadata from plugin failed with error: invalid_grant"
```

## Function Outputs

Below are the actual outputs from testing each function locally:

---

## Test Results

### Test Environment
- **Date**: January 7, 2025
- **Emulator**: Firebase Functions Emulator (functions only)
- **Base URL**: `http://localhost:5001/truepay-72060/us-central1`

### HTTP Endpoints Test Results

#### 1. fetchBinanceRatesHttp (GET)
```bash
curl "http://localhost:5001/truepay-72060/us-central1/fetchBinanceRatesHttp?fiat=KES&asset=USDT"
```

**Result**: ❌ Error
```json
{
  "error": "internal",
  "message": "Failed to fetch rates: 2 UNKNOWN: Getting metadata from plugin failed with error: invalid_grant"
}
```

**Note**: Requires Firestore emulator for rate caching. Also needs internet connection to fetch from Binance API.

**Expected Success Response**:
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
  "source": "firestore"
}
```

#### 2. fetchBinanceRatesHttp (POST)
```bash
curl -X POST "http://localhost:5001/truepay-72060/us-central1/fetchBinanceRatesHttp" \
  -H "Content-Type: application/json" \
  -d '{"fiat": "KES", "asset": "USDT"}'
```

**Result**: ❌ Error (same as GET)
```json
{
  "error": "internal",
  "message": "Failed to fetch rates: 2 UNKNOWN: Getting metadata from plugin failed with error: invalid_grant"
}
```

#### 3. API: GET /binance/rates
```bash
curl "http://localhost:5001/truepay-72060/us-central1/api/binance/rates?fiat=KES&asset=USDT"
```

**Result**: ❌ Error
```json
{
  "error": "internal",
  "message": "Failed to fetch rates: 2 UNKNOWN: Getting metadata from plugin failed with error: invalid_grant"
}
```

#### 4. API: GET /customer-wallets
```bash
curl "http://localhost:5001/truepay-72060/us-central1/api/customer-wallets?limit=5&offset=0"
```

**Result**: ❌ Error
```json
{
  "success": false,
  "error": "Failed to fetch customer wallets",
  "message": "2 UNKNOWN: Getting metadata from plugin failed with error: invalid_grant"
}
```

**Note**: Requires Firestore emulator to query customer wallets collection.

**Expected Success Response**:
```json
{
  "success": true,
  "data": [
    {
      "id": "wallet_id",
      "name": "John Doe",
      "email": "john@example.com",
      "phone": "+254712345678",
      "balance": 1000.50,
      "status": "active",
      "createdAt": "2024-01-01T00:00:00Z",
      "updatedAt": "2024-01-01T00:00:00Z"
    }
  ],
  "pagination": {
    "total": 10,
    "limit": 5,
    "offset": 0,
    "hasMore": true
  }
}
```

#### 5. API: POST /customer-wallets
```bash
curl -X POST "http://localhost:5001/truepay-72060/us-central1/api/customer-wallets" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test User",
    "email": "test@example.com",
    "phone": "+254712345678",
    "initialBalance": 100
  }'
```

**Result**: ❌ Error
```json
{
  "success": false,
  "error": "Failed to create customer wallet",
  "message": "2 UNKNOWN: Getting metadata from plugin failed with error: invalid_grant"
}
```

**Expected Success Response**:
```json
{
  "success": true,
  "data": {
    "id": "new_wallet_id",
    "name": "Test User",
    "email": "test@example.com",
    "phone": "+254712345678",
    "balance": 100,
    "status": "active",
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-01T00:00:00Z"
  }
}
```

#### 6. migrateUsersHttp
```bash
curl -X POST "http://localhost:5001/truepay-72060/us-central1/migrateUsersHttp/migrateUsers" \
  -H "Content-Type: application/json"
```

**Result**: ❌ Error
```json
{
  "success": false,
  "error": "Migration failed",
  "message": "2 UNKNOWN: Getting metadata from plugin failed with error: invalid_grant"
}
```

**Note**: Requires Firestore emulator to access users collection.

#### 7. updatePhoneNumbersHttp
```bash
curl -X POST "http://localhost:5001/truepay-72060/us-central1/updatePhoneNumbersHttp/updatePhoneNumbers" \
  -H "Content-Type: application/json"
```

**Result**: ❌ Error
```json
{
  "success": false,
  "error": "Phone number update failed",
  "message": "2 UNKNOWN: Getting metadata from plugin failed with error: invalid_grant"
}
```

**Note**: Requires Firestore emulator to access users collection.

### Callable Functions

Callable functions require Firebase Authentication and cannot be tested with simple curl commands. Use:

1. **Firebase Emulator UI** (http://localhost:4000)
   - Navigate to Functions tab
   - Select function
   - Enter test data
   - Click "Run"

2. **Firebase SDK** (see example in Testing Callable Functions section)

### Scheduled Functions

Scheduled functions can be manually triggered in the Emulator UI:
1. Open http://localhost:4000
2. Go to Functions tab
3. Find `fetchBinanceRates` or `fetchArbitrageRates`
4. Click "Trigger" button

### Firestore Triggers

Triggers automatically fire when documents change. To test:

1. Start all emulators: `firebase emulators:start`
2. Create/update a user document in Firestore emulator UI
3. Watch function logs in Emulator UI
4. Check Realtime Database for synced data

---

## Summary

### Functions Tested: 7
- ✅ **Success**: 0 (all require Firestore/Realtime DB emulators)
- ❌ **Failed**: 7 (authentication errors due to missing emulators)
- ⏭️ **Skipped**: 16 (callable functions require auth setup)

### Key Findings

1. **All functions require Firestore emulator** - Functions interact with Firestore for data storage
2. **Rate functions need internet** - Binance API calls require network access
3. **Callable functions need authentication** - Must use Firebase SDK or Emulator UI
4. **Triggers need all emulators** - Firestore triggers require Firestore emulator running

### Recommendations

1. **Always start all emulators** for full functionality:
   ```bash
   firebase emulators:start
   ```

2. **Use Emulator UI** for testing callable functions (http://localhost:4000)

3. **Set up test data** in Firestore emulator before testing functions that read data

4. **For production-like testing**, use Firebase project with proper credentials:
   ```bash
   export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account-key.json"
   ```

5. **Test webhooks** using tools like ngrok to expose local emulator:
   ```bash
   ngrok http 5001
   # Use ngrok URL as webhook callback
   ```

