# TruePay API - Postman Collection

Postman collection documentation for TruePay Firebase Cloud Functions API.

## Base URLs

- **Production**: `https://us-central1-truepay-72060.cloudfunctions.net`
- **Callable Functions**: `https://us-central1-truepay-72060.cloudfunctions.net`
- **REST API**: `https://us-central1-truepay-72060.cloudfunctions.net/api`

## Authentication

### Firebase Auth Token
For callable functions and authenticated REST endpoints, include Firebase Auth token:
- **Header**: `Authorization: Bearer {firebase-auth-token}`
- Get token from Firebase Auth SDK in your client app

### Getting Auth Token (for Postman testing)
1. Use Firebase Admin SDK or
2. Get token from your Flutter/Web app's Firebase Auth instance
3. Copy the ID token and use it in Postman

---

## Callable Functions

Callable functions use POST requests with JSON body. Firebase automatically handles authentication via the `Authorization` header.

### Base URL for Callable Functions
```
POST https://us-central1-truepay-72060.cloudfunctions.net/{functionName}
```

**Headers**:
```
Content-Type: application/json
Authorization: Bearer {firebase-auth-token}
```

---

### 1. Get Binance Exchange Rates

**Endpoint**: `POST https://us-central1-truepay-72060.cloudfunctions.net/getBinanceRates`

**Headers**:
```
Content-Type: application/json
Authorization: Bearer {firebase-auth-token}
```

**Request Body**:
```json
{
  "fiat": "KES",
  "asset": "USDT"
}
```

**Response** (200 OK):
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

---

### 2. Get Arbitrage Rates

**Endpoint**: `POST https://us-central1-truepay-72060.cloudfunctions.net/getArbitrageRates`

**Headers**:
```
Content-Type: application/json
Authorization: Bearer {firebase-auth-token}
```

**Request Body**:
```json
{
  "fiat": "KES"
}
```

**Response** (200 OK):
```json
{
  "usdRate": 1.0,
  "localRate": 129.50,
  "usdAmount": 1000,
  "usdtBought": 1000,
  "localReceived": 129500,
  "feePercentage": 1.5,
  "customerPayout": 127557.5,
  "profit": 1942.5,
  "currencyPair": "USD/KES",
  "fiat": "KES",
  "validUntil": 1764807005227,
  "updatedAt": 1764806405463,
  "source": "firestore"
}
```

---

### 3. Create Payment Order

**Endpoint**: `POST https://us-central1-truepay-72060.cloudfunctions.net/createPayment`

**Headers**:
```
Content-Type: application/json
Authorization: Bearer {firebase-auth-token}
```

**Request Body**:
```json
{
  "amount": 1000,
  "currency": "KES",
  "invoiceId": "XMSLWOS",
  "checkoutUrl": "https://payment.intasend.com/checkout/XMSLWOS/express/",
  "phoneNumber": "+254712345678",
  "metadata": {}
}
```

**Response** (200 OK):
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

---

### 4. Update User Profile (Admin Only)

**Endpoint**: `POST https://us-central1-truepay-72060.cloudfunctions.net/updateUserProfile`

**Headers**:
```
Content-Type: application/json
Authorization: Bearer {firebase-auth-token}
```

**Request Body**:
```json
{
  "userId": "user123",
  "updates": {
    "name": "John Doe",
    "email": "john@example.com",
    "phoneNumber": "+254712345678",
    "country": "KE",
    "kycStatus": "approved"
  }
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "userId": "user123",
  "updatedFields": ["name", "email", "phoneNumber"]
}
```

---

### 5. Update User Balance (Admin Only)

**Endpoint**: `POST https://us-central1-truepay-72060.cloudfunctions.net/updateUserBalance`

**Headers**:
```
Content-Type: application/json
Authorization: Bearer {firebase-auth-token}
```

**Request Body**:
```json
{
  "userId": "user123",
  "amount": 50.0,
  "reason": "Admin credit for promotional offer"
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "userId": "user123",
  "previousBalance": 100.0,
  "newBalance": 150.0,
  "amountDelta": 50.0,
  "transactionId": "txn_abc123"
}
```

---

### 6. Get User Data (Admin Only)

**Endpoint**: `POST https://us-central1-truepay-72060.cloudfunctions.net/getUserData`

**Headers**:
```
Content-Type: application/json
Authorization: Bearer {firebase-auth-token}
```

**Request Body**:
```json
{
  "userId": "user123"
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "userId": "user123",
  "userData": {
    "uid": "user123",
    "email": "user@example.com",
    "name": "John Doe",
    "phoneNumber": "+254712345678",
    "balance": 150.0,
    "fiatBalance": 150.0,
    "cryptoBalance": 0.0,
    "currency": "USD",
    "country": "KE",
    "kycStatus": "approved",
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-01T00:00:00Z"
  }
}
```

