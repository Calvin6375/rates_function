# Rates Function - Firebase Cloud Functions

A comprehensive Firebase Cloud Functions application that provides real-time cryptocurrency exchange rate services and payment processing capabilities. The application fetches P2P exchange rates from Binance, calculates arbitrage opportunities, and handles payment webhooks for wallet top-ups.

## Table of Contents

- [Overview](#overview)
- [System Architecture](#system-architecture)
- [How It Works](#how-it-works)
  - [Binance P2P Rate Fetcher](#1-binance-p2p-rate-fetcher)
  - [Arbitrage Rate Calculator](#2-arbitrage-rate-calculator)
  - [Payment Webhook Handler](#3-payment-webhook-handler)
- [Data Flow](#data-flow)
- [API Reference](#api-reference)
- [Configuration](#configuration)
- [Security](#security)
- [Error Handling](#error-handling)
- [Development](#development)
- [Deployment](#deployment)
- [Testing](#testing)

---

## Overview

This application serves as a backend service for a cryptocurrency exchange platform, providing:

1. **Real-time P2P Exchange Rates**: Fetches USDT exchange rates for multiple African currencies (KES, NGN, GHS) from Binance P2P marketplace
2. **Arbitrage Calculations**: Calculates profitable conversion paths for USD → USDT → Local Fiat currency
3. **Payment Processing**: Handles webhook callbacks from IntaSend payment gateway to update user wallet balances

The system uses **Firebase Functions v2** with scheduled triggers, callable functions, and HTTP endpoints. Data is stored in both **Firestore** (for persistent storage and analytics) and **Realtime Database** (for real-time updates to client applications).

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Firebase Cloud Functions                   │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────┐  │
│  │  Scheduled Jobs  │  │  Callable Funcs  │  │   HTTP   │  │
│  │                  │  │                  │  │ Endpoints│  │
│  │ • fetchBinance   │  │ • getBinance     │  │ • fetch  │  │
│  │   Rates          │  │   Rates          │  │   Binance│  │
│  │ • fetchArbitrage │  │ • getArbitrage   │  │   Rates  │  │
│  │   Rates          │  │   Rates          │  │ • handle │  │
│  │                  │  │                  │  │   TopUp   │  │
│  │                  │  │                  │  │   Webhook │  │
│  └────────┬─────────┘  └────────┬─────────┘  └────┬─────┘  │
│           │                     │                   │        │
│           └─────────────────────┴───────────────────┘        │
│                              │                               │
│                    ┌─────────▼─────────┐                    │
│                    │   Business Logic   │                    │
│                    │                    │                    │
│                    │  • rates.js        │                    │
│                    │  • arbitrage.js    │                    │
│                    │  • payments.js     │                    │
│                    └─────────┬─────────┘                    │
│                              │                               │
└──────────────────────────────┼───────────────────────────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
        ▼                      ▼                      ▼
┌───────────────┐    ┌───────────────┐    ┌──────────────┐
│   Firestore   │    │  Realtime DB  │    │   Binance    │
│               │    │               │    │   P2P API    │
│ • p2pRates    │    │ • wallet/rates │    │              │
│ • config/fees │    │ • wallet/     │    │              │
│ • users       │    │   balance     │    │              │
│               │    │ • payments    │    │              │
└───────────────┘    └───────────────┘    └──────────────┘
```

### File Structure

```
functions/
├── index.js        # Main entry point - exports all functions
├── admin.js        # Firebase Admin SDK initialization (singleton pattern)
├── rates.js        # Binance P2P rate fetching and management
├── arbitrage.js    # Arbitrage calculation logic
├── payments.js     # IntaSend webhook handler
└── package.json    # Dependencies and scripts
```

---

## How It Works

### 1. Binance P2P Rate Fetcher

#### Overview
Fetches real-time USDT exchange rates from Binance P2P marketplace for multiple currency pairs (USDT/KES, USDT/NGN, USDT/GHS). Applies a configurable service fee to market rates and stores them in both Firestore and Realtime Database.

#### Components

**1.1. Scheduled Function: `fetchBinanceRates`**
- **Trigger**: Cloud Scheduler (cron: `0 0 * * *` - runs daily at midnight UTC)
- **Purpose**: Batch updates rates for all supported currency pairs
- **Process**:
  1. Resets fee cache for fresh configuration read
  2. Iterates through currency pairs: `[{fiat: "KES", asset: "USDT"}, {fiat: "NGN", asset: "USDT"}, {fiat: "GHS", asset: "USDT"}]`
  3. For each pair:
     - Calls `fetchBinanceRateData()` to get market rate
     - Applies service fee to calculate customer price
     - Writes to both Firestore and RTDB atomically via `writeRatesAtomically()`
  4. Logs structured results (success/failure per pair)
  5. Returns `null` to prevent retry loops on errors

**1.2. Core Function: `fetchBinanceRateData(fiat, asset)`**
- **Parameters**:
  - `fiat`: Fiat currency code (default: "KES")
  - `asset`: Crypto asset (default: "USDT")
- **Process**:
  1. Makes POST request to Binance P2P API:
     ```javascript
     POST https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search
     Body: {
       asset: "USDT",
       fiat: "KES",
       tradeType: "BUY",  // Buying USDT with fiat
       page: 1,
       rows: 10
     }
     ```
  2. Extracts market price from first offer: `response.data.data[0].adv.price`
  3. Fetches service fee from Firestore config (cached per execution)
  4. Calculates customer price: `marketPrice * (1 + feePercentage)`
  5. Sets `validUntil` timestamp (5 minutes from now)
  6. Returns rate data object with:
     - `marketPrice`: Raw Binance rate
     - `customerPrice`: Rate with service fee applied
     - `feePercentage`: Fee as percentage (e.g., 1.5)
     - `currencyPair`: String identifier (e.g., "USDT/KES")
     - `validUntil`: Firestore Timestamp (5 minutes validity)
     - `updatedAt`: Server timestamp

**1.3. Storage Function: `writeRatesAtomically(currencyPair, ratesData)`**
- **Purpose**: Writes rate data to both Firestore and Realtime Database atomically
- **Process**:
  1. **Firestore Write**:
     - Creates batch write operation
     - Writes to `p2pRates/binance` document
     - Uses `merge: true` to preserve other fields
     - Commits batch
  2. **Realtime Database Write**:
     - Converts Firestore Timestamp to milliseconds for `validUntil`
     - Writes to path: `wallet/rates/binance/{currencyPair}`
     - Uses `ServerValue.TIMESTAMP` for `updatedAt`
  3. **Logging**: Emits structured JSON log with update details

**1.4. Callable Function: `getBinanceRates`**
- **Type**: Firebase Callable Function (HTTPS Callable)
- **Purpose**: On-demand rate retrieval with caching
- **Process**:
  1. Accepts optional parameters: `{fiat: "KES", asset: "USDT"}`
  2. Checks Firestore cache:
     - Reads `p2pRates/binance` document
     - Validates currency pair matches
     - Checks if `validUntil` timestamp is still valid
  3. If cache hit and valid: Returns cached data with `source: "firestore"`
  4. If cache miss or expired: Fetches fresh data, writes to storage, returns with `source: "fresh"`

**1.5. HTTP Endpoint: `fetchBinanceRatesHttp`**
- **Type**: HTTP Request Function with CORS
- **Purpose**: Public REST API endpoint for rate retrieval
- **URL Format**: `https://{region}-{project-id}.cloudfunctions.net/fetchBinanceRatesHttp`
- **Methods**: GET, POST, OPTIONS (for CORS preflight)
- **Query Parameters**:
  - `fiat`: Fiat currency code (default: "KES")
  - `asset`: Crypto asset (default: "USDT")
- **CORS**: Enabled with `Access-Control-Allow-Origin: *`
- **Response**: JSON object with rate data

**1.6. Fee Configuration: `getServiceFee()`**
- **Purpose**: Retrieves service fee percentage from Firestore
- **Caching**: Uses module-level `feeCache` variable (per execution)
- **Process**:
  1. Checks cache first (returns immediately if cached)
  2. Reads `config/fees` document from Firestore
  3. Extracts `serviceFee` field (stored as percentage, e.g., 1.5)
  4. Converts to decimal (divides by 100): `1.5 → 0.015`
  5. Falls back to `0.015` (1.5%) if config missing
  6. Caches result for current execution

#### Data Structures

**Firestore Document: `p2pRates/binance`**
```json
{
  "marketPrice": 129.50,
  "customerPrice": 131.44,
  "feePercentage": 1.5,
  "currencyPair": "USDT/KES",
  "asset": "USDT",
  "fiat": "KES",
  "validUntil": "2024-01-01T00:05:00Z",
  "updatedAt": "2024-01-01T00:00:00Z"
}
```

**Realtime Database: `wallet/rates/binance/{currencyPair}`**
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

### 2. Arbitrage Rate Calculator

#### Overview
Calculates arbitrage opportunities for converting USD → USDT → Local Fiat currency. Fetches rates from both US market (USD/USDT) and local market (USDT/Local Fiat), then calculates the conversion path with fees applied.

#### Components

**2.1. Scheduled Function: `fetchArbitrageRates`**
- **Trigger**: Cloud Scheduler (cron: `0 0 * * *` - runs daily at midnight UTC)
- **Purpose**: Batch calculates arbitrage rates for multiple currencies
- **Process**:
  1. Resets fee cache
  2. Iterates through fiat currencies: `["KES", "NGN", "GHS"]`
  3. For each currency:
     - Calls `calculateArbitrage(fiat)` to compute rates
     - Writes to both databases via `writeArbitrageAtomically()`
  4. Logs structured results and errors

**2.2. Core Calculation: `calculateArbitrage(fiat, usdAmount)`**
- **Parameters**:
  - `fiat`: Target fiat currency (default: "KES")
  - `usdAmount`: Reference USD amount (default: 1000)
- **Process**:
  1. **Fetch USD Rate**: Calls `fetchUSDRate()`
     - Queries Binance P2P for USD/USDT (BUY type)
     - Returns rate (e.g., 1.000 means 1 USD = 1 USDT)
  2. **Fetch Local Rate**: Calls `fetchLocalRate(fiat)`
     - Queries Binance P2P for USDT/{fiat} (SELL type - selling USDT for fiat)
     - Returns rate (e.g., 129.50 means 1 USDT = 129.50 KES)
  3. **Calculate Conversion Path**:
     ```
     USD Amount: 1000
     ↓ (divide by USD/USDT rate)
     USDT Bought: 1000 / 1.000 = 1000 USDT
     ↓ (multiply by USDT/Local rate)
     Local Received: 1000 * 129.50 = 129,500 KES
     ```
  4. **Apply Fee**: Fetches arbitrage fee from config
     ```
     Customer Payout: 129,500 * (1 - 0.015) = 127,557.5 KES
     Profit: 129,500 - 127,557.5 = 1,942.5 KES
     ```
  5. Sets `validUntil` (10 minutes from now, matching schedule)
  6. Returns arbitrage data object

**2.3. Rate Fetching Functions**

**`fetchUSDRate()`**:
- Queries Binance P2P API for USD/USDT pair
- Trade type: `BUY` (buying USDT with USD)
- Returns first offer price as float

**`fetchLocalRate(fiat)`**:
- Queries Binance P2P API for USDT/{fiat} pair
- Trade type: `SELL` (selling USDT for local fiat)
- Returns first offer price as float

**2.4. Storage Function: `writeArbitrageAtomically(currencyPair, arbitrageData)`**
- Similar to `writeRatesAtomically()` but for arbitrage data
- **Firestore**: Writes to `p2pRates/arbitrage`
- **RTDB**: Writes to `wallet/rates/arbitrage/{currencyPair}`
- Converts Firestore Timestamp to milliseconds for RTDB

**2.5. Callable Function: `getArbitrageRates`**
- **Type**: Firebase Callable Function
- **Purpose**: On-demand arbitrage rate retrieval
- **Process**: Same caching logic as `getBinanceRates()`
  - Checks Firestore cache first
  - Validates currency pair and expiration
  - Fetches fresh if cache miss/expired

**2.6. Fee Configuration: `getArbitrageFee()`**
- Similar to `getServiceFee()` but reads `arbitrageFee` from config
- Default fallback: 1.5% (0.015)

#### Data Structures

**Firestore Document: `p2pRates/arbitrage`**
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
  "updatedAt": "2024-01-01T00:00:00Z"
}
```

**Realtime Database: `wallet/rates/arbitrage/{currencyPair}`**
```json
{
  "usdRate": 1.000,
  "localRate": 129.50,
  "usdAmount": 1000,
  "usdtBought": 1000,
  "localReceived": 129500,
  "customerPayout": 127557.5,
  "profit": 1942.5,
  "feePercentage": 1.5,
  "currencyPair": "USD/KES",
  "fiat": "KES",
  "updatedAt": 1704067200000,
  "validUntil": 1704067800000
}
```

---

### 3. Payment Webhook Handler

#### Overview
Handles POST webhook callbacks from IntaSend payment gateway when payments are completed. Verifies webhook signatures for security, then updates user wallet balances in both Realtime Database and Firestore.

#### Components

**3.1. HTTP Endpoint: `handleTopUpWebhook`**
- **Type**: HTTP Request Function
- **URL**: `https://{region}-{project-id}.cloudfunctions.net/handleTopUpWebhook`
- **Method**: POST only (returns 405 for other methods)
- **Security**: HMAC SHA-256 signature verification

**3.2. Request Flow**

1. **Method Validation**:
   - Checks if `req.method === "POST"`
   - Returns `405 Method Not Allowed` if not POST

2. **Secret Retrieval**: `getSecret()`
   - Reads from Firebase Functions config: `functions.config().intasend.secret`
   - Returns `null` if not configured
   - Returns `500 Configuration error` if secret missing

3. **Signature Verification**: `verifySignature(sharedSecret, req)`
   - **Process**:
     ```
     1. Extracts signature from header:
        req.get("x-intasend-signature") or req.get("X-IntaSend-Signature")
     
     2. Gets raw request body:
        req.rawBody || Buffer.from(JSON.stringify(req.body))
     
     3. Computes HMAC SHA-256:
        crypto.createHmac("sha256", sharedSecret)
              .update(rawBody)
              .digest("hex")
     
     4. Compares signatures using timing-safe comparison:
        crypto.timingSafeEqual(receivedBuffer, computedBuffer)
     ```
   - Returns `403 Forbidden` if signature invalid

4. **Event Filtering**:
   - Checks if `payload.event === "payment.completed"`
   - Returns `200 "Ignored"` for other events (prevents processing non-payment events)

5. **Data Extraction**:
   ```javascript
   paymentId = payload.data.payment_id
   amount = Number(payload.data.amount)
   currency = payload.data.currency || "KES"
   userId = payload.data.metadata.user_id
   completedAt = payload.data.completed_at
   ```

6. **Validation**:
   - Checks if `paymentId` and `userId` exist
   - Returns `400 Bad Request` if missing

7. **Payment Record Storage**:
   - Writes to Realtime Database: `payments/{paymentId}`
   - Stores full payment data + `user_id` + `processed_at` timestamp

8. **Wallet Balance Update (Realtime Database)**:
   - Reads current balance: `wallet/balance/{userId}`
   - Extracts `available` field (defaults to 0 if not exists)
   - Calculates new balance: `currentBalance + amount`
   - Updates wallet:
     ```json
     {
       "available": newBalance,
       "currency": currency,
       "lastUpdated": ISO timestamp
     }
     ```

9. **User Record Update (Firestore)**:
   - Updates `users/{userId}` document:
     - Increments `balance` field using `FieldValue.increment(amount)`
     - Sets `lastTopUp` timestamp from `completedAt`
   - Uses `merge: true` to preserve other fields

10. **Response**: Returns `200 "OK"` on success

**3.3. Security: Signature Verification**

The webhook uses **HMAC SHA-256** for signature verification:

```javascript
// IntaSend computes signature:
signature = HMAC-SHA256(webhook_secret, raw_request_body)

// Function verifies:
computed = HMAC-SHA256(shared_secret, req.rawBody)
if (computed === received_signature) {
  // Valid webhook
} else {
  // Reject with 403
}
```

**Why `timingSafeEqual()`?**
- Prevents timing attacks
- Compares buffers byte-by-byte in constant time
- Prevents attackers from inferring signature correctness from response time

**3.4. Data Flow**

```
IntaSend Payment Gateway
    │
    │ POST /handleTopUpWebhook
    │ Headers: x-intasend-signature: <hmac>
    │ Body: {event: "payment.completed", data: {...}}
    ▼
┌─────────────────────────┐
│ Signature Verification  │
└───────────┬─────────────┘
            │ (valid)
            ▼
┌─────────────────────────┐
│ Extract Payment Data    │
│ • payment_id            │
│ • amount                │
│ • user_id               │
└───────────┬─────────────┘
            │
    ┌───────┴───────┐
    │               │
    ▼               ▼
┌─────────┐   ┌──────────────┐
│ RTDB    │   │  Firestore   │
│         │   │              │
│ payments│   │ users/{id}   │
│ /{id}   │   │ • balance++  │
│         │   │ • lastTopUp  │
│ wallet/ │   │              │
│ balance │   │              │
│ /{id}   │   │              │
│ • avail │   │              │
│   +=amt │   │              │
└─────────┘   └──────────────┘
```

#### Data Structures

**Webhook Payload (from IntaSend)**:
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

**Realtime Database: `payments/{paymentId}`**
```json
{
  "payment_id": "pay_abc123",
  "amount": 1000,
  "currency": "KES",
  "completed_at": "2024-01-01T00:00:00Z",
  "user_id": "user_xyz789",
  "processed_at": "2024-01-01T00:00:01Z",
  "metadata": {
    "user_id": "user_xyz789"
  }
}
```

**Realtime Database: `wallet/balance/{userId}`**
```json
{
  "available": 5000,
  "currency": "KES",
  "lastUpdated": "2024-01-01T00:00:01Z"
}
```

**Firestore: `users/{userId}`**
```json
{
  "balance": 5000,
  "lastTopUp": "2024-01-01T00:00:00Z"
}
```

---

## Data Flow

### Rate Fetching Flow

```
┌─────────────────┐
│ Cloud Scheduler  │ (cron: 0 0 * * *)
└────────┬─────────┘
         │
         ▼
┌─────────────────────────┐
│ fetchBinanceRates()     │
│ • Reset fee cache       │
│ • Loop currency pairs   │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│ fetchBinanceRateData()  │
│ • Call Binance API      │
│ • Get market price      │
│ • Apply service fee     │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│ writeRatesAtomically()  │
│ • Write to Firestore    │
│ • Write to RTDB         │
└────────┬────────────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌────────┐ ┌──────────┐
│Firestore│ │  RTDB    │
│p2pRates │ │wallet/   │
│/binance │ │rates/... │
└────────┘ └──────────┘
```

### On-Demand Rate Retrieval Flow

```
┌──────────────┐
│ Client App   │
└──────┬───────┘
       │
       │ Call getBinanceRates({fiat: "KES"})
       ▼
┌─────────────────────────┐
│ getBinanceRates()       │
│ • Check Firestore cache │
└────────┬────────────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
┌────────┐ ┌──────────────────┐
│ Valid? │ │ Expired/Missing?  │
│ YES    │ │ YES               │
└───┬────┘ └────────┬───────────┘
    │               │
    │               ▼
    │      ┌────────────────────┐
    │      │ fetchBinanceRate   │
    │      │ Data()             │
    │      │ • Call Binance API │
    │      └────────┬───────────┘
    │               │
    │               ▼
    │      ┌────────────────────┐
    │      │ writeRatesAtomically│
    │      └────────┬───────────┘
    │               │
    └───────────────┘
            │
            ▼
    ┌───────────────┐
    │ Return Data   │
    │ source: cache │
    │   or fresh    │
    └───────────────┘
```

### Payment Webhook Flow

```
┌──────────────┐
│  IntaSend    │
│  Gateway     │
└──────┬───────┘
       │
       │ POST /handleTopUpWebhook
       │ x-intasend-signature: <hmac>
       ▼
┌─────────────────────────┐
│ Verify Signature        │
└────────┬────────────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
┌──────┐  ┌──────────┐
│Valid │  │ Invalid  │
│      │  │ → 403    │
└──┬───┘  └──────────┘
   │
   ▼
┌─────────────────────────┐
│ Extract Payment Data   │
│ • payment_id           │
│ • amount               │
│ • user_id              │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│ Update Databases        │
│                         │
│ 1. RTDB: payments/{id}  │
│ 2. RTDB: wallet/balance │
│    /{userId}            │
│ 3. Firestore: users/    │
│    {userId}             │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│ Return 200 OK           │
└─────────────────────────┘
```

---

## API Reference

### 1. Callable Function: `getBinanceRates`

**Type**: Firebase Callable Function  
**Authentication**: Required (Firebase Auth)

**Request**:
```javascript
const functions = require('firebase-functions');
const { getFunctions, httpsCallable } = require('firebase/functions');

const functionsRef = getFunctions();
const getBinanceRates = httpsCallable(functionsRef, 'getBinanceRates');

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

**Error**: Throws `HttpsError` with code `internal` if fetch fails

---

### 2. HTTP Endpoint: `fetchBinanceRatesHttp`

**Type**: HTTP Request Function  
**URL**: `https://{region}-{project-id}.cloudfunctions.net/fetchBinanceRatesHttp`  
**CORS**: Enabled

**Request**:
```bash
# GET request
curl "https://us-central1-truepay-72060.cloudfunctions.net/fetchBinanceRatesHttp?fiat=KES&asset=USDT"

# POST request
curl -X POST "https://us-central1-truepay-72060.cloudfunctions.net/fetchBinanceRatesHttp" \
  -H "Content-Type: application/json" \
  -d '{"fiat": "KES", "asset": "USDT"}'
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
  "source": "firestore"
}
```

**Error Response** (500):
```json
{
  "error": "internal",
  "message": "Failed to fetch rates: <error message>"
}
```

---

### 3. Callable Function: `getArbitrageRates`

**Type**: Firebase Callable Function  
**Authentication**: Required

**Request**:
```javascript
const getArbitrageRates = httpsCallable(functionsRef, 'getArbitrageRates');

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

### 4. HTTP Endpoint: `handleTopUpWebhook`

**Type**: HTTP Request Function  
**URL**: `https://{region}-{project-id}.cloudfunctions.net/handleTopUpWebhook`  
**Method**: POST only

**Request**:
```bash
curl -X POST "https://us-central1-truepay-72060.cloudfunctions.net/handleTopUpWebhook" \
  -H "Content-Type: application/json" \
  -H "x-intasend-signature: <hmac_sha256_signature>" \
  -d '{
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
  }'
```

**Response**:
- `200 OK`: Payment processed successfully
- `400 Bad Request`: Missing payment_id or user_id
- `403 Forbidden`: Invalid signature
- `405 Method Not Allowed`: Not a POST request
- `500 Configuration error`: Webhook secret not configured

---

## Configuration

### Firebase Functions Config

Set the IntaSend webhook secret:
```bash
firebase functions:config:set intasend.secret="your-webhook-secret-here"
```

View current config:
```bash
firebase functions:config:get
```

### Firestore Configuration

Create a document at `config/fees`:

```json
{
  "serviceFee": 1.5,      // Service fee percentage (default: 1.5%)
  "arbitrageFee": 1.5     // Arbitrage fee percentage (default: 1.5%)
}
```

**Note**: Fees are stored as percentages (e.g., 1.5 for 1.5%), but converted to decimals (0.015) in code.

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
- **Secret Storage**: Firebase Functions config (encrypted at rest)
- **Comparison**: Timing-safe comparison to prevent timing attacks

### 2. Firebase Authentication

Callable functions (`getBinanceRates`, `getArbitrageRates`) require Firebase Authentication. Clients must be authenticated to call these functions.

### 3. CORS Configuration

HTTP endpoints (`fetchBinanceRatesHttp`) have CORS enabled with:
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET, POST, OPTIONS`
- `Access-Control-Allow-Headers: Content-Type, Authorization`

### 4. Input Validation

- Webhook handler validates required fields (`payment_id`, `user_id`)
- Rate functions validate currency codes and amounts
- All numeric inputs are parsed and validated

### 5. Error Handling

- Functions return appropriate HTTP status codes
- Sensitive error details are not exposed to clients
- Errors are logged with structured JSON for monitoring

---

## Error Handling

### Scheduled Functions

- **Error Strategy**: Return `null` to prevent retry loops
- **Logging**: Structured JSON logs for each currency pair
- **Batch Processing**: Continues processing other pairs if one fails
- **Summary Logs**: Emits batch completion summary with success/failure counts

### Callable Functions

- **Error Type**: Throws `HttpsError` with code `internal`
- **Error Message**: Includes descriptive error message
- **Client Handling**: Clients receive error with code and message

### HTTP Endpoints

- **Status Codes**:
  - `200`: Success
  - `400`: Bad Request (missing required fields)
  - `403`: Forbidden (invalid signature)
  - `405`: Method Not Allowed
  - `500`: Internal Server Error
- **Error Response Format**:
  ```json
  {
    "error": "internal",
    "message": "Failed to fetch rates: <details>"
  }
  ```

### Webhook Handler

- **Signature Failure**: Returns `403 Forbidden` (does not log signature details)
- **Missing Config**: Returns `500 Configuration error`
- **Invalid Event**: Returns `200 "Ignored"` (non-fatal)
- **Missing Data**: Returns `400 Bad Request`
- **Database Errors**: Logged but not exposed to client

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

3. **Set Configuration**:
   ```bash
   firebase functions:config:set intasend.secret="your-secret"
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
const functions = require('firebase-functions');
const { getFunctions, httpsCallable } = require('firebase/functions');

const functionsRef = getFunctions();
const getBinanceRates = httpsCallable(functionsRef, 'getBinanceRates');
const result = await getBinanceRates({ fiat: 'KES' });
```

**Test HTTP Endpoints**:
```bash
# Local emulator URL
curl "http://localhost:5001/truepay-72060/us-central1/fetchBinanceRatesHttp?fiat=KES"
```

**Test Webhook** (requires ngrok for local testing):
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
```

### Environment Variables

After deployment, set configuration:
```bash
firebase functions:config:set intasend.secret="production-secret"
```

**Note**: Configuration changes require function redeployment to take effect.

### Function URLs

After deployment, function URLs are available in:
- Firebase Console → Functions
- Or via CLI: `firebase functions:list`

**Example URLs**:
- `https://us-central1-truepay-72060.cloudfunctions.net/fetchBinanceRatesHttp`
- `https://us-central1-truepay-72060.cloudfunctions.net/handleTopUpWebhook`

---

## Testing

### Test Rate Fetching

```bash
# Test HTTP endpoint
curl "https://us-central1-truepay-72060.cloudfunctions.net/fetchBinanceRatesHttp?fiat=KES"

# Expected: JSON response with rate data
```

### Test Webhook (with valid signature)

```bash
# Generate signature (example - use actual secret)
SECRET="your-secret"
BODY='{"event":"payment.completed","data":{"payment_id":"test_123","amount":1000,"currency":"KES","metadata":{"user_id":"test_user"}}}'
SIGNATURE=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | cut -d' ' -f2)

curl -X POST "https://us-central1-truepay-72060.cloudfunctions.net/handleTopUpWebhook" \
  -H "Content-Type: application/json" \
  -H "x-intasend-signature: $SIGNATURE" \
  -d "$BODY"
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

### Verify Database Updates

After webhook call, verify:
1. **Realtime Database**: `payments/{paymentId}` exists
2. **Realtime Database**: `wallet/balance/{userId}` updated
3. **Firestore**: `users/{userId}` balance incremented

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

- Errors are logged with `event: "rates_update_failed"` or `event: "arbitrage_update_failed"`
- Batch completion logs include success/failure counts
- Webhook errors are logged with descriptive messages

---

## Dependencies

- **firebase-admin**: ^13.6.0 - Firebase Admin SDK for server-side operations
- **firebase-functions**: ^7.0.0 - Firebase Cloud Functions runtime
- **axios**: ^1.12.2 - HTTP client for Binance API requests
- **node-cron**: ^4.2.1 - Cron scheduling (used by Firebase Scheduler)

---

## License

Private - All rights reserved
