# Admin Dashboard API Endpoints

Complete list of all endpoints you should implement in your admin dashboard, organized by category.

## Table of Contents

- [Authentication](#authentication)
- [User Management](#user-management)
- [Customer Wallets](#customer-wallets)
- [Transaction History](#transaction-history)
- [Admin Logs](#admin-logs)
- [Rates & Arbitrage](#rates--arbitrage)
- [System Configuration](#system-configuration)
- [Migration & Utilities](#migration--utilities)

---

## Authentication

All admin endpoints require Firebase Authentication. The admin user must have `role: 'admin'` in their Firestore user document.

**Base URL for Callable Functions:**
```
https://us-central1-truepay-72060.cloudfunctions.net
```

**Base URL for HTTP REST API:**
```
https://us-central1-truepay-72060.cloudfunctions.net/api
```

---

## User Management

### 1. Get User Data

**Type:** Firebase Callable Function  
**Function Name:** `getUserData`  
**Authentication:** Required (Admin only)

**Request:**
```javascript
const { getFunctions, httpsCallable } = require('firebase/functions');
const functions = getFunctions();
const getUserData = httpsCallable(functions, 'getUserData');

const result = await getUserData({
  userId: 'user123'
});
```

**Response:**
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

**What it does:** Retrieves complete user data from Firestore. Use this to display user details in the admin dashboard.

---

### 2. Update User Profile

**Type:** Firebase Callable Function  
**Function Name:** `updateUserProfile`  
**Authentication:** Required (Admin only)

**Request:**
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

**Allowed Fields:**
- `name` (string)
- `email` (string)
- `country` (string)
- `phoneNumber` (string)
- `kycStatus` (string: "pending", "approved", "rejected", "under_review")
- `kycData` (object)

**Note:** Cannot update `balance` through this endpoint. Use `updateUserBalance` instead.

**Response:**
```json
{
  "success": true,
  "userId": "user123",
  "updatedFields": ["name", "email", "country"]
}
```

**What it does:** Updates user profile information. All changes are logged in the admin logs collection.

---

### 3. Update User Balance

**Type:** Firebase Callable Function  
**Function Name:** `updateUserBalance`  
**Authentication:** Required (Admin only)

**Request:**
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

**Response:**
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

**What it does:** 
- Updates user balance using Firestore transactions (prevents race conditions)
- Logs transaction to `/transactions/{userId}/transactions/{txId}`
- Syncs balance to Realtime Database automatically
- Logs admin action to `/adminLogs/{logId}`
- Admins can set negative balances if needed

---

### 4. Update KYC Status

**Type:** Firebase Callable Function  
**Function Name:** `updateKYCStatus`  
**Authentication:** Required (Admin only)

**Request:**
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

**Valid Statuses:**
- `pending`
- `approved`
- `rejected`
- `under_review`

**Response:**
```json
{
  "success": true,
  "userId": "user123",
  "kycStatus": "approved"
}
```

**What it does:** Updates user KYC verification status. All changes are logged in admin logs.

---

## Customer Wallets

These endpoints manage the legacy `customerWallets` collection. Use these if you're still using the old wallet system.

### 5. List All Customer Wallets

**Type:** HTTP REST API  
**Endpoint:** `GET /api/customer-wallets`  
**Authentication:** Not required (but should add admin auth)

**Request:**
```javascript
const response = await fetch(
  'https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets?limit=100&offset=0'
);
const data = await response.json();
```

**Query Parameters:**
- `limit` (optional, default: 100) - Number of records to return
- `offset` (optional, default: 0) - Number of records to skip

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "wallet123",
      "name": "John Doe",
      "email": "john@example.com",
      "phone": "+1234567890",
      "balance": 1000.50,
      "status": "active",
      "createdAt": "2024-01-01T00:00:00.000Z",
      "updatedAt": "2024-01-01T00:00:00.000Z"
    }
  ],
  "pagination": {
    "total": 50,
    "limit": 100,
    "offset": 0,
    "hasMore": false
  }
}
```

**What it does:** Retrieves paginated list of all customer wallets from the `customerWallets` collection.

---

### 6. Get Single Customer Wallet

**Type:** HTTP REST API  
**Endpoint:** `GET /api/customer-wallets/:id`  
**Authentication:** Not required (but should add admin auth)

**Request:**
```javascript
const response = await fetch(
  'https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets/wallet123'
);
const data = await response.json();
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "wallet123",
    "name": "John Doe",
    "email": "john@example.com",
    "phone": "+1234567890",
    "balance": 1000.50,
    "status": "active",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  }
}
```

**What it does:** Retrieves a single customer wallet by ID.

---

### 7. Create Customer Wallet

**Type:** HTTP REST API  
**Endpoint:** `POST /api/customer-wallets`  
**Authentication:** Not required (but should add admin auth)

**Request:**
```javascript
const response = await fetch(
  'https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'John Doe',
      email: 'john@example.com',
      phone: '+1234567890',
      initialBalance: 0
    })
  }
);
```

**Required Fields:**
- `name` (string)
- `email` (string)

**Optional Fields:**
- `phone` (string)
- `initialBalance` (number, default: 0)

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "wallet123",
    "name": "John Doe",
    "email": "john@example.com",
    "phone": "+1234567890",
    "balance": 0,
    "status": "active",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  }
}
```

