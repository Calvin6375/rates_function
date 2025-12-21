# TruePay Backend API Documentation

Complete API reference for frontend developers integrating with the TruePay Firebase Cloud Functions backend.

## Table of Contents

1. [Authentication](#authentication)
2. [Callable Functions](#callable-functions)
3. [HTTP REST Endpoints](#http-rest-endpoints)
4. [Real-time Data Listening](#real-time-data-listening)
5. [Error Handling](#error-handling)
6. [Data Models](#data-models)

---

## Authentication

All Callable Functions require Firebase Authentication. The user must be logged in using Firebase Auth before calling these functions.

**Flutter Example:**
```dart
import 'package:firebase_auth/firebase_auth.dart';

final user = FirebaseAuth.instance.currentUser;
if (user == null) {
  // User not authenticated
}
```

**Web/React Example:**
```javascript
import { getAuth } from 'firebase/auth';

const auth = getAuth();
const user = auth.currentUser;
if (!user) {
  // User not authenticated
}
```

---

## Callable Functions

Callable Functions are Firebase Cloud Functions that can be invoked directly from client applications. They automatically handle authentication tokens and CORS.

### Base URL
- **Production**: Your Firebase project's callable functions endpoint
- **Development**: `http://localhost:5001/{project-id}/{region}/functionName`

### 1. Get Binance Exchange Rates

**Function Name**: `getBinanceRates`

**Description**: Fetch USDT exchange rates for a specific fiat currency from Binance P2P marketplace.

**Authentication**: Required

**Request Body**:
```typescript
{
  fiat?: string;    // Optional, default: "KES" - Fiat currency code (KES, NGN, GHS)
  asset?: string;   // Optional, default: "USDT" - Crypto asset code
}
```

**Response**:
```typescript
{
  marketPrice: number;        // Market rate from Binance
  customerPrice: number;      // Price with service fee applied
  feePercentage: number;      // Service fee percentage (e.g., 1.5)
  currencyPair: string;       // e.g., "USDT/KES"
  asset: string;              // e.g., "USDT"
  fiat: string;               // e.g., "KES"
  validUntil: Timestamp;      // Rate validity timestamp
  updatedAt: Timestamp;       // Last update timestamp
  source: "firestore" | "fresh"; // Data source indicator
}
```

**Example - Flutter**:
```dart
import 'package:cloud_functions/cloud_functions.dart';

final functions = FirebaseFunctions.instance;
final getBinanceRates = functions.httpsCallable('getBinanceRates');

try {
  final result = await getBinanceRates.call({
    'fiat': 'KES',
    'asset': 'USDT',
  });
  
  final data = result.data;
  print('Customer Price: ${data['customerPrice']}');
  print('Market Price: ${data['marketPrice']}');
  print('Fee: ${data['feePercentage']}%');
} catch (e) {
  print('Error: $e');
}
```

**Example - Web/React**:
```javascript
import { getFunctions, httpsCallable } from 'firebase/functions';

const functions = getFunctions();
const getBinanceRates = httpsCallable(functions, 'getBinanceRates');

try {
  const result = await getBinanceRates({
    fiat: 'KES',
    asset: 'USDT',
  });
  
  console.log('Customer Price:', result.data.customerPrice);
  console.log('Market Price:', result.data.marketPrice);
  console.log('Fee:', result.data.feePercentage + '%');
} catch (error) {
  console.error('Error:', error.message);
}
```

---

### 2. Get Arbitrage Rates

**Function Name**: `getArbitrageRates`

**Description**: Get arbitrage rates for USD → USDT → Local Fiat currency conversion path.

**Authentication**: Required

**Request Body**:
```typescript
{
  fiat?: string;  // Optional, default: "KES" - Target fiat currency
}
```

**Response**:
```typescript
{
  usdRate: number;          // USD/USDT rate
  localRate: number;        // USDT/Local fiat rate
  usdAmount: number;        // Reference USD amount (default: 1000)
  usdtBought: number;       // USDT purchased with USD
  localReceived: number;    // Local fiat received after conversion
  feePercentage: number;    // Arbitrage fee percentage
  customerPayout: number;   // Final payout after fees
  profit: number;           // Profit margin
  currencyPair: string;     // e.g., "USD/KES"
  fiat: string;             // e.g., "KES"
  validUntil: Timestamp;    // Rate validity timestamp
  updatedAt: Timestamp;     // Last update timestamp
  source: "firestore" | "fresh";
}
```

**Example - Flutter**:
```dart
final getArbitrageRates = functions.httpsCallable('getArbitrageRates');

final result = await getArbitrageRates.call({
  'fiat': 'KES',
});

final data = result.data;
print('USD Rate: ${data['usdRate']}');
print('Customer Payout: ${data['customerPayout']}');
print('Profit: ${data['profit']}');
```

---

### 3. Update User Profile (Admin Only)

**Function Name**: `updateUserProfile`

**Description**: Admin-only function to update user profile information.

**Authentication**: Required (Admin user only)

**Request Body**:
```typescript
{
  userId: string;           // Target user ID (Firebase UID)
  updates: {
    name?: string;
    email?: string;
    country?: string;
    phoneNumber?: string;
    kycStatus?: "pending" | "approved" | "rejected" | "under_review";
    kycData?: object;       // Additional KYC information
  };
}
```

**Response**:
```typescript
{
  success: boolean;
  userId: string;
  updatedFields: string[];  // Array of field names that were updated
}
```

**Error Codes**:
- `unauthenticated` - User not logged in
- `permission-denied` - User is not an admin
- `invalid-argument` - Missing userId or updates object
- `not-found` - User not found

---

### 4. Update User Balance (Admin Only)

**Function Name**: `updateUserBalance`

**Description**: Admin-only function to credit or debit user wallet balance.

**Authentication**: Required (Admin user only)

**Request Body**:
```typescript
{
  userId: string;      // Target user ID
  amount: number;      // Amount to add (positive) or subtract (negative)
  reason?: string;     // Optional reason for balance update
}
```

**Response**:
```typescript
{
  success: boolean;
  userId: string;
  previousBalance: number;
  newBalance: number;
  amountDelta: number;
  transactionId: string;    // Unique transaction ID
}
```

**Error Codes**:
- `unauthenticated` - User not logged in
- `permission-denied` - User is not an admin
- `invalid-argument` - Invalid userId or amount
- `not-found` - User not found

**Example - Flutter**:
```dart
final updateUserBalance = functions.httpsCallable('updateUserBalance');

final result = await updateUserBalance.call({
  'userId': 'user123',
  'amount': 50.0,  // Positive for credit, negative for debit
  'reason': 'Admin credit for promotional offer',
});

print('Previous Balance: ${result.data['previousBalance']}');
print('New Balance: ${result.data['newBalance']}');
```

---

### 5. Get User Data (Admin Only)

**Function Name**: `getUserData`

**Description**: Admin-only function to retrieve complete user data.

**Authentication**: Required (Admin user only)

**Request Body**:
```typescript
{
  userId: string;  // Target user ID
}
```

**Response**:
```typescript
{
  success: boolean;
  userId: string;
  userData: {
    uid?: string;
    email?: string;
    name?: string;
    firstName?: string;
    lastName?: string;
    phoneNumber?: string;
    balance: number;
    fiatBalance?: number;
    cryptoBalance?: number;
    currency?: string;
    country?: string;
    kycStatus?: string;
    kycData?: object;
    createdAt?: Timestamp;
    updatedAt?: Timestamp;
    // ... other user fields
  };
}
```

---

### 6. Update KYC Status (Admin Only)

**Function Name**: `updateKYCStatus`

**Description**: Admin-only function to update user KYC verification status.

**Authentication**: Required (Admin user only)

**Request Body**:
```typescript
{
  userId: string;
  kycStatus: "pending" | "approved" | "rejected" | "under_review";
  kycData?: object;  // Optional additional KYC data
}
```

**Response**:
```typescript
{
  success: boolean;
  userId: string;
  kycStatus: string;
}
```

---

### 7. Sync User Balance to Realtime DB (Admin Only)

**Function Name**: `syncUserBalanceToRealtime`

**Description**: Admin-only function to manually sync user balance from Firestore to Realtime Database. Useful for fixing discrepancies.

**Authentication**: Required (Admin user only)

**Request Body**:
```typescript
{
  userId: string;
}
```

**Response**:
```typescript
{
  success: boolean;
  userId: string;
  balance: number;
  currency: string;
  message: string;
}
```

---

### 8. Get Commission Configuration (Admin Only)

**Function Name**: `getCommissionConfig`

**Description**: Admin-only function to retrieve current commission/fee settings.

**Authentication**: Required (Admin user only)

**Request Body**: (empty - no parameters needed)
```typescript
{}
```

**Response**:
```typescript
{
  success: boolean;
  config: {
    arbitrageFee: number;      // e.g., 1.5 (for 1.5%)
    serviceFee: number;         // e.g., 1.5 (for 1.5%)
    updatedAt: number | null;   // Timestamp in milliseconds
  };
  message?: string;
}
```

**Example - Flutter**:
```dart
final getCommissionConfig = functions.httpsCallable('getCommissionConfig');

final result = await getCommissionConfig.call();
final config = result.data['config'];
print('Arbitrage Fee: ${config['arbitrageFee']}%');
print('Service Fee: ${config['serviceFee']}%');
```

---

### 9. Update Commission Configuration (Admin Only)

**Function Name**: `updateCommissionConfig`

**Description**: Admin-only function to update commission/fee settings for arbitrage and service fees.

**Authentication**: Required (Admin user only)

**Request Body**:
```typescript
{
  arbitrageFee?: number;  // Optional: Arbitrage fee percentage (e.g., 1.5 for 1.5%)
  serviceFee?: number;    // Optional: Service fee percentage (e.g., 1.5 for 1.5%)
}
```

**Note**: At least one fee must be provided. Both are optional but at least one is required.

**Response**:
```typescript
{
  success: boolean;
  config: {
    arbitrageFee: number;
    serviceFee: number;
    updatedAt: number;
    updatedBy: string;    // Admin user ID who made the update
  };
  message: string;
}
```

**Example - Flutter**:
```dart
final updateCommissionConfig = functions.httpsCallable('updateCommissionConfig');

final result = await updateCommissionConfig.call({
  'arbitrageFee': 2.0,  // Set to 2%
  'serviceFee': 1.5,    // Keep service fee at 1.5%
});

print('Success: ${result.data['message']}');
print('New Arbitrage Fee: ${result.data['config']['arbitrageFee']}%');
```

**Error Codes**:
- `unauthenticated` - User not logged in
- `permission-denied` - User is not an admin
- `invalid-argument` - Invalid fee values (must be 0-100)

---

### 10. Get IntaSend Payment Status (Admin Only)

**Function Name**: `getIntaSendPaymentStatus`

**Description**: Admin-only function to check the status of an IntaSend payment by invoice_id. This allows admins to track payment status directly from the dashboard.

**Authentication**: Required (Admin user only)

**Request Body**:
```typescript
{
  invoiceId: string;  // IntaSend invoice ID (e.g., "XMSLWOS")
}
```

**Response**:
```typescript
{
  success: boolean;
  invoiceId: string;
  status: {
    invoice: {
      id: string;
      invoice_id: string;
      state: "PENDING" | "PROCESSING" | "COMPLETE" | "FAILED";
      provider: string;           // e.g., "M-PESA"
      charges: string;            // e.g., "0.00"
      net_amount: number;         // Amount after fees
      currency: string;            // e.g., "KES"
      value: string;              // Original amount
      account: string;             // Phone number or email
      api_ref: string;
      host: string;               // IntaSend host URL
      failed_reason: string | null;
      created_at: string;         // ISO timestamp
      updated_at: string;         // ISO timestamp
    };
    meta: {
      id: string;
      customer: {
        id: string;
        phone_number: string;
        email: string;
        first_name: string;
        last_name: string;
        country: string;
        address: string;
        city: string;
        state: string;
        zipcode: string;
        provider: string;
        created_at: string;
        updated_at: string;
      };
      customer_comment: string;
      created_at: string;
      updated_at: string;
    };
  };
  invoice: object;  // Same as status.invoice (for convenience)
  meta: object;    // Same as status.meta (for convenience)
}
```

**Payment States**:
- `PENDING` - Payment is pending user action
- `PROCESSING` - Payment is being processed
- `COMPLETE` - Payment completed successfully
- `FAILED` - Payment failed

**Error Codes**:
- `unauthenticated` - User not logged in
- `permission-denied` - User is not an admin or invalid IntaSend API credentials
- `invalid-argument` - Missing or invalid invoiceId
- `not-found` - Invoice ID not found in IntaSend
- `failed-precondition` - IntaSend API keys not configured
- `deadline-exceeded` - IntaSend API request timed out

**Example - Web/React**:
```javascript
import { getFunctions, httpsCallable } from 'firebase/functions';

const functions = getFunctions();
const getIntaSendPaymentStatus = httpsCallable(functions, 'getIntaSendPaymentStatus');

try {
  const result = await getIntaSendPaymentStatus({
    invoiceId: 'XMSLWOS'
  });
  
  const status = result.data.status;
  console.log('Payment State:', status.invoice.state);
  console.log('Amount:', status.invoice.net_amount, status.invoice.currency);
  console.log('Customer:', status.meta.customer.first_name, status.meta.customer.last_name);
} catch (error) {
  if (error.code === 'not-found') {
    console.error('Invoice not found');
  } else if (error.code === 'permission-denied') {
    console.error('Admin access required or invalid API credentials');
  } else {
    console.error('Error:', error.message);
  }
}
```

**Example - Flutter**:
```dart
final getIntaSendPaymentStatus = functions.httpsCallable('getIntaSendPaymentStatus');

try {
  final result = await getIntaSendPaymentStatus.call({
    'invoiceId': 'XMSLWOS',
  });
  
  final status = result.data['status'];
  print('Payment State: ${status['invoice']['state']}');
  print('Amount: ${status['invoice']['net_amount']} ${status['invoice']['currency']}');
} catch (e) {
  print('Error: $e');
}
```

**Configuration Required**:
Before using this function, you must configure IntaSend API credentials as Firebase secrets:
```bash
# Set IntaSend API secret key (required)
firebase functions:secrets:set INTASEND_SECRET_KEY

# Set IntaSend publishable key (optional, but recommended)
firebase functions:secrets:set INTASEND_PUBLISHABLE_KEY
```

---

## HTTP REST Endpoints

REST endpoints are accessible via HTTP requests. They support CORS and can be called from web applications.

### Base URL
- **Production**: `https://{region}-{project-id}.cloudfunctions.net/api`
- **Development**: `http://localhost:5001/{project-id}/{region}/api`

### Authentication
Some endpoints may require authentication via Firebase Auth token in the `Authorization` header:
```
Authorization: Bearer {firebase-auth-token}
```

---

### 1. Get Exchange Rates (With Commission)

**Endpoint**: `GET /api/binance/rates`

**Description**: Returns exchange rates **with commission already applied**. This endpoint retrieves rates that have been fetched from Binance, commission added, and stored in the database. **Flutter apps should use this endpoint** to get the customer-facing rates.

**Important**: The response includes both `marketPrice` (raw Binance rate) and `customerPrice` (rate with commission). **Always use `customerPrice`** for customer transactions, as this is the rate with your commission already included.

**Authentication**: Not required

**Query Parameters**:
```
?fiat=KES&asset=USDT
```
- `fiat` (optional): Fiat currency code (default: "KES")
- `asset` (optional): Crypto asset code (default: "USDT")

**Response**:
```json
{
  "marketPrice": 129.50,      // Raw Binance rate (for reference only)
  "customerPrice": 131.44,    // Rate WITH commission - USE THIS for transactions
  "feePercentage": 1.5,       // Commission percentage applied
  "currencyPair": "USDT/KES",
  "asset": "USDT",
  "fiat": "KES",
  "validUntil": 1764807005227,
  "updatedAt": 1764806405463,
  "source": "firestore"       // or "fresh" if fetched from Binance
}
```

**Flutter Example**:
```dart
import 'package:http/http.dart' as http;
import 'dart:convert';

Future<Map<String, dynamic>> getExchangeRates({
  String fiat = 'KES',
  String asset = 'USDT',
}) async {
  final url = Uri.parse(
    'https://us-central1-truepay-72060.cloudfunctions.net/api/binance/rates?fiat=$fiat&asset=$asset'
  );
  
  final response = await http.get(url);
  
  if (response.statusCode == 200) {
    final data = json.decode(response.body) as Map<String, dynamic>;
    // Use customerPrice - this is the rate with commission already applied
    return {
      'rate': data['customerPrice'],  // Rate with commission
      'rawRate': data['marketPrice'],  // Raw Binance rate (for reference)
      'feePercentage': data['feePercentage'],
      'currencyPair': data['currencyPair'],
    };
  } else {
    throw Exception('Failed to fetch rates: ${response.statusCode}');
  }
}

// Usage
final rates = await getExchangeRates(fiat: 'KES', asset: 'USDT');
print('Customer Rate (with commission): ${rates['rate']}');  // Use this!
print('Raw Binance Rate: ${rates['rawRate']}');  // For reference only
```

**JavaScript Example**:
```javascript
const response = await fetch(
  'https://us-central1-truepay-72060.cloudfunctions.net/api/binance/rates?fiat=KES&asset=USDT'
);
const data = await response.json();

// Use customerPrice - this is the rate with commission already applied
const customerRate = data.customerPrice;  // Use this for transactions!
const rawRate = data.marketPrice;  // For reference only
console.log('Customer Rate (with commission):', customerRate);
```

**Note**: Rates are cached and updated periodically. The `source` field indicates whether the rate came from cache (`"firestore"`) or was freshly fetched from Binance (`"fresh"`). The `customerPrice` always includes your commission regardless of the source.

---

### 2. Get Binance Rates (Legacy HTTP)

**Endpoint**: `GET /fetchBinanceRatesHttp`

**Description**: Legacy HTTP endpoint (direct Cloud Function). Prefer using `/api/binance/rates` for new integrations. Returns the same data format with `customerPrice` (rate with commission) and `marketPrice` (raw Binance rate).

**Authentication**: Not required

**Query Parameters**:
```
?fiat=KES&asset=USDT
```

**Response**: Same format as `/api/binance/rates`

**Example - JavaScript**:
```javascript
const response = await fetch(
  'https://us-central1-truepay-72060.cloudfunctions.net/fetchBinanceRatesHttp?fiat=KES&asset=USDT'
);
const data = await response.json();
console.log('Customer Price (with commission):', data.customerPrice);  // Use this!
```

---

### 3. Customer Wallets API

All customer wallet endpoints are under `/api/customer-wallets`.

#### 3.1. List Customer Wallets

**Endpoint**: `GET /api/customer-wallets`

**Description**: Get paginated list of all customer wallets.

**Query Parameters**:
```
?limit=100&offset=0
```

**Response**:
```typescript
{
  success: boolean;
  data: Array<{
    id: string;
    customerId: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    cryptoBalance: number;
    fiatBalance: number;
    status: string;
    createdAt: string | null;
    updatedAt: string | null;
  }>;
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}
```

**Example**:
```javascript
const response = await fetch(
  'https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets?limit=50&offset=0'
);
const result = await response.json();
console.log('Total wallets:', result.pagination.total);
console.log('Wallets:', result.data);
```

---

#### 3.2. Get Customer Wallet by ID

**Endpoint**: `GET /api/customer-wallets/:id`

**Description**: Get a specific customer wallet by ID.

**URL Parameters**:
- `id`: Customer wallet ID (Firebase UID)

**Response**:
```typescript
{
  success: boolean;
  data: {
    id: string;
    customerId: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    cryptoBalance: number;
    fiatBalance: number;
    status: string;
    country?: string;
    kycStatus?: string;
    createdAt: string | null;
    updatedAt: string | null;
  };
}
```

**Example**:
```javascript
const walletId = '82XqLAxq2udeYzrR89tvrEbYXbB2';
const response = await fetch(
  `https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets/${walletId}`
);
const result = await response.json();
console.log('Wallet:', result.data);
```

---

#### 3.3. Update Customer Wallet

**Endpoint**: `PUT /api/customer-wallets/:id`

**Description**: Update customer wallet details.

**URL Parameters**:
- `id`: Customer wallet ID

**Request Body**:
```typescript
{
  firstName?: string;
  lastName?: string;
  name?: string;          // Will be split into firstName/lastName
  email?: string;
  phone?: string;
  status?: string;
  country?: string;
  // Note: Cannot update balance directly - use credit/debit endpoints
}
```

**Response**:
```typescript
{
  success: boolean;
  data: {
    id: string;
    customerId: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    cryptoBalance: number;
    fiatBalance: number;
    status: string;
    country?: string;
    kycStatus?: string;
    createdAt: string | null;
    updatedAt: string | null;
  };
}
```

**Example**:
```javascript
const walletId = '82XqLAxq2udeYzrR89tvrEbYXbB2';
const response = await fetch(
  `https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets/${walletId}`,
  {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      firstName: 'John',
      lastName: 'Doe',
      phone: '+254712345678',
    }),
  }
);
const result = await response.json();
```

---

#### 3.4. Credit Wallet

**Endpoint**: `POST /api/customer-wallets/:id/credit`

**Description**: Credit money to a customer wallet.

**URL Parameters**:
- `id`: Customer wallet ID

**Request Body**:
```typescript
{
  amount: number;         // Positive number
  description?: string;   // Optional description
}
```

**Response**:
```typescript
{
  success: boolean;
  data: {
    id: string;
    customerId: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    cryptoBalance: number;
    fiatBalance: number;
    status: string;
  };
  transaction: {
    type: "credit";
    amount: number;
    previousBalance: number;
    newBalance: number;
  };
}
```

**Example**:
```javascript
const walletId = '82XqLAxq2udeYzrR89tvrEbYXbB2';
const response = await fetch(
  `https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets/${walletId}/credit`,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: 100,
      description: 'Top-up from admin',
    }),
  }
);
const result = await response.json();
console.log('New Balance:', result.data.fiatBalance);
```

---

#### 3.5. Debit Wallet

**Endpoint**: `POST /api/customer-wallets/:id/debit`

**Description**: Debit money from a customer wallet.

**URL Parameters**:
- `id`: Customer wallet ID

**Request Body**:
```typescript
{
  amount: number;         // Positive number (will be subtracted)
  description?: string;   // Optional description
}
```

**Response**:
```typescript
{
  success: boolean;
  data: {
    id: string;
    customerId: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    cryptoBalance: number;
    fiatBalance: number;
    status: string;
  };
  transaction: {
    type: "debit";
    amount: number;
    previousBalance: number;
    newBalance: number;
  };
}
```

**Error Response (Insufficient Balance)**:
```json
{
  "success": false,
  "error": "Insufficient balance",
  "currentBalance": 50,
  "requestedAmount": 100
}
```

**Example**:
```javascript
const walletId = '82XqLAxq2udeYzrR89tvrEbYXbB2';
const response = await fetch(
  `https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets/${walletId}/debit`,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: 25,
      description: 'Payment for services',
    }),
  }
);
const result = await response.json();
if (result.success) {
  console.log('New Balance:', result.data.fiatBalance);
}
```

---

#### 3.6. Create Customer Wallet

**Endpoint**: `POST /api/customer-wallets`

**Description**: Create a new customer wallet (legacy support).

**Request Body**:
```typescript
{
  name: string;              // Required
  email: string;             // Required
  phone?: string;
  initialBalance?: number;   // Optional, default: 0
}
```

**Response**:
```typescript
{
  success: boolean;
  data: {
    id: string;
    name: string;
    email: string;
    phone: string;
    balance: number;
    status: string;
    createdAt: string | null;
    updatedAt: string | null;
  };
}
```

**Error Response (Email Exists)**:
```json
{
  "success": false,
  "error": "Customer with this email already exists"
}
```

---

#### 3.7. Get Commission Configuration

**Endpoint**: `GET /api/config/fees`

**Description**: Get current commission/fee settings.

**Authentication**: Required (Admin only - Bearer token)

**Request Headers**:
```
Authorization: Bearer {firebase-auth-token}
```

**Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "arbitrageFee": 1.5,
    "serviceFee": 1.5,
    "updatedAt": "2025-01-04T12:00:00.000Z",
    "updatedBy": "admin-user-id"
  }
}
```

**Example**:
```javascript
const response = await fetch(
  'https://us-central1-truepay-72060.cloudfunctions.net/api/config/fees',
  {
    headers: {
      'Authorization': `Bearer ${firebaseAuthToken}`,
    },
  }
);
const result = await response.json();
console.log('Arbitrage Fee:', result.data.arbitrageFee + '%');
```

---

#### 3.8. Update Commission Configuration

**Endpoint**: `PUT /api/config/fees`

**Description**: Update commission/fee settings for arbitrage and service fees.

**Authentication**: Required (Admin only - Bearer token)

**Request Body**:
```typescript
{
  arbitrageFee?: number;  // Optional: Arbitrage fee percentage (e.g., 1.5 for 1.5%)
  serviceFee?: number;    // Optional: Service fee percentage (e.g., 1.5 for 1.5%)
}
```

**Note**: At least one fee must be provided.

**Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "arbitrageFee": 2.0,
    "serviceFee": 1.5,
    "updatedAt": "2025-01-04T12:00:00.000Z",
    "updatedBy": "admin-user-id"
  },
  "message": "Commission configuration updated successfully"
}
```

**Error Responses**:
- `400 Bad Request` - Invalid fee values (must be 0-100) or no fees provided
- `401 Unauthorized` - Not authenticated
- `403 Forbidden` - Not an admin user
- `500 Internal Server Error` - Server error

**Example**:
```javascript
const response = await fetch(
  'https://us-central1-truepay-72060.cloudfunctions.net/api/config/fees',
  {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${firebaseAuthToken}`,
    },
    body: JSON.stringify({
      arbitrageFee: 2.0,
      serviceFee: 1.5,
    }),
  }
);
const result = await response.json();
console.log('Success:', result.message);
```

---

## Real-time Data Listening

### Wallet Balance (Realtime Database)

The wallet balance is stored in Firebase Realtime Database for real-time updates. Listen to changes directly from the client.

**Path Structure**:
```
wallet/{userId}/fiat/{currency}
```

**Example Path**:
```
wallet/82XqLAxq2udeYzrR89tvrEbYXbB2/fiat/USD
```

**Data Structure**:
```typescript
{
  balance: number;
  currency: string;
  createdAt: number;    // Timestamp in milliseconds
  updatedAt: number;    // Timestamp in milliseconds
}
```

**Flutter Example**:
```dart
import 'package:firebase_database/firebase_database.dart';

final database = FirebaseDatabase.instance;
final userId = FirebaseAuth.instance.currentUser?.uid;

if (userId != null) {
  final balanceRef = database.ref('wallet/$userId/fiat/USD');
  
  // Listen to balance changes
  balanceRef.onValue.listen((DatabaseEvent event) {
    if (event.snapshot.exists) {
      final data = event.snapshot.value as Map<dynamic, dynamic>;
      final balance = data['balance'] as num;
      final currency = data['currency'] as String;
      
      print('Balance updated: $balance $currency');
    }
  });
}
```

**Web/React Example**:
```javascript
import { getDatabase, ref, onValue } from 'firebase/database';
import { getAuth } from 'firebase/auth';

const database = getDatabase();
const auth = getAuth();
const userId = auth.currentUser?.uid;

if (userId) {
  const balanceRef = ref(database, `wallet/${userId}/fiat/USD`);
  
  // Listen to balance changes
  onValue(balanceRef, (snapshot) => {
    if (snapshot.exists()) {
      const data = snapshot.val();
      console.log('Balance updated:', data.balance, data.currency);
    }
  });
}
```

---

### Exchange Rates (Realtime Database)

**Binance Rates Path**:
```
wallet/rates/binance/{currencyPair}
```

**Example**: `wallet/rates/binance/USDT/KES`

**Data Structure**:
```typescript
{
  customerPrice: number;
  marketPrice: number;
  feePercentage: number;
  currencyPair: string;
  asset: string;
  fiat: string;
  updatedAt: number;
  validUntil: number;
}
```

**Arbitrage Rates Path**:
```
wallet/rates/arbitrage/{currencyPair}
```

**Example**: `wallet/rates/arbitrage/USD/KES`

**Data Structure**:
```typescript
{
  usdRate: number;
  localRate: number;
  usdAmount: number;
  usdtBought: number;
  localReceived: number;
  customerPayout: number;
  profit: number;
  feePercentage: number;
  currencyPair: string;
  fiat: string;
  updatedAt: number;
  validUntil: number;
}
```

---

## Error Handling

### Callable Function Errors

Callable functions throw `HttpsError` objects with specific error codes:

```typescript
interface HttpsError {
  code: string;        // Error code
  message: string;     // Error message
  details?: any;       // Additional error details
}
```

**Common Error Codes**:
- `unauthenticated` - User not logged in
- `permission-denied` - Insufficient permissions (e.g., not an admin)
- `invalid-argument` - Invalid request parameters
- `not-found` - Resource not found
- `internal` - Server error

**Flutter Error Handling**:
```dart
try {
  final result = await function.call(data);
} on FirebaseFunctionsException catch (e) {
  switch (e.code) {
    case 'unauthenticated':
      print('User not authenticated');
      break;
    case 'permission-denied':
      print('Permission denied');
      break;
    case 'invalid-argument':
      print('Invalid argument: ${e.message}');
      break;
    default:
      print('Error: ${e.message}');
  }
}
```

**Web/React Error Handling**:
```javascript
try {
  const result = await function(data);
} catch (error) {
  if (error.code === 'functions/unauthenticated') {
    console.error('User not authenticated');
  } else if (error.code === 'functions/permission-denied') {
    console.error('Permission denied');
  } else if (error.code === 'functions/invalid-argument') {
    console.error('Invalid argument:', error.message);
  } else {
    console.error('Error:', error.message);
  }
}
```

### HTTP REST Errors

HTTP endpoints return standard HTTP status codes:

- `200` - Success
- `400` - Bad Request (invalid parameters)
- `401` - Unauthorized
- `403` - Forbidden
- `404` - Not Found
- `409` - Conflict (e.g., email already exists)
- `500` - Internal Server Error

**Error Response Format**:
```json
{
  "success": false,
  "error": "Error message",
  "message": "Detailed error message"
}
```

---

## Data Models

### User Data Model

```typescript
interface User {
  uid: string;                    // Firebase Auth UID
  email: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  phoneNumber?: string;
  balance: number;                // Master balance (Firestore)
  fiatBalance?: number;
  cryptoBalance?: number;
  currency?: string;              // Default: "USD"
  fiatCurrency?: string;
  country?: string;
  kycStatus?: "pending" | "approved" | "rejected" | "under_review";
  kycData?: object;
  status?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  lastTopUp?: Timestamp;
}
```

### Wallet Balance (Realtime DB)

```typescript
interface WalletBalance {
  balance: number;
  currency: string;
  createdAt: number;              // Unix timestamp in milliseconds
  updatedAt: number;              // Unix timestamp in milliseconds
}
```

### Exchange Rate

```typescript
interface BinanceRate {
  marketPrice: number;
  customerPrice: number;
  feePercentage: number;
  currencyPair: string;
  asset: string;
  fiat: string;
  validUntil: Timestamp | number;
  updatedAt: Timestamp | number;
  source?: "firestore" | "fresh";
}
```

### Arbitrage Rate

```typescript
interface ArbitrageRate {
  usdRate: number;
  localRate: number;
  usdAmount: number;
  usdtBought: number;
  localReceived: number;
  feePercentage: number;
  customerPayout: number;
  profit: number;
  currencyPair: string;
  fiat: string;
  validUntil: Timestamp | number;
  updatedAt: Timestamp | number;
  source?: "firestore" | "fresh";
}
```

---

## Best Practices

1. **Always check authentication** before making authenticated API calls
2. **Handle errors gracefully** - Use try-catch blocks and check error codes
3. **Cache rates** - Exchange rates are valid for 5-10 minutes, cache them locally
4. **Use real-time listeners** for balance updates instead of polling
5. **Validate input** on the client side before sending requests
6. **Show loading states** during async operations
7. **Implement retry logic** for failed network requests
8. **Check rate validity** before displaying rates to users

---

## Support

For issues or questions:
- Check the main `readme.md` for detailed backend documentation
- Review Firebase Functions logs in Firebase Console
- Verify authentication and permissions
- Check network connectivity and CORS settings

---

## Troubleshooting

### Common Errors

#### 1. "Failed to fetch rates" Error

**Possible Causes**:
- Network connectivity issues
- Binance API is down or rate-limited
- Firestore configuration missing
- Cloud Function timeout

**Solutions**:
1. Check Cloud Functions logs: `firebase functions:log --only getBinanceRates`
2. Verify Firestore `config/fees` document exists
3. Test Binance API connectivity
4. Check function timeout settings

See `TROUBLESHOOTING.md` for detailed debugging steps.

#### 2. FCM Service Worker Error

**Error**: `Messaging: We are unable to register the default service worker`

**Solution**:
1. Create `firebase-messaging-sw.js` in your public directory
2. Use the template in `firebase-messaging-sw.js.template`
3. Configure with your Firebase project credentials
4. Deploy to hosting service

See `TROUBLESHOOTING.md` for complete instructions.

#### 3. "unauthenticated" Error

**Cause**: User not logged in

**Solution**: Ensure user is authenticated before calling functions:

```javascript
const auth = getAuth();
const user = auth.currentUser;
if (!user) {
  // Redirect to login
  return;
}
```

#### 4. "permission-denied" Error on Admin Functions

**Cause**: User is not an admin

**Solution**: Set `isAdmin: true` in user document:
- Firestore path: `users/{userId}`
- Field: `isAdmin: true`

---

## Support

For issues or questions:
- Check `TROUBLESHOOTING.md` for detailed error resolution
- Review Firebase Functions logs in Firebase Console
- Verify authentication and permissions
- Check network connectivity and CORS settings
- See main `readme.md` for backend architecture details

---

**Last Updated**: 2025-01-04

