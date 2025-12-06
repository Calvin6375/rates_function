# Commission Management Implementation

## Overview

Admin commission management has been implemented to allow your admin dashboard to view and update commission rates for both arbitrage and service fees.

---

## ✅ What Was Implemented

### 1. Callable Functions (Firebase Callable)

#### `getCommissionConfig`
- **Type**: Callable Function
- **Authentication**: Required (Admin only)
- **Purpose**: Get current commission/fee settings

#### `updateCommissionConfig`
- **Type**: Callable Function
- **Authentication**: Required (Admin only)
- **Purpose**: Update commission/fee settings

### 2. REST API Endpoints

#### `GET /api/config/fees`
- **Authentication**: Required (Admin only - Bearer token)
- **Purpose**: Get current commission configuration

#### `PUT /api/config/fees`
- **Authentication**: Required (Admin only - Bearer token)
- **Purpose**: Update commission configuration

---

## API Documentation

### Callable Function: Get Commission Config

**Function Name**: `getCommissionConfig`

**Authentication**: Required (Admin only)

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
  message?: string;             // Optional message
}
```

**Example - Flutter**:
```dart
final functions = FirebaseFunctions.instance;
final getCommissionConfig = functions.httpsCallable('getCommissionConfig');

try {
  final result = await getCommissionConfig.call();
  final config = result.data['config'];
  print('Arbitrage Fee: ${config['arbitrageFee']}%');
  print('Service Fee: ${config['serviceFee']}%');
} catch (e) {
  print('Error: $e');
}
```

**Example - Web/React**:
```javascript
import { getFunctions, httpsCallable } from 'firebase/functions';

const functions = getFunctions();
const getCommissionConfig = httpsCallable(functions, 'getCommissionConfig');

try {
  const result = await getCommissionConfig();
  console.log('Arbitrage Fee:', result.data.config.arbitrageFee + '%');
  console.log('Service Fee:', result.data.config.serviceFee + '%');
} catch (error) {
  console.error('Error:', error.message);
}
```

---

### Callable Function: Update Commission Config

**Function Name**: `updateCommissionConfig`

**Authentication**: Required (Admin only)

**Request Body**:
```typescript
{
  arbitrageFee?: number;  // Optional: Arbitrage fee percentage (e.g., 1.5 for 1.5%)
  serviceFee?: number;    // Optional: Service fee percentage (e.g., 1.5 for 1.5%)
}
```

**Note**: At least one fee must be provided. You can update both or just one.

**Response**:
```typescript
{
  success: boolean;
  config: {
    arbitrageFee: number;
    serviceFee: number;
    updatedAt: number;    // Timestamp in milliseconds
    updatedBy: string;    // Admin user ID who made the update
  };
  message: string;
}
```

**Example - Flutter**:
```dart
final updateCommissionConfig = functions.httpsCallable('updateCommissionConfig');

try {
  final result = await updateCommissionConfig.call({
    'arbitrageFee': 2.0,  // Set to 2%
    'serviceFee': 1.5,    // Keep service fee at 1.5%
  });
  
  print('Success: ${result.data['message']}');
  print('New Arbitrage Fee: ${result.data['config']['arbitrageFee']}%');
} catch (e) {
  print('Error: $e');
}
```

**Example - Web/React**:
```javascript
const updateCommissionConfig = httpsCallable(functions, 'updateCommissionConfig');