**What it does:** Creates a new customer wallet in the `customerWallets` collection.

---

### 8. Update Customer Wallet

**Type:** HTTP REST API  
**Endpoint:** `PUT /api/customer-wallets/:id`  
**Authentication:** Not required (but should add admin auth)

**Request:**
```javascript
const response = await fetch(
  'https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets/wallet123',
  {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'John Updated',
      phone: '+9876543210',
      status: 'active'
    })
  }
);
```

**Note:** Cannot update `balance`, `id`, or `createdAt` through this endpoint. Use credit/debit endpoints for balance changes.

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "wallet123",
    "name": "John Updated",
    "email": "john@example.com",
    "phone": "+9876543210",
    "balance": 1000.50,
    "status": "active",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T01:00:00.000Z"
  }
}
```

**What it does:** Updates customer wallet details (except balance).

---

### 9. Credit Money to Wallet

**Type:** HTTP REST API  
**Endpoint:** `POST /api/customer-wallets/:id/credit`  
**Authentication:** Not required (but should add admin auth)

**Request:**
```javascript
const response = await fetch(
  'https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets/wallet123/credit',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: 100,
      description: 'Top up payment'
    })
  }
);
```

**Required Fields:**
- `amount` (number, must be > 0)

**Optional Fields:**
- `description` (string)

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "wallet123",
    "name": "John Doe",
    "email": "john@example.com",
    "balance": 1100.50,
    "status": "active"
  },
  "transaction": {
    "type": "credit",
    "amount": 100,
    "previousBalance": 1000.50,
    "newBalance": 1100.50
  }
}
```

**What it does:** Adds money to a customer wallet and logs the transaction to `walletTransactions` collection.

---

### 10. Debit Money from Wallet

**Type:** HTTP REST API  
**Endpoint:** `POST /api/customer-wallets/:id/debit`  
**Authentication:** Not required (but should add admin auth)

**Request:**
```javascript
const response = await fetch(
  'https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets/wallet123/debit',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: 50,
      description: 'Payment for service'
    })
  }
);
```

**Required Fields:**
- `amount` (number, must be > 0)

**Optional Fields:**
- `description` (string)

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "wallet123",
    "name": "John Doe",
    "email": "john@example.com",
    "balance": 1050.50,
    "status": "active"
  },
  "transaction": {
    "type": "debit",
    "amount": 50,
    "previousBalance": 1100.50,
    "newBalance": 1050.50
  }
}
```

**Error Response (Insufficient Balance):**
```json
{
  "success": false,
  "error": "Insufficient balance",
  "currentBalance": 100,
  "requestedAmount": 200
}
```

**What it does:** Subtracts money from a customer wallet and logs the transaction. Returns error if insufficient balance.

---

## Transaction History

### 11. Get User Transactions

**Type:** Direct Firestore Query (Implement in your dashboard)  
**Collection:** `transactions/{userId}/transactions`  
**Authentication:** Required (Admin only)

**Query Example:**
```javascript
// Using Firebase Admin SDK or Firestore client
const transactionsRef = firestore
  .collection('transactions')
  .doc(userId)
  .collection('transactions')
  .orderBy('timestamp', 'desc')
  .limit(50);

