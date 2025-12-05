# Database Layout

This document provides a comprehensive overview of the database structure for the Kalvo rates function application. The application uses both **Firestore** (NoSQL document database) and **Realtime Database** (real-time JSON database) on Firebase.

---

## Overview

- **Firestore**: Primary database for structured data, user profiles, transactions, and configuration
- **Realtime Database**: Used for real-time balance syncing, rates caching, and payment tracking (optimized for real-time client reads)

---

## Firestore Collections

### 1. `/users/{userId}`

**Description**: Main user profile collection. Document ID is the Firebase Auth UID.

**Schema**:
```typescript
{
  // Basic Information
  name: string | null                    // Display name
  email: string                          // User email
  phoneNumber: string | null             // Phone number (alias: phone)
  country: string | null                 // Country code
  
  // Financial
  balance: number                        // Primary balance (master source of truth)
  currency: string                       // Currency code (default: "USD")
  fiatCurrency: string | null            // Legacy field for fiat currency
  fiatBalance: number | null             // Legacy field for fiat balance
  cryptoBalance: number | null           // Crypto balance if applicable
  
  // KYC & Status
  kycStatus: string | null               // "pending" | "approved" | "rejected" | "under_review"
  kycData: object | null                 // Additional KYC information
  role: string | null                    // "admin" | null (regular user)
  status: string | null                  // Account status
  
  // Metadata
  createdAt: Timestamp                   // Account creation timestamp
  updatedAt: Timestamp                   // Last update timestamp
  lastTopUp: Timestamp | null            // Last top-up timestamp
}
```

**Security Rules**:
- Users can read their own document
- Users can update their own document EXCEPT `balance` field
- Admins can read/update all user documents
- Balance can only be modified server-side (Cloud Functions) or by admins

**Triggers**:
- `onUpdate`: Triggers `syncBalance` function to sync balance to Realtime Database

---

### 2. `/transactions/{userId}/transactions/{transactionId}`

**Description**: User transaction history as a subcollection under each user document.

**Schema**:
```typescript
{
  type: string                           // "credit" | "debit" | "topup" | "transfer" | etc.
  amount: number                         // Transaction amount (always positive)
  status: string                         // "completed" | "pending" | "failed"
  timestamp: Timestamp                   // Transaction timestamp
  previousBalance: number                // Balance before transaction
  newBalance: number                     // Balance after transaction
  userId: string                         // User ID (redundant but useful for queries)
  metadata: {
    amountDelta?: number                 // Positive (credit) or negative (debit)
    paymentId?: string                   // Payment provider ID
    currency?: string                    // Transaction currency
    completedAt?: string                 // ISO timestamp
    source?: string                      // "intasend" | "admin" | "admin_api"
    reason?: string                      // Admin reason for adjustment
    description?: string                 // Transaction description
    allowNegative?: boolean              // Whether negative balance was allowed
    [key: string]: any                   // Additional metadata
  }
}
```

**Transaction ID Format**: `tx_{timestamp}_{random}`

**Security Rules**:
- Users can read their own transactions
- Admins can read all transactions
- Only Cloud Functions can write transactions (server SDK bypasses rules)

---

### 3. `/adminLogs/{logId}`

**Description**: Audit log for admin actions.

**Schema**:
```typescript
{
  adminId: string                        // Admin user ID who performed action
  userId: string | null                  // Target user ID (if applicable)
  action: string                         // "updateBalance" | "updateProfile" | "updateKYC"
  before: object                         // State before action
  after: object                          // State after action
  timestamp: Timestamp                   // Action timestamp
}
```

**Log ID Format**: `admin_{timestamp}_{random}`

**Security Rules**:
- Only admins can read admin logs
- Only Cloud Functions can write admin logs

---

### 4. `/p2pRates/{documentId}`

**Description**: P2P exchange rates from Binance. Currently stores two document types: `binance` and `arbitrage`.

**Documents**:
- `/p2pRates/binance` - Binance P2P rates
- `/p2pRates/arbitrage` - Arbitrage rates

**Binance Rate Schema**:
```typescript
{
  marketPrice: number                    // Market price from Binance
  customerPrice: number                  // Price with service fee applied
  feePercentage: number                  // Service fee percentage (e.g., 1.5)
  currencyPair: string                   // "USDT/KES" | "USDT/NGN" | etc.
  asset: string                          // "USDT"
  fiat: string                           // "KES" | "NGN" | "GHS"
  validUntil: Timestamp                  // Rate expiration (5 minutes)
  updatedAt: Timestamp                   // Last update timestamp
}
```

**Arbitrage Rate Schema**:
```typescript
{
  usdRate: number                        // USD/USDT rate
  localRate: number                      // Local fiat/USDT rate
  usdAmount: number                      // Reference USD amount (default: 1000)
  usdtBought: number                     // USDT bought with USD
  localReceived: number                  // Local fiat received from USDT sale
  feePercentage: number                  // Arbitrage fee percentage
  customerPayout: number                 // Amount customer receives after fee
  profit: number                         // Platform profit
  currencyPair: string                   // "USD/KES" | "USD/NGN" | etc.
  fiat: string                           // "KES" | "NGN" | "GHS"
  validUntil: Timestamp                  // Rate expiration (10 minutes)
  updatedAt: Timestamp                   // Last update timestamp
}
```