---

### 7. Update KYC Status (Admin Only)

**Endpoint**: `POST https://us-central1-truepay-72060.cloudfunctions.net/updateKYCStatus`

**Headers**:
```
Content-Type: application/json
Authorization: Bearer {firebase-auth-token}
```

**Request Body**:
```json
{
  "userId": "user123",
  "kycStatus": "approved",
  "kycData": {
    "documentType": "national_id",
    "documentNumber": "12345678"
  }
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "userId": "user123",
  "kycStatus": "approved"
}
```

---

### 8. Sync User Balance to Realtime DB (Admin Only)

**Endpoint**: `POST https://us-central1-truepay-72060.cloudfunctions.net/syncUserBalanceToRealtime`

**Headers**:
```
Content-Type: application/json
Authorization: Bearer {firebase-auth-token}
```

**Request Body**:
```json
{
  "userId": "user123"
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "userId": "user123",
  "balance": 150.0,
  "currency": "USD",
  "message": "Balance synced successfully"
}
```

---

### 9. Get Commission Configuration (Admin Only)

**Endpoint**: `POST https://us-central1-truepay-72060.cloudfunctions.net/getCommissionConfig`

**Headers**:
```
Content-Type: application/json
Authorization: Bearer {firebase-auth-token}
```

**Request Body**:
```json
{}
```

**Response** (200 OK):
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

---

### 10. Update Commission Configuration (Admin Only)

**Endpoint**: `POST https://us-central1-truepay-72060.cloudfunctions.net/updateCommissionConfig`

**Headers**:
```
Content-Type: application/json
Authorization: Bearer {firebase-auth-token}
```

**Request Body**:
```json
{
  "arbitrageFee": 2.0,
  "serviceFee": 1.5
}
```

**Response** (200 OK):
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

---

### 11. Get IntaSend Payment Status (Admin Only)

**Endpoint**: `POST https://us-central1-truepay-72060.cloudfunctions.net/getIntaSendPaymentStatus`

**Headers**:
```
Content-Type: application/json
Authorization: Bearer {firebase-auth-token}
```

**Request Body**:
```json
{
  "invoiceId": "XMSLWOS"
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "invoiceId": "XMSLWOS",
  "status": {
    "invoice": {
      "id": "XMSLWOS",
      "invoice_id": "XMSLWOS",
      "state": "COMPLETE",
      "provider": "M-PESA",
      "charges": "0.00",
      "net_amount": 10.36,
      "currency": "KES",
      "value": "10.36",
      "account": "254712345678",
      "api_ref": "ISL_faa26ef9-eb08-4353-b125-ec6a8f022815",
      "host": "https://payment.intasend.com",
      "failed_reason": null,
      "created_at": "2024-01-01T08:37:15.781977+03:00",
      "updated_at": "2024-01-01T08:37:15.782011+03:00"
    },
    "meta": {
      "id": "5aec8e0b-8d96-429b-98b7-5361198160bd",
      "customer": {
        "id": "ZOEW022",
        "phone_number": "254712345678",
        "email": "user@example.com",
        "first_name": "John",
        "last_name": "Doe",
        "country": "KE"
      }
    }
  }
}
```

---

### 12. Set Admin Claim

**Endpoint**: `POST https://us-central1-truepay-72060.cloudfunctions.net/setAdminClaim`

**Headers**:
```
Content-Type: application/json
Authorization: Bearer {firebase-auth-token}
```

**Request Body**:
```json
{
  "userId": "user123"
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "userId": "user123",
  "message": "Admin claim set successfully"
}
```

---

### 13. Remove Admin Claim

**Endpoint**: `POST https://us-central1-truepay-72060.cloudfunctions.net/removeAdminClaim`

**Headers**:
```
Content-Type: application/json
Authorization: Bearer {firebase-auth-token}
```

**Request Body**:
```json
{
  "userId": "user123"
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "userId": "user123",
  "message": "Admin claim removed successfully"
}
```

---

## HTTP REST Endpoints

### Base URL
```
https://us-central1-truepay-72060.cloudfunctions.net/api
```

---

### 1. Get Exchange Rates (With Commission)

**Endpoint**: `GET https://us-central1-truepay-72060.cloudfunctions.net/api/binance/rates`

**Query Parameters**:
- `fiat` (optional): Fiat currency code (default: "KES")
- `asset` (optional): Crypto asset code (default: "USDT")

**Example**:
```
GET https://us-central1-truepay-72060.cloudfunctions.net/api/binance/rates?fiat=KES&asset=USDT
```

**Response** (200 OK):
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

---

### 2. Get Binance Rates (Legacy HTTP)

**Endpoint**: `GET https://us-central1-truepay-72060.cloudfunctions.net/fetchBinanceRatesHttp`