try {
  const result = await updateCommissionConfig({
    arbitrageFee: 2.0,  // Set to 2%
    serviceFee: 1.5,    // Keep service fee at 1.5%
  });
  
  console.log('Success:', result.data.message);
  console.log('New Arbitrage Fee:', result.data.config.arbitrageFee + '%');
} catch (error) {
  console.error('Error:', error.message);
}
```

---

### REST API: Get Commission Config

**Endpoint**: `GET /api/config/fees`

**Authentication**: Required (Bearer token in Authorization header)

**Headers**:
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

**Example - JavaScript**:
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

### REST API: Update Commission Config

**Endpoint**: `PUT /api/config/fees`

**Authentication**: Required (Bearer token in Authorization header)

**Request Body**:
```json
{
  "arbitrageFee": 2.0,
  "serviceFee": 1.5
}
```

**Note**: Both fields are optional, but at least one must be provided.

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

**Example - JavaScript**:
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

**Error Responses**:
- `400 Bad Request` - Invalid fee values (must be 0-100)
- `401 Unauthorized` - Not authenticated
- `403 Forbidden` - Not an admin user
- `500 Internal Server Error` - Server error

---

## How It Works

### 1. Commission Storage

Commission is stored in Firestore:
```
config/
  fees/
    arbitrageFee: 1.5      // Percentage (1.5 = 1.5%)
    serviceFee: 1.5        // Percentage (1.5 = 1.5%)
    updatedAt: Timestamp
    updatedBy: "admin-id"
```

### 2. Commission Usage

When arbitrage rates are calculated:
1. System reads `arbitrageFee` from `config/fees`
2. Applies commission to calculate customer payout
3. Stores final rates in Firestore and Realtime DB

### 3. Cache Invalidation

**Important**: After updating commission:
- Fee cache is automatically reset on next rate calculation
- Changes take effect immediately for new calculations
- Existing cached rates continue using old commission until they expire (5-10 minutes)

### 4. Immediate Effect

To ensure changes take effect immediately:
1. Update commission via admin dashboard
2. Optionally trigger a fresh rate calculation
3. New rates will use the updated commission

---

## Implementation Details

### Files Modified

1. **`functions/adminActions.js`**
   - Added `getCommissionConfig` callable function
   - Added `updateCommissionConfig` callable function

2. **`functions/customerWallets.js`**
   - Added `GET /api/config/fees` REST endpoint
   - Added `PUT /api/config/fees` REST endpoint
   - Added `verifyAdminFromRequest` helper function

3. **`functions/index.js`**
   - Exported new commission management functions

4. **`functions/utils/validation.js`**
   - Updated `isAdmin` function to check both `role === "admin"` and `isAdmin === true`

### Security

- ✅ Admin-only access (verified via Firebase Auth)
- ✅ Validates fee values (0-100 range)
- ✅ Logs all commission updates to admin logs
- ✅ Tracks who updated commission (`updatedBy` field)

---

## Testing

### Test Get Commission Config

**Callable Function**:
```javascript
const result = await getCommissionConfig();
console.log(result.data.config);
```

**REST API**:
```bash
curl -H "Authorization: Bearer {token}" \
  https://us-central1-truepay-72060.cloudfunctions.net/api/config/fees
```

### Test Update Commission Config

**Callable Function**:
```javascript
const result = await updateCommissionConfig({
  arbitrageFee: 2.0
});
console.log(result.data.message);
```

**REST API**:
```bash
curl -X PUT \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{"arbitrageFee": 2.0}' \
  https://us-central1-truepay-72060.cloudfunctions.net/api/config/fees
```

---

## Next Steps

1. ✅ **Deploy the functions**:
   ```bash
   firebase deploy --only functions:getCommissionConfig,functions:updateCommissionConfig,functions:api
   ```

2. ✅ **Test the endpoints** - Verify admin can get and update commission

3. ✅ **Update admin dashboard** - Add UI to:
   - Display current commission rates
   - Form to update commission
   - Show confirmation messages

4. ✅ **Verify changes take effect** - Check that new rate calculations use updated commission

---

## Important Notes

### Fee Format
- Fees are stored as **percentages** (e.g., `1.5` = 1.5%)
- In code, they're converted to decimals (divided by 100)
- When displaying to users, show as percentage

### Commission Impact
- **Arbitrage Fee**: Applied to arbitrage rate calculations
- **Service Fee**: Applied to regular Binance rate calculations
- Changes affect new calculations immediately
- Existing cached rates expire after 5-10 minutes

### Default Values
- If config document doesn't exist, defaults to **1.5%** for both fees
- Default values are used as fallback

---

**Last Updated**: 2025-01-04

