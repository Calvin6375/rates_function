# Dashboard API Endpoints Configuration

## Base URL Configuration

### Production (After Deployment)
```
https://us-central1-truepay-72060.cloudfunctions.net/api
```

**Note:** Replace `us-central1` with your actual region if different. Check deployment output for exact URL.

### Development (Local Emulator)
```
http://localhost:8080/api
```

### Environment Variable Setup
```javascript
// .env file
REACT_APP_API_BASE_URL=https://us-central1-truepay-72060.cloudfunctions.net/api
// or for local development:
// REACT_APP_API_BASE_URL=http://localhost:8080/api
```

---

## Complete Endpoint List

### 1. List All Customer Wallets
**Endpoint:** `GET /customer-wallets`

**Full URL:**
- Production: `https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets`
- Local: `http://localhost:8080/api/customer-wallets`

**Query Parameters:**
- `limit` (optional, default: 100) - Number of records to return
- `offset` (optional, default: 0) - Number of records to skip

**Example Request:**
```javascript
GET /api/customer-wallets?limit=100&offset=0
```

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

---

### 2. Get Single Customer Wallet
**Endpoint:** `GET /customer-wallets/:id`

**Full URL:**
- Production: `https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets/{id}`
- Local: `http://localhost:8080/api/customer-wallets/{id}`

**Example Request:**
```javascript
GET /api/customer-wallets/wallet123
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

---

### 3. Create New Customer Wallet
**Endpoint:** `POST /customer-wallets`

**Full URL:**
- Production: `https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets`
- Local: `http://localhost:8080/api/customer-wallets`

**Request Body:**
```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "phone": "+1234567890",
  "initialBalance": 0
}
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

---

### 4. Update Customer Wallet
**Endpoint:** `PUT /customer-wallets/:id`

**Full URL:**
- Production: `https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets/{id}`
- Local: `http://localhost:8080/api/customer-wallets/{id}`

**Request Body:**
```json
{
  "name": "John Updated",
  "phone": "+9876543210",
  "status": "active"
}
```

**Note:** Cannot update `balance`, `id`, `createdAt` through this endpoint. Use credit/debit endpoints for balance changes.

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

---

### 5. Credit Money to Wallet
**Endpoint:** `POST /customer-wallets/:id/credit`

**Full URL:**
- Production: `https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets/{id}/credit`
- Local: `http://localhost:8080/api/customer-wallets/{id}/credit`

**Request Body:**
```json
{
  "amount": 100,
  "description": "Top up payment"
}
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
    "phone": "+1234567890",
    "balance": 1100.50,
    "status": "active",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T01:00:00.000Z"
  },
  "transaction": {
    "type": "credit",
    "amount": 100,
    "previousBalance": 1000.50,
    "newBalance": 1100.50
  }
}
```

---

### 6. Debit Money from Wallet
**Endpoint:** `POST /customer-wallets/:id/debit`

**Full URL:**
- Production: `https://us-central1-truepay-72060.cloudfunctions.net/api/customer-wallets/{id}/debit`
- Local: `http://localhost:8080/api/customer-wallets/{id}/debit`

**Request Body:**
```json
{
  "amount": 50,
  "description": "Payment for service"
}
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
    "phone": "+1234567890",
    "balance": 1050.50,
    "status": "active",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T01:00:00.000Z"
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

---

## Error Responses

All endpoints may return these error formats:

### 400 Bad Request
```json
{
  "success": false,
  "error": "Invalid amount. Amount must be a positive number."
}
```

### 404 Not Found
```json
{
  "success": false,
  "error": "Customer wallet not found"
}
```

### 409 Conflict
```json
{
  "success": false,
  "error": "Customer with this email already exists"
}
```

### 500 Internal Server Error
```json
{
  "success": false,
  "error": "Failed to fetch customer wallets",
  "message": "Error details here"
}
```

---

## Frontend Configuration Examples

### React/JavaScript Example
```javascript
// config/api.js
const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || 'http://localhost:8080/api';

