# Backend Implementation Guide

Complete guide for implementing REST API endpoints for the TruePay admin dashboard.

## Table of Contents

1. [Overview](#overview)
2. [API Structure](#api-structure)
3. [Required Endpoints](#required-endpoints)
4. [Implementation Details](#implementation-details)
5. [Environment Configuration](#environment-configuration)
6. [Testing](#testing)

---

## Overview

The frontend admin dashboard expects REST API endpoints at `/api/*` base path. This guide documents all required endpoints with request/response formats, authentication requirements, and error handling.

**Base URL Structure:**
- Development: `http://localhost:8080/api/...`
- Production: `https://{region}-{project-id}.cloudfunctions.net/api/...`

**Environment Variable:**
- Frontend uses `VITE_API_BASE_URL` (defaults to `http://localhost:8080`)
- Update for production when backend is deployed

---

## API Structure

### Current Implementation Status

✅ **Already Implemented:**
- Customer wallets endpoints (partially - need enhancements)
- Basic CRUD operations

❌ **Needs Implementation/Enhancement:**
- `/api/binance/rates` endpoint (currently at different path)
- Search, filter, pagination for customer wallets
- Transactions endpoint

---

## Required Endpoints

### 1. Binance Rates Endpoint

#### `GET /api/binance/rates`

Get Binance exchange rates for a currency pair.

**Query Parameters:**
```
?fiat=KES&asset=USDT
```

**Parameters:**
- `fiat` (optional, default: "KES") - Fiat currency code
- `asset` (optional, default: "USDT") - Crypto asset code

**Authentication:** Not required (public endpoint)

**Request Example:**
```http
GET /api/binance/rates?fiat=KES&asset=USDT
```

**Response (200 OK):**
```json
{
  "marketPrice": 129.50,
  "customerPrice": 131.44,
  "feePercentage": 1.5,
  "currencyPair": "USDT/KES",
  "asset": "USDT",
  "fiat": "KES",
  "validUntil": 1764807005227,
  "updatedAt": 1764806405463,
  "source": "firestore"
}
```

**Response Fields:**
- `marketPrice` (number) - Market rate from Binance
- `customerPrice` (number) - Price with service fee applied
- `feePercentage` (number) - Service fee percentage
- `currencyPair` (string) - Currency pair identifier
- `asset` (string) - Crypto asset code
- `fiat` (string) - Fiat currency code
- `validUntil` (number) - Timestamp when rate expires (milliseconds)
- `updatedAt` (number) - Last update timestamp (milliseconds)
- `source` (string) - Data source: "firestore" or "fresh"

**Error Responses:**
- `400 Bad Request` - Invalid parameters
- `500 Internal Server Error` - Failed to fetch rates

**Error Response Format:**
```json
{
  "error": "internal",
  "message": "Failed to fetch rates: No Binance offers found for USDT/KES"
}
```

**Implementation Notes:**
- Use existing `getBinanceRatesLogic` function from `functions/rates.js`
- Cache rates in Firestore for 5 minutes
- Fallback to fresh fetch if cache expired

---

### 2. Customer Wallet Endpoints

#### `GET /api/customer-wallets`

List all customer wallets with search, filter, and pagination.

**Query Parameters:**
```
?limit=50&offset=0&search=john&status=active&sortBy=createdAt&sortOrder=desc
```

**Parameters:**
- `limit` (optional, default: 100, max: 500) - Number of results per page
- `offset` (optional, default: 0) - Number of results to skip
- `search` (optional) - Search term (searches name, email, phone)
- `status` (optional) - Filter by status ("active", "inactive", etc.)
- `sortBy` (optional, default: "createdAt") - Field to sort by
- `sortOrder` (optional, default: "desc") - Sort order ("asc" or "desc")

**Authentication:** Required (Admin only)

**Request Headers:**
```
Authorization: Bearer {firebase-auth-token}
```

**Request Example:**
```http
GET /api/customer-wallets?limit=50&offset=0&search=john&status=active
Authorization: Bearer eyJhbGciOiJSUzI1NiIs...
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": [
    {
      "id": "82XqLAxq2udeYzrR89tvrEbYXbB2",
      "customerId": "82XqLAxq2udeYzrR89tvrEbYXbB2",
      "firstName": "John",
      "lastName": "Doe",
      "email": "john.doe@example.com",
      "phone": "+254712345678",
      "cryptoBalance": 0,
      "fiatBalance": 110,
      "status": "Active",
      "country": "KE",
      "kycStatus": "approved",
      "createdAt": "2025-01-01T00:00:00.000Z",
      "updatedAt": "2025-01-01T12:00:00.000Z"
    }
  ],
  "pagination": {
    "total": 150,
    "limit": 50,
    "offset": 0,
    "hasMore": true,
    "totalPages": 3,
    "currentPage": 1
  },
  "filters": {
    "applied": {
      "search": "john",
      "status": "active"
    }
  }
}
```

**Response Fields:**
- `data` (array) - Array of customer wallet objects
- `pagination` (object) - Pagination metadata
  - `total` (number) - Total number of results
  - `limit` (number) - Results per page
  - `offset` (number) - Current offset
  - `hasMore` (boolean) - Whether there are more results
  - `totalPages` (number) - Total number of pages
  - `currentPage` (number) - Current page number
- `filters` (object) - Applied filter information

**Error Responses:**
- `401 Unauthorized` - Not authenticated
- `403 Forbidden` - Not an admin user
- `500 Internal Server Error` - Server error

**Implementation Notes:**
- Read from `/users` collection (new architecture) and `/customerWallets` (legacy)
- Support case-insensitive search across name, email, phone
- Filter by status field
- Sort by createdAt, updatedAt, firstName, lastName, email
- Verify admin role before returning data

---

#### `GET /api/customer-wallets/:id`

Get a specific customer wallet by ID.

**URL Parameters:**
- `id` (required) - Customer wallet ID (Firebase UID)

**Authentication:** Required (Admin only)

**Request Example:**
```http
GET /api/customer-wallets/82XqLAxq2udeYzrR89tvrEbYXbB2
Authorization: Bearer {token}
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "id": "82XqLAxq2udeYzrR89tvrEbYXbB2",
    "customerId": "82XqLAxq2udeYzrR89tvrEbYXbB2",
    "firstName": "John",
    "lastName": "Doe",
    "email": "john.doe@example.com",
    "phone": "+254712345678",
    "cryptoBalance": 0,
    "fiatBalance": 110,
    "status": "Active",
    "country": "KE",
    "kycStatus": "approved",
    "kycData": {},
    "createdAt": "2025-01-01T00:00:00.000Z",
    "updatedAt": "2025-01-01T12:00:00.000Z"
  }
}
```

**Error Responses:**
- `401 Unauthorized` - Not authenticated
- `403 Forbidden` - Not an admin user
- `404 Not Found` - Wallet not found
- `500 Internal Server Error` - Server error

---

#### `POST /api/customer-wallets`

Create a new customer wallet.

**Authentication:** Required (Admin only)

**Request Body:**
```json
{
  "name": "John Doe",
  "email": "john.doe@example.com",
  "phone": "+254712345678",
  "initialBalance": 0,
  "country": "KE"
}
```

**Request Fields:**
- `name` (required, string) - Customer full name
- `email` (required, string) - Customer email (must be unique)
- `phone` (optional, string) - Customer phone number
- `initialBalance` (optional, number, default: 0) - Initial wallet balance
- `country` (optional, string) - Country code

**Response (201 Created):**
```json
{
  "success": true,
  "data": {
    "id": "new-wallet-id",
    "customerId": "new-wallet-id",
    "firstName": "John",
    "lastName": "Doe",
    "email": "john.doe@example.com",
    "phone": "+254712345678",
    "cryptoBalance": 0,
    "fiatBalance": 0,
    "status": "active",
    "createdAt": "2025-01-01T00:00:00.000Z",
    "updatedAt": "2025-01-01T00:00:00.000Z"
  }
}
```

**Error Responses:**
- `400 Bad Request` - Missing required fields or invalid data
- `409 Conflict` - Email already exists
- `401 Unauthorized` - Not authenticated
- `403 Forbidden` - Not an admin user

---

#### `PUT /api/customer-wallets/:id`

Update customer wallet details.

**URL Parameters:**
- `id` (required) - Customer wallet ID

**Authentication:** Required (Admin only)

**Request Body:**
```json
{
  "firstName": "John",
  "lastName": "Doe Updated",
  "email": "john.doe.updated@example.com",
  "phone": "+254712345679",
  "status": "active",
  "country": "KE"
}
```

**Request Fields:** (all optional)
- `firstName` (string)
- `lastName` (string)
- `name` (string) - Will be split into firstName/lastName
- `email` (string)
- `phone` (string)
- `status` (string)
- `country` (string)

**Note:** Cannot update balance directly - use credit/debit endpoints

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "id": "82XqLAxq2udeYzrR89tvrEbYXbB2",
    "customerId": "82XqLAxq2udeYzrR89tvrEbYXbB2",
    "firstName": "John",
    "lastName": "Doe Updated",
    "email": "john.doe.updated@example.com",
    "phone": "+254712345679",
    "cryptoBalance": 0,
    "fiatBalance": 110,
    "status": "active",
    "country": "KE",
    "createdAt": "2025-01-01T00:00:00.000Z",
    "updatedAt": "2025-01-01T13:00:00.000Z"
  }
}
```

**Error Responses:**
- `400 Bad Request` - Invalid data
- `401 Unauthorized` - Not authenticated
- `403 Forbidden` - Not an admin user
- `404 Not Found` - Wallet not found

---

#### `POST /api/customer-wallets/:id/credit`

Credit money to a customer wallet.

**URL Parameters:**
- `id` (required) - Customer wallet ID

**Authentication:** Required (Admin only)

**Request Body:**
```json
{
  "amount": 100,
  "description": "Admin credit for promotional offer"
}
```

**Request Fields:**
- `amount` (required, number) - Amount to credit (must be positive)
- `description` (optional, string) - Transaction description

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "id": "82XqLAxq2udeYzrR89tvrEbYXbB2",
    "customerId": "82XqLAxq2udeYzrR89tvrEbYXbB2",
    "firstName": "John",
    "lastName": "Doe",
    "email": "john.doe@example.com",
    "phone": "+254712345678",
    "cryptoBalance": 0,
    "fiatBalance": 210,
    "status": "Active"
  },
  "transaction": {
    "type": "credit",
    "amount": 100,
    "previousBalance": 110,
    "newBalance": 210,
    "transactionId": "txn_1234567890",
    "description": "Admin credit for promotional offer",
    "createdAt": "2025-01-01T13:00:00.000Z"
  }
}
```

**Error Responses:**
- `400 Bad Request` - Invalid amount (not a number, negative, or zero)
- `401 Unauthorized` - Not authenticated
- `403 Forbidden` - Not an admin user
- `404 Not Found` - Wallet not found
- `500 Internal Server Error` - Failed to credit wallet

---

#### `POST /api/customer-wallets/:id/debit`

Debit money from a customer wallet.

**URL Parameters:**
- `id` (required) - Customer wallet ID

**Authentication:** Required (Admin only)

**Request Body:**
```json
{
  "amount": 50,
  "description": "Payment for services"
}
```

**Request Fields:**
- `amount` (required, number) - Amount to debit (must be positive)
- `description` (optional, string) - Transaction description

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "id": "82XqLAxq2udeYzrR89tvrEbYXbB2",
    "customerId": "82XqLAxq2udeYzrR89tvrEbYXbB2",
    "firstName": "John",
    "lastName": "Doe",
    "email": "john.doe@example.com",
    "phone": "+254712345678",
    "cryptoBalance": 0,
    "fiatBalance": 160,
    "status": "Active"
  },
  "transaction": {
    "type": "debit",
    "amount": 50,
    "previousBalance": 210,
    "newBalance": 160,
    "transactionId": "txn_1234567891",
    "description": "Payment for services",
    "createdAt": "2025-01-01T13:05:00.000Z"
  }
}
```

**Error Responses:**
- `400 Bad Request` - Invalid amount or insufficient balance
- `401 Unauthorized` - Not authenticated
- `403 Forbidden` - Not an admin user
- `404 Not Found` - Wallet not found
- `500 Internal Server Error` - Failed to debit wallet

**Insufficient Balance Response (400):**
```json
{
  "success": false,
  "error": "Insufficient balance",
  "currentBalance": 50,
  "requestedAmount": 100
}
```

---

#### `GET /api/customer-wallets/:id/transactions`

Get transaction history for a customer wallet.

**URL Parameters:**
- `id` (required) - Customer wallet ID

**Query Parameters:**
```
?limit=50&offset=0&type=credit&startDate=2025-01-01&endDate=2025-01-31
```

**Parameters:**
- `limit` (optional, default: 50, max: 500) - Number of results per page
- `offset` (optional, default: 0) - Number of results to skip
- `type` (optional) - Filter by transaction type ("credit", "debit", "topup")
- `startDate` (optional) - Start date filter (ISO 8601 format)
- `endDate` (optional) - End date filter (ISO 8601 format)

**Authentication:** Required (Admin only)

**Request Example:**
```http
GET /api/customer-wallets/82XqLAxq2udeYzrR89tvrEbYXbB2/transactions?limit=50&type=credit
Authorization: Bearer {token}
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": [
    {
      "transactionId": "txn_1234567890",
      "walletId": "82XqLAxq2udeYzrR89tvrEbYXbB2",
      "type": "credit",
      "amount": 100,
      "previousBalance": 110,
      "newBalance": 210,
      "description": "Admin credit for promotional offer",
      "status": "completed",
      "currency": "USD",
      "metadata": {
        "source": "admin_api",
        "adminId": "admin-user-id"
      },
      "createdAt": "2025-01-01T13:00:00.000Z",
      "updatedAt": "2025-01-01T13:00:00.000Z"
    },
    {
      "transactionId": "txn_1234567891",
      "walletId": "82XqLAxq2udeYzrR89tvrEbYXbB2",
      "type": "debit",
      "amount": 50,
      "previousBalance": 210,
      "newBalance": 160,
      "description": "Payment for services",
      "status": "completed",
      "currency": "USD",
      "metadata": {
        "source": "admin_api",
        "adminId": "admin-user-id"
      },
      "createdAt": "2025-01-01T13:05:00.000Z",
      "updatedAt": "2025-01-01T13:05:00.000Z"
    }
  ],
  "pagination": {
    "total": 25,
    "limit": 50,
    "offset": 0,
    "hasMore": false,
    "totalPages": 1,
    "currentPage": 1
  }
}
```

**Response Fields:**
- `data` (array) - Array of transaction objects
- `pagination` (object) - Pagination metadata

**Transaction Object Fields:**
- `transactionId` (string) - Unique transaction ID
- `walletId` (string) - Customer wallet ID
- `type` (string) - Transaction type ("credit", "debit", "topup")
- `amount` (number) - Transaction amount
- `previousBalance` (number) - Balance before transaction
- `newBalance` (number) - Balance after transaction
- `description` (string) - Transaction description
- `status` (string) - Transaction status ("completed", "pending", "failed")
- `currency` (string) - Currency code (e.g., "USD", "KES")
- `metadata` (object) - Additional transaction metadata
- `createdAt` (string) - Transaction creation timestamp (ISO 8601)
- `updatedAt` (string) - Last update timestamp (ISO 8601)

**Error Responses:**
- `401 Unauthorized` - Not authenticated
- `403 Forbidden` - Not an admin user
- `404 Not Found` - Wallet not found
- `500 Internal Server Error` - Server error

**Implementation Notes:**
- Read from `transactions` collection in Firestore
- Filter by `walletId` (or `userId`)
- Sort by `createdAt` descending (newest first)
- Support date range filtering
- Support transaction type filtering

---

## Implementation Details

### Current Status

✅ **Already Implemented:**
- Most customer wallet endpoints exist in `functions/customerWallets.js`
- Endpoints are accessible via `/api/customer-wallets/*`

❌ **Needs Implementation/Enhancement:**

1. **Binance Rates Endpoint:**
   - Currently at `/fetchBinanceRatesHttp` (different path)
   - Need to add `/api/binance/rates` endpoint
   - Can reuse existing `getBinanceRatesLogic` function

2. **Search, Filter, Pagination:**
   - Customer wallets list endpoint needs enhancements
   - Add search functionality (name, email, phone)
   - Add status filtering
   - Add sorting options
   - Improve pagination response

3. **Transactions Endpoint:**
   - Need to implement `GET /api/customer-wallets/:id/transactions`
   - Read from Firestore `transactions` collection
   - Support filtering and pagination

### File Locations

- **Customer Wallets API**: `functions/customerWallets.js`
- **Rates Logic**: `functions/rates.js`
- **Transaction Utilities**: `functions/utils/transactions.js`

### Code Structure

The API is implemented using Express.js and exported as a Firebase Cloud Function:

```javascript
// functions/customerWallets.js
const express = require("express");
const app = express();

// Middleware and routes...

exports.api = onRequest(app);
```

This creates endpoints at: `https://{region}-{project-id}.cloudfunctions.net/api/*`

---

## Required Changes

### 1. Add Binance Rates Endpoint

Add to `functions/customerWallets.js` or create new route file:

```javascript
// Add to existing Express app in customerWallets.js
app.get("/binance/rates", async (req, res) => {
  try {
    const { getBinanceRatesLogic } = require("./rates");
    const fiat = req.query.fiat || "KES";
    const asset = req.query.asset || "USDT";
    
    const result = await getBinanceRatesLogic(fiat, asset);
    
    // Convert Firestore Timestamps to milliseconds
    const response = {
      ...result,
      validUntil: result.validUntil?.toMillis?.() || Date.now() + 300000,
      updatedAt: result.updatedAt?.toMillis?.() || Date.now(),
    };
    
    res.status(200).json(response);
  } catch (err) {
    res.status(500).json({
      error: "internal",
      message: `Failed to fetch rates: ${err.message}`,
    });
  }
});
```

### 2. Enhance Customer Wallets List Endpoint

Update `GET /customer-wallets` endpoint in `functions/customerWallets.js`:

- Add search functionality (case-insensitive)
- Add status filtering
- Add sorting options
- Improve pagination response format

### 3. Add Transactions Endpoint

Add new endpoint to `functions/customerWallets.js`:

```javascript
app.get("/customer-wallets/:id/transactions", async (req, res) => {
  // Implementation for transactions endpoint
  // Read from Firestore transactions collection
  // Support filtering and pagination
});
```

---

## Authentication

### Admin Verification

All customer wallet endpoints require admin authentication. Verify admin role:

```javascript
async function verifyAdmin(uid) {
  const userDoc = await db.collection("users").doc(uid).get();
  if (!userDoc.exists) return false;
  const userData = userDoc.data();
  return userData.isAdmin === true;
}

// Extract user from Firebase Auth token
const authHeader = req.headers.authorization;
if (!authHeader || !authHeader.startsWith("Bearer ")) {
  return res.status(401).json({ error: "Unauthorized" });
}

const token = authHeader.split("Bearer ")[1];
const decodedToken = await admin.auth().verifyIdToken(token);
const isAdmin = await verifyAdmin(decodedToken.uid);

if (!isAdmin) {
  return res.status(403).json({ error: "Forbidden: Admin access required" });
}
```

---

## Environment Configuration

### Frontend Environment Variable

The frontend uses `VITE_API_BASE_URL` environment variable:

**Development:**
```env
VITE_API_BASE_URL=http://localhost:8080
```

**Production:**
```env
VITE_API_BASE_URL=https://us-central1-truepay-72060.cloudfunctions.net
```

### Backend Configuration

No additional environment variables needed. Firebase Functions automatically handle:
- Project ID
- Region
- Authentication

---

## Error Handling

### Standard Error Response Format

All errors should follow this format:

```json
{
  "success": false,
  "error": "error-code",
  "message": "Human-readable error message",
  "details": {}  // Optional additional details
}
```

### HTTP Status Codes

- `200 OK` - Success
- `201 Created` - Resource created successfully
- `400 Bad Request` - Invalid request parameters
- `401 Unauthorized` - Not authenticated
- `403 Forbidden` - Insufficient permissions
- `404 Not Found` - Resource not found
- `409 Conflict` - Resource conflict (e.g., email exists)
- `500 Internal Server Error` - Server error

---

## Testing

### Local Testing

Test endpoints locally using Firebase Emulators:

```bash
# Start emulators
cd functions
npm run serve

# Test endpoints
curl "http://localhost:5001/truepay-72060/us-central1/api/binance/rates?fiat=KES"
```

### Production Testing

After deployment:

```bash
# Test Binance rates
curl "https://us-central1-truepay-72060.cloudfunctions.net/api/binance/rates?fiat=KES&asset=USDT"

# Test customer wallets (with auth token)
curl -H "Authorization: Bearer {token}" \
  "https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets"
```

---

## Deployment

See `DEPLOYMENT.md` for complete deployment guide.

**Quick Deploy:**
```bash
firebase deploy --only functions:api
```

---

## Summary Checklist

- [ ] Add `/api/binance/rates` endpoint
- [ ] Enhance customer wallets list with search/filter/pagination
- [ ] Add `/api/customer-wallets/:id/transactions` endpoint
- [ ] Verify all endpoints follow standard response format
- [ ] Implement proper admin authentication
- [ ] Test all endpoints locally
- [ ] Deploy to production
- [ ] Update frontend environment variable for production

---

**Last Updated**: 2025-01-04