**Query Parameters**:
- `fiat` (optional): Fiat currency code (default: "KES")
- `asset` (optional): Crypto asset code (default: "USDT")

**Example**:
```
GET https://us-central1-truepay-72060.cloudfunctions.net/fetchBinanceRatesHttp?fiat=KES&asset=USDT
```

**Response** (200 OK): Same format as `/api/binance/rates`

---

### 3. List Customer Wallets

**Endpoint**: `GET https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets`

**Query Parameters**:
- `limit` (optional): Number of results (default: 100)
- `offset` (optional): Pagination offset (default: 0)

**Example**:
```
GET https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets?limit=50&offset=0
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": [
    {
      "id": "82XqLAxq2udeYzrR89tvrEbYXbB2",
      "customerId": "82XqLAxq2udeYzrR89tvrEbYXbB2",
      "firstName": "John",
      "lastName": "Doe",
      "email": "john@example.com",
      "phone": "+254712345678",
      "cryptoBalance": 0,
      "fiatBalance": 150.0,
      "status": "active",
      "createdAt": "2024-01-01T00:00:00Z",
      "updatedAt": "2024-01-01T00:00:00Z"
    }
  ],
  "pagination": {
    "total": 100,
    "limit": 50,
    "offset": 0,
    "hasMore": true
  }
}
```

---

### 4. Get Customer Wallet by ID

**Endpoint**: `GET https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets/{id}`

**URL Parameters**:
- `id`: Customer wallet ID (Firebase UID)

**Example**:
```
GET https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets/82XqLAxq2udeYzrR89tvrEbYXbB2
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "82XqLAxq2udeYzrR89tvrEbYXbB2",
    "customerId": "82XqLAxq2udeYzrR89tvrEbYXbB2",
    "firstName": "John",
    "lastName": "Doe",
    "email": "john@example.com",
    "phone": "+254712345678",
    "cryptoBalance": 0,
    "fiatBalance": 150.0,
    "status": "active",
    "country": "KE",
    "kycStatus": "approved",
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-01T00:00:00Z"
  }
}
```

---

### 5. Update Customer Wallet

**Endpoint**: `PUT https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets/{id}`

**URL Parameters**:
- `id`: Customer wallet ID

**Headers**:
```
Content-Type: application/json
```

**Request Body**:
```json
{
  "firstName": "John",
  "lastName": "Doe",
  "email": "john@example.com",
  "phone": "+254712345678",
  "status": "active",
  "country": "KE"
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "82XqLAxq2udeYzrR89tvrEbYXbB2",
    "customerId": "82XqLAxq2udeYzrR89tvrEbYXbB2",
    "firstName": "John",
    "lastName": "Doe",
    "email": "john@example.com",
    "phone": "+254712345678",
    "cryptoBalance": 0,
    "fiatBalance": 150.0,
    "status": "active",
    "country": "KE",
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-01T00:00:00Z"
  }
}
```

---

### 6. Credit Wallet

**Endpoint**: `POST https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets/{id}/credit`

**URL Parameters**:
- `id`: Customer wallet ID

**Headers**:
```
Content-Type: application/json
```

**Request Body**:
```json
{
  "amount": 100,
  "description": "Top-up from admin"
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "82XqLAxq2udeYzrR89tvrEbYXbB2",
    "customerId": "82XqLAxq2udeYzrR89tvrEbYXbB2",
    "firstName": "John",
    "lastName": "Doe",
    "email": "john@example.com",
    "phone": "+254712345678",
    "cryptoBalance": 0,
    "fiatBalance": 250.0,
    "status": "active"
  },
  "transaction": {
    "type": "credit",
    "amount": 100,
    "previousBalance": 150.0,
    "newBalance": 250.0
  }
}
```

---

### 7. Debit Wallet

**Endpoint**: `POST https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets/{id}/debit`

**URL Parameters**:
- `id`: Customer wallet ID

**Headers**:
```
Content-Type: application/json
```

**Request Body**:
```json
{
  "amount": 25,
  "description": "Payment for services"
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "82XqLAxq2udeYzrR89tvrEbYXbB2",
    "customerId": "82XqLAxq2udeYzrR89tvrEbYXbB2",
    "firstName": "John",
    "lastName": "Doe",
    "email": "john@example.com",
    "phone": "+254712345678",
    "cryptoBalance": 0,
    "fiatBalance": 225.0,
    "status": "active"
  },
  "transaction": {
    "type": "debit",
    "amount": 25,
    "previousBalance": 250.0,
    "newBalance": 225.0
  }
}
```

**Error Response** (400 Bad Request - Insufficient Balance):
```json
{
  "success": false,
  "error": "Insufficient balance",
  "currentBalance": 50,
  "requestedAmount": 100
}
```