const snapshot = await transactionsRef.get();
const transactions = snapshot.docs.map(doc => ({
  id: doc.id,
  ...doc.data()
}));
```

**Transaction Document Structure:**
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

**Transaction Types:**
- `credit` - Money added
- `debit` - Money subtracted
- `transfer` - Money transferred between users
- `topup` - Top-up via payment gateway
- `withdrawal` - Withdrawal request
- `refund` - Refund issued

**What it does:** Retrieves transaction history for a specific user. All financial events are automatically logged here.

---

## Admin Logs

### 12. Get Admin Logs

**Type:** Direct Firestore Query (Implement in your dashboard)  
**Collection:** `adminLogs`  
**Authentication:** Required (Admin only)

**Query Example:**
```javascript
const adminLogsRef = firestore
  .collection('adminLogs')
  .orderBy('timestamp', 'desc')
  .limit(100);

const snapshot = await adminLogsRef.get();
const logs = snapshot.docs.map(doc => ({
  id: doc.id,
  ...doc.data()
}));
```

**Admin Log Document Structure:**
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

**Action Types:**
- `updateProfile` - User profile updated
- `updateBalance` - User balance updated
- `updateKYC` - KYC status updated

**What it does:** Retrieves audit log of all admin actions. Use this to track what admins have done in the system.

---

## Rates & Arbitrage

### 13. Get Binance Rates

**Type:** Firebase Callable Function  
**Function Name:** `getBinanceRates`  
**Authentication:** Required (Firebase Auth)

**Request:**
```javascript
const getBinanceRates = httpsCallable(functions, 'getBinanceRates');

const result = await getBinanceRates({
  fiat: 'KES',  // Optional, default: 'KES'
  asset: 'USDT' // Optional, default: 'USDT'
});
```

**Response:**
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

**What it does:** Retrieves current Binance P2P exchange rates with service fee applied.

---

### 14. Get Arbitrage Rates

**Type:** Firebase Callable Function  
**Function Name:** `getArbitrageRates`  
**Authentication:** Required (Firebase Auth)

**Request:**
```javascript
const getArbitrageRates = httpsCallable(functions, 'getArbitrageRates');

const result = await getArbitrageRates({
  fiat: 'KES'  // Optional, default: 'KES'
});
```

**Response:**
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

**What it does:** Retrieves arbitrage calculation for USD → USDT → Local Fiat conversion path.

---

## System Configuration

### 15. Get Fee Configuration

**Type:** Direct Firestore Query (Implement in your dashboard)  
**Collection:** `config`  
**Document:** `fees`  
**Authentication:** Required (Admin only)

**Query Example:**
```javascript
const feesDoc = await firestore.collection('config').doc('fees').get();
const fees = feesDoc.data();
```

**Document Structure:**
```json
{
  "serviceFee": 1.5,      // Service fee percentage (e.g., 1.5 = 1.5%)
  "arbitrageFee": 1.5     // Arbitrage fee percentage
}
```

**What it does:** Retrieves current fee configuration. Admins should be able to update this.

---

### 16. Update Fee Configuration

**Type:** Direct Firestore Write (Implement in your dashboard)  
**Collection:** `config`  
**Document:** `fees`  
**Authentication:** Required (Admin only)

**Update Example:**
```javascript
await firestore.collection('config').doc('fees').update({
  serviceFee: 2.0,      // Update to 2%
  arbitrageFee: 1.75    // Update to 1.75%
});
```

**What it does:** Updates fee configuration. Changes affect all future rate calculations.

---

## Migration & Utilities

### 17. Migrate Existing Users

**Type:** Firebase Callable Function  
**Function Name:** `migrateExistingUsers`  
**Authentication:** Required (Admin only)

**Request:**
```javascript
const migrateExistingUsers = httpsCallable(functions, 'migrateExistingUsers');

const result = await migrateExistingUsers({
  batchSize: 100,  // Optional, default: 100
  dryRun: false     // Optional, default: false
});
```

**What it does:** Migrates existing users to the new architecture (creates Firestore documents and Realtime DB balances).

---

### 18. Update Phone Numbers

**Type:** Firebase Callable Function  
**Function Name:** `updatePhoneNumbers`  
**Authentication:** Required (Admin only)

**Request:**
```javascript
const updatePhoneNumbers = httpsCallable(functions, 'updatePhoneNumbers');