export const API_ENDPOINTS = {
  // Customer Wallets
  CUSTOMER_WALLETS: {
    LIST: `${API_BASE_URL}/customer-wallets`,
    GET: (id) => `${API_BASE_URL}/customer-wallets/${id}`,
    CREATE: `${API_BASE_URL}/customer-wallets`,
    UPDATE: (id) => `${API_BASE_URL}/customer-wallets/${id}`,
    CREDIT: (id) => `${API_BASE_URL}/customer-wallets/${id}/credit`,
    DEBIT: (id) => `${API_BASE_URL}/customer-wallets/${id}/debit`,
  },
};

// Usage example
import { API_ENDPOINTS } from './config/api';

// List wallets
const response = await fetch(`${API_ENDPOINTS.CUSTOMER_WALLETS.LIST}?limit=100`);
const data = await response.json();

// Create wallet
const newWallet = await fetch(API_ENDPOINTS.CUSTOMER_WALLETS.CREATE, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'John Doe',
    email: 'john@example.com',
    phone: '+1234567890',
  }),
});

// Credit wallet
const credit = await fetch(API_ENDPOINTS.CUSTOMER_WALLETS.CREDIT('wallet123'), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    amount: 100,
    description: 'Top up',
  }),
});
```

### Axios Example
```javascript
// api/client.js
import axios from 'axios';

const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || 'http://localhost:8080/api';

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Customer Wallets API
export const customerWalletsAPI = {
  // List all wallets
  list: (params = {}) => 
    apiClient.get('/customer-wallets', { params }),

  // Get single wallet
  get: (id) => 
    apiClient.get(`/customer-wallets/${id}`),

  // Create wallet
  create: (data) => 
    apiClient.post('/customer-wallets', data),

  // Update wallet
  update: (id, data) => 
    apiClient.put(`/customer-wallets/${id}`, data),

  // Credit wallet
  credit: (id, amount, description) => 
    apiClient.post(`/customer-wallets/${id}/credit`, { amount, description }),

  // Debit wallet
  debit: (id, amount, description) => 
    apiClient.post(`/customer-wallets/${id}/debit`, { amount, description }),
};

// Usage
import { customerWalletsAPI } from './api/client';

// List wallets
const wallets = await customerWalletsAPI.list({ limit: 100 });

// Create wallet
const newWallet = await customerWalletsAPI.create({
  name: 'John Doe',
  email: 'john@example.com',
});

// Credit
await customerWalletsAPI.credit('wallet123', 100, 'Top up');
```

---

## Quick Reference Table

| Method | Endpoint | Purpose | Auth Required |
|--------|----------|---------|---------------|
| GET | `/customer-wallets` | List all wallets | No |
| GET | `/customer-wallets/:id` | Get single wallet | No |
| POST | `/customer-wallets` | Create wallet | No |
| PUT | `/customer-wallets/:id` | Update wallet | No |
| POST | `/customer-wallets/:id/credit` | Credit money | No |
| POST | `/customer-wallets/:id/debit` | Debit money | No |

---

## CORS Configuration

CORS is already enabled for all endpoints. The API accepts requests from any origin (`Access-Control-Allow-Origin: *`).

---

## Testing Checklist

After deployment, test these endpoints in order:

- [ ] `GET /customer-wallets` - Should return empty array or existing wallets
- [ ] `POST /customer-wallets` - Create a test wallet
- [ ] `GET /customer-wallets/:id` - Get the created wallet
- [ ] `PUT /customer-wallets/:id` - Update wallet details
- [ ] `POST /customer-wallets/:id/credit` - Credit money
- [ ] `POST /customer-wallets/:id/debit` - Debit money
- [ ] Test error cases (404, 400, insufficient balance)

---

## Notes

1. **Base URL**: After deployment, replace `us-central1` with your actual region
2. **Local Development**: Use `http://localhost:8080/api` when running Firebase emulator
3. **Authentication**: Currently no authentication required. Add Firebase Auth middleware for production
4. **Rate Limiting**: Consider adding rate limiting for production use
5. **Transactions**: All credit/debit operations are logged in `walletTransactions` collection