**Security Rules**:
- Public read access
- Only admins can write rates

**Sync**: Rates are also written to Realtime Database at `/wallet/rates/{source}/{currencyPair}`

---

### 5. `/config/{documentId}`

**Description**: Application configuration settings.

**Documents**:
- `/config/fees` - Fee configuration

**Fees Config Schema**:
```typescript
{
  serviceFee: number                     // Service fee in basis points (e.g., 150 = 1.5%)
  arbitrageFee: number                   // Arbitrage fee in basis points
  [key: string]: any                     // Additional config fields
}
```

**Security Rules**:
- Public read access (for fee display)
- Only admins can write config

---

### 6. `/orders/{orderId}`

**Description**: Order records for top-ups and other transactions. Referenced by payment webhook handler.

**Schema** (inferred from payment handler):
```typescript
{
  userId: string                         // User ID who placed order
  orderType: string                      // "topup" | etc.
  status: string                         // "pending" | "completed" | "failed"
  amount: number                         // Order amount
  currency: string                       // Order currency
  invoiceId: string | null               // Payment provider invoice ID
  metadata: {
    paymentId?: string                   // Payment provider ID
    invoiceId?: string                   // Invoice ID
    [key: string]: any                   // Additional order metadata
  }
  createdAt: Timestamp
  updatedAt: Timestamp
}
```

**Note**: This collection is referenced in `payments.js` but structure may vary. Used to resolve user ID from invoice ID during webhook processing.

---

### 7. `/customerWallets/{walletId}` (Legacy)

**Description**: Legacy customer wallet collection. Being migrated to `/users` collection.

**Schema**:
```typescript
{
  firstName: string
  lastName: string
  email: string
  phone: string
  balance: number
  cryptoBalance: number
  fiatBalance: number
  status: string                         // "active" | "inactive"
  createdAt: Timestamp
  updatedAt: Timestamp
}
```

**Migration**: Legacy wallets are gradually being migrated to the new `/users` architecture.

---

### 8. `/walletTransactions/{transactionId}` (Legacy)

**Description**: Legacy wallet transaction collection. New architecture uses `/transactions/{userId}/transactions/{txId}`.

**Schema**:
```typescript
{
  walletId: string                       // Wallet/customer ID
  type: string                           // "credit" | "debit"
  amount: number
  previousBalance: number
  newBalance: number
  description: string
  createdAt: Timestamp
}
```

---

## Realtime Database Structure

### 1. `/balances/{uid}` (Legacy)

**Description**: Legacy balance storage. Being replaced by `/wallet/{uid}/fiat/{currency}`.

**Structure**:
```json
{
  "balances": {
    "{uid}": {
      "balance": 0,                      // Balance value
      "lastUpdated": 1234567890          // Timestamp
    }
  }
}
```

**Note**: This path is being phased out in favor of the new wallet structure.

---

### 2. `/wallet/{userId}/fiat/{currency}`

**Description**: Primary wallet balance storage in Realtime DB (cached mirror of Firestore).

**Structure**:
```json
{
  "wallet": {
    "{userId}": {
      "fiat": {
        "{currency}": {                  // Default: "USD"
          "balance": 100.50,
          "currency": "USD",
          "createdAt": 1234567890,
          "updatedAt": 1234567890
        }
      }
    }
  }
}
```

**Purpose**: Provides real-time balance updates to client applications (Flutter app expects this structure).

**Sync Strategy**: 
- Master source: Firestore `/users/{userId}.balance`
- Realtime DB is synced automatically via Cloud Function trigger when Firestore balance changes
- Client apps read from Realtime DB for real-time updates

**Security Rules**:
- Users can read their own balance
- Only Cloud Functions can write balances

---

### 3. `/wallet/rates/{source}/{currencyPair}`

**Description**: Cached exchange rates for fast client reads.

**Structure**:
```json
{
  "wallet": {
    "rates": {
      "binance": {
        "USDT/KES": {
          "customerPrice": 145.50,
          "marketPrice": 143.00,
          "feePercentage": 1.5,
          "currencyPair": "USDT/KES",
          "asset": "USDT",
          "fiat": "KES",
          "updatedAt": 1234567890,
          "validUntil": 1234568190
        }
      },
      "arbitrage": {
        "USD/KES": {
          "usdRate": 0.99,
          "localRate": 143.00,
          "usdAmount": 1000,
          "usdtBought": 1010.10,
          "localReceived": 144450.00,
          "customerPayout": 142283.25,
          "profit": 2166.75,
          "feePercentage": 1.5,
          "currencyPair": "USD/KES",
          "fiat": "KES",
          "updatedAt": 1234567890,
          "validUntil": 1234568490
        }
      }
    }
  }
}
```

**Security Rules**:
- Public read access
- Only Cloud Functions can write rates

---