const result = await updatePhoneNumbers({
  batchSize: 100,  // Optional, default: 100
  dryRun: false     // Optional, default: false
});
```

**What it does:** Updates phone number format across all users.

---

## Error Handling

All endpoints may return these error codes:

### Firebase Callable Functions Errors

- `unauthenticated` - User not authenticated
- `permission-denied` - User is not an admin
- `invalid-argument` - Invalid request parameters
- `not-found` - Resource not found
- `internal` - Internal server error

### HTTP REST API Errors

- `400 Bad Request` - Invalid request parameters
- `404 Not Found` - Resource not found
- `409 Conflict` - Resource conflict (e.g., duplicate email)
- `500 Internal Server Error` - Server error

---

## Implementation Checklist

### User Management
- [ ] Get User Data endpoint
- [ ] Update User Profile endpoint
- [ ] Update User Balance endpoint
- [ ] Update KYC Status endpoint
- [ ] User search/filter functionality
- [ ] User list with pagination

### Customer Wallets (Legacy)
- [ ] List Customer Wallets endpoint
- [ ] Get Single Customer Wallet endpoint
- [ ] Create Customer Wallet endpoint
- [ ] Update Customer Wallet endpoint
- [ ] Credit Wallet endpoint
- [ ] Debit Wallet endpoint

### Transaction History
- [ ] Get User Transactions endpoint
- [ ] Transaction list with filters (type, date range, amount)
- [ ] Transaction details view
- [ ] Export transactions to CSV

### Admin Logs
- [ ] Get Admin Logs endpoint
- [ ] Filter logs by admin, user, action type
- [ ] Admin activity timeline view

### Rates & Configuration
- [ ] Get Binance Rates endpoint
- [ ] Get Arbitrage Rates endpoint
- [ ] View Fee Configuration
- [ ] Update Fee Configuration endpoint

### Dashboard Features
- [ ] Admin authentication
- [ ] Role-based access control
- [ ] Real-time balance updates (via Realtime DB)
- [ ] Statistics/analytics dashboard
- [ ] User activity monitoring

---

## Data Collections Reference

### Firestore Collections

- `/users/{userId}` - User documents (master balance source)
- `/transactions/{userId}/transactions/{txId}` - User transaction history
- `/adminLogs/{logId}` - Admin action audit logs
- `/customerWallets/{walletId}` - Legacy customer wallets
- `/walletTransactions/{txId}` - Legacy wallet transactions
- `/config/fees` - Fee configuration
- `/p2pRates/binance` - Binance P2P rates
- `/p2pRates/arbitrage` - Arbitrage rates

### Realtime Database Paths

- `/balances/{userId}/balance` - Cached user balance (read-only for clients)
- `/wallet/rates/binance/{currencyPair}` - Cached rates
- `/wallet/balance/{userId}` - Legacy wallet balance
- `/payments/{paymentId}` - Payment records

---

## Notes

1. **Authentication**: All admin endpoints require Firebase Authentication with admin role verification.

2. **Balance Updates**: Always use `updateUserBalance` callable function for balance changes. It ensures:
   - Transaction safety (prevents race conditions)
   - Automatic transaction logging
   - Realtime DB sync
   - Admin action logging

3. **Transaction Logging**: All balance changes are automatically logged. No manual logging needed.

4. **Realtime Updates**: User balances are synced to Realtime DB automatically. Use Realtime DB for instant UI updates.

5. **Legacy vs New System**: 
   - New system uses `/users/{userId}` with Firestore transactions
   - Legacy system uses `/customerWallets/{walletId}` with direct updates
   - Consider migrating to the new system for better transaction safety

6. **Admin Role**: Users must have `role: 'admin'` in their Firestore user document to access admin functions.

---

## Quick Reference

| Category | Endpoint Type | Count |
|----------|--------------|-------|
| User Management | Callable Functions | 4 |
| Customer Wallets | HTTP REST API | 6 |
| Transaction History | Firestore Query | 1 |
| Admin Logs | Firestore Query | 1 |
| Rates & Arbitrage | Callable Functions | 2 |
| System Configuration | Firestore Query/Write | 2 |
| Migration & Utilities | Callable Functions | 2 |
| **Total** | | **18** |