---

### 8. Create Customer Wallet

**Endpoint**: `POST https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets`

**Headers**:
```
Content-Type: application/json
```

**Request Body**:
```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "phone": "+254712345678",
  "initialBalance": 0
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "id": "new_wallet_id",
    "name": "John Doe",
    "email": "john@example.com",
    "phone": "+254712345678",
    "balance": 0,
    "status": "active",
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-01T00:00:00Z"
  }
}
```

**Error Response** (409 Conflict - Email Exists):
```json
{
  "success": false,
  "error": "Customer with this email already exists"
}
```

---

### 9. Get Commission Configuration

**Endpoint**: `GET https://us-central1-truepay-72060.cloudfunctions.net/api/config/fees`

**Headers**:
```
Authorization: Bearer {firebase-auth-token}
```

**Response** (200 OK):
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

---

### 10. Update Commission Configuration

**Endpoint**: `PUT https://us-central1-truepay-72060.cloudfunctions.net/api/config/fees`

**Headers**:
```
Content-Type: application/json
Authorization: Bearer {firebase-auth-token}
```

**Request Body**:
```json
{
  "arbitrageFee": 2.0,
  "serviceFee": 1.5
}
```

**Response** (200 OK):
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

---

## Webhook Endpoints

### IntaSend Top-Up Webhook

**Endpoint**: `POST https://us-central1-truepay-72060.cloudfunctions.net/handleTopUpWebhook`

**Headers**:
```
Content-Type: application/json
x-intasend-signature: {hmac-sha256-signature}
```

**Request Body** (IntaSend Webhook Payload):
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

**Response** (200 OK):
```
OK
```

**Note**: This endpoint is called by IntaSend, not by your application.

---

## Error Responses

### Callable Function Errors

**Error Response Format**:
```json
{
  "error": {
    "code": "unauthenticated",
    "message": "User must be authenticated to create payment",
    "status": "UNAUTHENTICATED"
  }
}
```

**Common Error Codes**:
- `unauthenticated` - User not logged in
- `permission-denied` - Insufficient permissions (e.g., not an admin)
- `invalid-argument` - Invalid request parameters
- `not-found` - Resource not found
- `internal` - Server error

### HTTP REST Errors

**Error Response Format**:
```json
{
  "success": false,
  "error": "Error message",
  "message": "Detailed error message"
}
```

**HTTP Status Codes**:
- `200` - Success
- `400` - Bad Request (invalid parameters)
- `401` - Unauthorized
- `403` - Forbidden
- `404` - Not Found
- `409` - Conflict (e.g., email already exists)
- `500` - Internal Server Error

---

## Postman Collection Setup

### Environment Variables

Create a Postman environment with these variables:

```
firebase_auth_token: {your-firebase-auth-token}
base_url: https://us-central1-truepay-72060.cloudfunctions.net
api_base_url: https://us-central1-truepay-72060.cloudfunctions.net/api
project_id: truepay-72060
region: us-central1
```

### Pre-request Script (for Callable Functions)

For callable functions, you can use this pre-request script to automatically set the auth token:

```javascript
pm.request.headers.add({
    key: 'Authorization',
    value: 'Bearer ' + pm.environment.get('firebase_auth_token')
});
```

### Example Request Collection Structure

```
TruePay API
├── Callable Functions
│   ├── Rates
│   │   ├── Get Binance Rates
│   │   └── Get Arbitrage Rates
│   ├── Payments
│   │   └── Create Payment
│   └── Admin
│       ├── Update User Profile
│       ├── Update User Balance
│       ├── Get User Data
│       ├── Update KYC Status
│       ├── Get Commission Config
│       ├── Update Commission Config
│       └── Get IntaSend Payment Status
├── REST API
│   ├── Rates
│   │   └── Get Exchange Rates
│   └── Customer Wallets
│       ├── List Wallets
│       ├── Get Wallet by ID
│       ├── Update Wallet
│       ├── Credit Wallet
│       ├── Debit Wallet
│       └── Create Wallet
└── Webhooks
    └── IntaSend Top-Up Webhook
```

---

## Testing Tips

1. **Get Firebase Auth Token**:
   - Use Firebase Admin SDK to generate a token, or
   - Get token from your Flutter/Web app's Firebase Auth instance
   - Token expires after 1 hour, refresh as needed

2. **Admin Functions**:
   - User must have `admin: true` in their Firebase Auth custom claims
   - Use `setAdminClaim` function to grant admin access

3. **Testing Webhooks**:
   - Use tools like ngrok to expose local server
   - Or use Postman's webhook testing features

4. **Error Handling**:
   - Check response status codes
   - Parse error messages from response body
   - Handle authentication errors by refreshing tokens

---

**Last Updated**: 2025-01-08