### 4. `/wallet/pendingTopups/{invoiceId}`

**Description**: Temporary mapping of invoice ID to user ID for payment webhook processing.

**Structure**:
```json
{
  "wallet": {
    "pendingTopups": {
      "{invoiceId}": {
        "userId": "{userId}",
        "amount": 100.00,
        "currency": "KES",
        "createdAt": 1234567890
      }
    }
  }
}
```

**Purpose**: When creating an IntaSend invoice, this mapping is created. When webhook is received, it's used to resolve which user's wallet to credit. The mapping is deleted after use.

**Security Rules**:
- No client read/write access (internal use only)
- Only Cloud Functions can write

---

### 5. `/payments/{paymentId}`

**Description**: Payment records from IntaSend webhooks.

**Structure**:
```json
{
  "payments": {
    "{invoiceId}": {
      "invoice_id": "Y5JVGZG",
      "state": "COMPLETE",
      "net_amount": "10.66",
      "currency": "KES",
      "value": "11.00",
      "account": "254742844875",
      "user_id": "{userId}",
      "processed_at": "2024-01-01T12:00:00Z",
      // ... other IntaSend payload fields
    }
  }
}
```

**Security Rules**:
- Users can read payments where `user_id` matches their UID
- Admins can read all payments
- Only Cloud Functions can write payments

---

### 6. `/users/{uid}` (Legacy)

**Description**: Legacy user data mirror in Realtime DB. May contain user profile data for backward compatibility.

**Security Rules**:
- Users can read their own data
- Admins can read all user data
- No client writes (managed via Firestore)

---

## Data Flow & Architecture

### Balance Management

1. **Master Source**: Firestore `/users/{userId}.balance`
2. **Update Flow**:
   ```
   Cloud Function → Firestore Transaction → Balance Updated
                                              ↓
                                    onUpdate Trigger Fires
                                              ↓
                                    Sync to Realtime DB
   ```
3. **Client Reads**: Realtime DB `/wallet/{userId}/fiat/{currency}`

### Payment Processing

1. **Invoice Created**: Mapping stored in `/wallet/pendingTopups/{invoiceId}`
2. **Webhook Received**: 
   - Look up user ID from:
     - Order collection (`/orders`)
     - Pending topups mapping (`/wallet/pendingTopups/{invoiceId}`)
     - Phone number lookup (`/users` collection)
   - Update Firestore balance (via transaction)
   - Sync to Realtime DB
   - Record payment in `/payments/{paymentId}`
   - Create transaction log

### Rate Updates

1. **Scheduled Jobs**: Fetch rates from Binance API
2. **Write to Both**:
   - Firestore `/p2pRates/{source}`
   - Realtime DB `/wallet/rates/{source}/{currencyPair}`
3. **Client Reads**: Realtime DB (faster, real-time)

---

## Security Summary

### Firestore Security Rules

- **Users**: Can read/update own data (except balance)
- **Admins**: Full access to all collections
- **Public**: Read-only access to rates and config
- **Server-only**: Transactions, admin logs (Cloud Functions only)

### Realtime Database Security Rules

- **Users**: Can read own balance and wallet data
- **Admins**: Can read all user data
- **Public**: Read-only access to rates
- **Server-only**: All writes via Cloud Functions only

---

## Collections Summary

| Collection | Purpose | Access |
|-----------|---------|--------|
| `/users/{userId}` | User profiles (master) | User (own), Admin (all) |
| `/transactions/{userId}/transactions/{txId}` | Transaction history | User (own), Admin (all) |
| `/adminLogs/{logId}` | Admin audit logs | Admin only |
| `/p2pRates/{docId}` | Exchange rates | Public read, Admin write |
| `/config/{docId}` | App configuration | Public read, Admin write |
| `/orders/{orderId}` | Order records | Internal |
| `/customerWallets/{id}` | Legacy wallets | Legacy |
| `/walletTransactions/{id}` | Legacy transactions | Legacy |

---

## Realtime Database Paths Summary

| Path | Purpose | Access |
|------|---------|--------|
| `/wallet/{uid}/fiat/{currency}` | User balance (cached) | User (own) |
| `/wallet/rates/{source}/{pair}` | Exchange rates | Public read |
| `/wallet/pendingTopups/{invoiceId}` | Payment mapping | Server only |
| `/payments/{paymentId}` | Payment records | User (own), Admin (all) |
| `/balances/{uid}` | Legacy balance | User (own), Legacy |

---

## Notes

1. **Dual Database Strategy**: Firestore is the source of truth, Realtime DB is a cached mirror for real-time client reads.

2. **Balance Sync**: Automatic via Cloud Function trigger (`syncBalance`) when Firestore balance changes.

3. **Migration**: Legacy collections (`customerWallets`, `walletTransactions`) are being migrated to the new architecture.

4. **Currency Support**: Currently supports USD, KES, NGN, GHS. Structure allows for multi-currency wallets.

5. **Transaction Atomicity**: All balance updates use Firestore transactions to prevent race conditions.

6. **Audit Trail**: All admin actions and balance changes are logged for compliance.

