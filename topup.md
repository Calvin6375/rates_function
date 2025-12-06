# Top-Up Payment Flow Documentation

This document describes the complete top-up payment flow from initiation to balance update in the TruePay system.

## Overview

The top-up process uses IntaSend as the payment gateway and follows this flow:
1. **Initiation**: Client creates payment order via `createPayment` Cloud Function
2. **Payment**: User completes payment on IntaSend
3. **Callback**: IntaSend sends webhook to `handleTopUpWebhook`
4. **Balance Update**: System updates user balance in Firestore and syncs to Realtime DB

## Key Implementation Details

### Phone Number as Primary Identifier

**Why**: IntaSend webhook payloads always include the `account` field (phone number), making it the most reliable identifier for user lookup.

**Implementation**:
- Phone number lookup is now **Strategy 1** (PRIMARY) in webhook handler
- Phone number is stored in order documents and RTDB mappings
- Multiple phone format variations are checked (with/without + prefix, different field names)

### Payment State Validation

**Per [IntaSend Documentation](https://developers.intasend.com/docs/payment-collection-events)**: Webhooks are sent for all state changes (PENDING, PROCESSING, COMPLETE, FAILED).

**Implementation**:
- Only process payments when `state === "COMPLETE"`
- Return early (200 OK) for other states to prevent premature balance credits
- This ensures wallet is only credited for successful payments

### Duplicate Prevention

**Implementation**:
- Check `/payments/{invoice_id}` in RTDB before processing
- Skip if payment already processed for the same user
- Prevents duplicate balance credits from webhook retries

---

## Flow Diagram

```
┌─────────────┐
│   Client    │
│  (Flutter)  │
└──────┬──────┘
       │
       │ 1. Create IntaSend Checkout
       │    POST https://payment.intasend.com/api/v1/checkout/
       │
       ▼
┌─────────────────────┐
│   IntaSend API      │
│  (External)         │
└──────┬──────────────┘
       │
       │ 2. Returns checkout URL
       │    https://payment.intasend.com/checkout/{invoice-id}/express/
       │
       ▼
┌─────────────┐
│   Client    │
│  (Flutter)  │
└──────┬──────┘
       │
       │ 3. Call createPayment Cloud Function
       │    { amount, currency, checkoutUrl }
       │
       ▼
┌─────────────────────────────────────┐
│  createPayment (Cloud Function)     │
│  functions/payments.js              │
└──────┬──────────────────────────────┘
       │
       │ 4a. Create Order in Firestore
       │     /orders/{orderId}
       │
       │ 4b. Create Mapping in RTDB
       │     /wallet/pendingTopups/{invoiceId}
       │
       ▼
┌─────────────┐
│   Client    │
│  (Flutter)  │
└──────┬──────┘
       │
       │ 5. Redirect user to IntaSend checkout URL
       │
       ▼
┌─────────────────────┐
│   IntaSend          │
│  (Payment Gateway)  │
└──────┬──────────────┘
       │
       │ 6. User completes payment
       │
       │ 7. IntaSend sends webhook callback
       │    POST /handleTopUpWebhook
       │
       ▼
┌─────────────────────────────────────┐
│  handleTopUpWebhook (Cloud Function)│
│  functions/payments.js               │
└──────┬──────────────────────────────┘
       │
       │ 8a. Validate webhook signature
       │
       │ 8b. Resolve user ID from invoice ID
       │     (Order lookup → RTDB mapping → Phone lookup)
       │
       │ 8c. Update balance in Firestore
       │     (Atomic transaction)
       │
       │ 8d. Sync balance to Realtime DB
       │
       │ 8e. Update lastTopUp timestamp
       │
       ▼
┌─────────────────────┐
│   Databases         │
│  - Firestore        │
│  - Realtime DB      │
└─────────────────────┘
```

---

## Step-by-Step Process

### Phase 1: Payment Initiation

#### Step 1: Client Creates IntaSend Checkout Session

**Location**: Flutter App (Client-side)

**Action**: Client makes API call to IntaSend to create checkout session

```dart
// Flutter code (example)
POST https://payment.intasend.com/api/v1/checkout/
{
  "public_key": "...",
  "amount": 1250.0,
  "currency": "KES",
  "email": "user@example.com",
  "name": "User Name"
}
```

**Response**: IntaSend returns checkout URL
```
https://payment.intasend.com/checkout/{invoice-id}/express/
```

**Invoice ID**: Extracted from URL (e.g., `cbb13af1-ca53-4a04-9e94-08a8eb58d210`)

---

#### Step 2: Client Calls createPayment Cloud Function

**Location**: `functions/payments.js` - `createPayment` function

**Type**: Firebase Callable Function (v2)

**Endpoint**: `createPayment`

**Request Parameters**:
```javascript
{
  amount: 1250.0,           // Required: Payment amount
  currency: "KES",          // Required: Currency code
  checkoutUrl: "...",       // Optional: IntaSend checkout URL
  invoiceId: "...",        // Optional: Invoice ID (extracted from URL if not provided)
  phoneNumber: "254712345678", // Optional: User's phone number (for webhook lookup)
  metadata: {}              // Optional: Additional metadata
}
```

**Note**: If `phoneNumber` is not provided, the function will attempt to fetch it from the user's Firestore document.

**Authentication**: Required (Firebase Auth token)

**Process**:

1. **Validate Request**:
   - Check user authentication
   - Validate amount (must be positive)
   - Validate currency

2. **Extract Invoice ID**:
   - If `invoiceId` provided → use it
   - If `checkoutUrl` provided → extract from URL pattern: `/checkout/([^\/]+)/`
   - Throw error if neither provided

3. **Get User Phone Number**:
   - If `phoneNumber` provided in request → use it
   - Otherwise, fetch from Firestore user document (`phoneNumber` or `phone` field)
   - Store phone number for webhook lookup

4. **Create Order Document in Firestore**:
   ```javascript
   /orders/{orderId}
   {
     userId: "user-uid",
     orderType: "topup",
     status: "pending",
     amount: 1250.0,
     currency: "KES",
     invoiceId: "cbb13af1-ca53-4a04-9e94-08a8eb58d210",
     phoneNumber: "254712345678",  // Stored for webhook lookup
     metadata: {
       invoiceId: "cbb13af1-ca53-4a04-9e94-08a8eb58d210",
       paymentId: "cbb13af1-ca53-4a04-9e94-08a8eb58d210",
       checkoutUrl: "https://payment.intasend.com/checkout/...",
       phoneNumber: "254712345678",  // Included in metadata too
       createdAt: "2025-12-06T12:43:53.000Z"
     },
     createdAt: ServerTimestamp,
     updatedAt: ServerTimestamp
   }
   ```

5. **Create Invoice Mapping in Realtime Database**:
   ```javascript
   /wallet/pendingTopups/{invoiceId}
   {
     userId: "user-uid",
     orderId: "z5QUPdKSnoOkPdk9cobh",
     amount: 1250.0,
     currency: "KES",
     phoneNumber: "254712345678",  // Stored for webhook lookup
     createdAt: "2025-12-06T12:43:53.000Z"
   }
   ```

   **Also Create Phone-to-Invoice Mapping**:
   ```javascript
   /wallet/phoneToInvoice/{phoneNumber}/{invoiceId}
   {
     userId: "user-uid",
     orderId: "z5QUPdKSnoOkPdk9cobh",
     invoiceId: "cbb13af1-ca53-4a04-9e94-08a8eb58d210",
     amount: 1250.0,
     currency: "KES",
     createdAt: "2025-12-06T12:43:53.000Z"
   }
   ```

   **Purpose**: These mappings allow the webhook handler to quickly resolve which user should receive the credit when IntaSend sends the callback. Phone number mapping provides the most reliable lookup method.

5. **Return Response**:
   ```javascript
   {
     success: true,
     orderId: "z5QUPdKSnoOkPdk9cobh",
     invoiceId: "cbb13af1-ca53-4a04-9e94-08a8eb58d210",
     paymentId: "cbb13af1-ca53-4a04-9e94-08a8eb58d210",
     amount: 1250.0,
     currency: "KES",
     status: "pending",
     checkoutUrl: "https://payment.intasend.com/checkout/...",
     createdAt: "2025-12-06T12:43:53.635Z"
   }
   ```

**Files Involved**:
- `functions/payments.js` (lines 479-611)
- `functions/index.js` (exports)

---

### Phase 2: Payment Processing

#### Step 3: User Completes Payment on IntaSend

**Location**: IntaSend Payment Gateway (External)

**Action**: User is redirected to IntaSend checkout URL and completes payment using their preferred method (M-Pesa, Airtel Money, etc.)

**Status**: Payment is processed by IntaSend

---

### Phase 3: Webhook Callback

#### Step 4: IntaSend Sends Webhook Callback

**Location**: `functions/payments.js` - `handleTopUpWebhook` function

**Type**: HTTP Request Function (v2)

**Endpoint**: `handleTopUpWebhook`

**Method**: POST

**URL**: `https://us-central1-{project-id}.cloudfunctions.net/handleTopUpWebhook`

**Request Headers**:
```
Content-Type: application/json
x-intasend-signature: {hex-encoded-hmac-sha256}
x-intasend-challenge: {optional-challenge-token}
```

**Request Body** (IntaSend Invoice Format - per [IntaSend documentation](https://developers.intasend.com/docs/payment-collection-events)):
```javascript
{
  "invoice_id": "04G2M53",
  "state": "COMPLETE",              // PENDING, PROCESSING, COMPLETE, or FAILED
  "provider": "M-PESA",
  "charges": "0.33",
  "net_amount": "10.66",            // Amount after fees
  "currency": "KES",
  "value": "11.00",                 // Original amount
  "account": "254742844875",         // Phone number (always provided)
  "api_ref": "",
  "clearing_status": "AVAILABLE",
  "mpesa_reference": null,
  "host": "127.0.0.1",
  "card_info": {
    "bin_country": null,
    "card_type": null
  },
  "retry_count": 0,
  "failed_reason": null,
  "failed_code": null,
  "failed_code_link": null,
  "created_at": "2025-12-06T13:01:28.895603+03:00",
  "updated_at": "2025-12-06T13:01:45.530232+03:00"
}
```

**Key Fields**:
- `invoice_id`: Unique payment identifier
- `state`: Payment state (only process if "COMPLETE")
- `account`: Phone number (always provided, used for user lookup)
- `net_amount`: Amount to credit (after fees)
- `currency`: Payment currency

**Process**:

1. **Validate Request**:
   - Check HTTP method (must be POST)
   - Verify webhook signature using HMAC-SHA256
   - OR verify challenge token (if configured)
   - Reject if neither signature nor challenge is valid

2. **Parse Payment Data**:
   - Extract `invoice_id` as `paymentId`
   - Extract `state` field (PENDING, PROCESSING, COMPLETE, FAILED)
   - Extract `net_amount` or `value` as `amount`
   - Extract `currency`
   - Extract `account` (phone number) - **This is the primary identifier**
   - Extract `metadata.user_id` if present
   - Extract `updated_at` or `created_at` as `completedAt`

3. **Check Payment State**:
   - **Only process if `state === "COMPLETE"`**
   - Return early (200 OK) for PENDING, PROCESSING, or FAILED states
   - This prevents crediting wallet for incomplete or failed payments

3. **Check Payment State**:
   - Extract `state` field from payload
   - **Only process if `state === "COMPLETE"** (per [IntaSend documentation](https://developers.intasend.com/docs/payment-collection-events))
   - Return early for PENDING, PROCESSING, or FAILED states
   - This prevents crediting wallet for incomplete payments

4. **Resolve User ID** (Multi-Strategy Lookup - Phone Number is PRIMARY):

   **Strategy 1: Phone Number Lookup (PRIMARY - Most Reliable)**
   - IntaSend always provides `account` field (phone number) in webhook payload
   - Query Firestore `users` collection with multiple phone format variations:
     - `phoneNumber == account` (normalized, with/without + prefix)
     - `phone == account` (normalized, with/without + prefix)
     - Try direct document ID match (if phone is used as doc ID)
   - Use document ID as `userId` (Firebase UID)
   - **Success Rate**: Very High (phone number is always in webhook)
   - **Why Primary**: Phone number is the most reliable identifier from IntaSend

   **Strategy 2: Order Lookup by Invoice ID (Secondary)**
   - Query Firestore `orders` collection:
     - `metadata.paymentId == invoice_id` AND `orderType == "topup"`
     - OR `metadata.invoiceId == invoice_id` AND `orderType == "topup"`
     - OR `invoiceId == invoice_id` AND `orderType == "topup"`
   - Extract `userId` from order document
   - Verify phone number matches if available (additional validation)
   - **Success Rate**: High (if order was created properly)

   **Strategy 3: RTDB Mapping Lookup (Fallback)**
   - Read from Realtime DB: `/wallet/pendingTopups/{invoice_id}`
   - Extract `userId` from mapping
   - Delete mapping after use (cleanup)
   - **Success Rate**: High (if mapping was created)

   **Strategy 4: Metadata User ID (If Provided)**
   - Use `metadata.user_id` from IntaSend payload
   - **Success Rate**: Medium (depends on client implementation)

4. **Handle Missing User ID**:
   - If user ID cannot be resolved:
     - Record payment in RTDB: `/payments/{invoice_id}`
     - Return 200 OK (don't fail webhook)
     - Log warning for manual reconciliation

6. **Check for Duplicate Processing**:
   - Check RTDB: `/payments/{invoice_id}`
   - If payment already processed for this user → return 200 OK (skip)
   - Prevents duplicate balance credits

7. **Update Balance** (if user ID resolved):

   **Step 5a: Update Firestore Balance (Master Source)**
   - Location: `functions/utils/firestore.js` - `updateBalanceWithTransaction`
   - Process:
     ```javascript
     // Atomic Firestore transaction
     firestore.runTransaction(async (transaction) => {
       // 1. Read current user document
       const userDoc = await transaction.get(userRef);
       const currentBalance = Number(userData.balance || 0);
       
       // 2. Calculate new balance
       const newBalance = currentBalance + amount; // amount is positive (credit)
       
       // 3. Prevent negative balance (unless allowed)
       if (newBalance < 0 && !metadata.allowNegative) {
         throw new Error("Insufficient balance");
       }
       
       // 4. Update balance atomically
       transaction.update(userRef, {
         balance: newBalance,
         updatedAt: ServerTimestamp
       });
       
       return { previousBalance, newBalance };
     });
     ```
   - **Atomicity**: Ensures no race conditions
   - **Path**: `/users/{userId}` → `balance` field

   **Step 5b: Log Transaction**
   - Location: `functions/utils/transactions.js` - `logTransaction`
   - Creates transaction record in Firestore:
     ```javascript
     /transactions/{transactionId}
     {
       userId: "user-uid",
       type: "topup",
       amount: 1250.0,
       status: "completed",
       previousBalance: 12.0,
       newBalance: 1262.0,
       metadata: {
         paymentId: "cbb13af1-ca53-4a04-9e94-08a8eb58d210",
         currency: "KES",
         completedAt: "2025-12-06T12:44:00.000Z",
         source: "intasend"
       },
       createdAt: ServerTimestamp
     }
     ```

   **Step 5c: Sync Balance to Realtime Database**
   - Location: `functions/utils/realtime.js` - `syncBalanceToRealtime`
   - Process:
     ```javascript
     // Write to wallet/{userId}/fiat/{currency}
     /wallet/{userId}/fiat/{currency}
     {
       balance: 1262.0,
       currency: "KES",
       createdAt: Timestamp,  // Preserved if exists
       updatedAt: ServerTimestamp
     }
     ```
   - **Purpose**: Provides real-time balance updates to Flutter app
   - **Cleanup**: Removes old balance paths if they exist

   **Step 5c: Update Order Status**
   - Update Firestore order document:
     ```javascript
     /orders/{orderId}
     {
       status: "completed",
       updatedAt: ServerTimestamp
     }
     ```
   - Find order by `invoiceId` field or `metadata.invoiceId`

   **Step 5d: Update lastTopUp Timestamp**
   - Update Firestore user document:
     ```javascript
     /users/{userId}
     {
       lastTopUp: Timestamp.fromDate(completedAt)
     }
     ```

6. **Record Payment Globally**:
   - Save payment record in RTDB:
     ```javascript
     /payments/{invoice_id}
     {
       ...payload,  // Full IntaSend payload
       user_id: "user-uid",
       processed_at: "2025-12-06T12:44:01.000Z"
     }
     ```

7. **Return Response**:
   - Success: `200 OK` with message "OK"
   - Error: `500 Internal Server Error` with error details

**Files Involved**:
- `functions/payments.js` (lines 67-466)
- `functions/utils/firestore.js` (lines 15-87)
- `functions/utils/realtime.js` (lines 12-74)
- `functions/utils/transactions.js` (transaction logging)

---

## Database Structures

### Firestore Collections

#### `/orders/{orderId}`
```javascript
{
  userId: "user-uid",                    // Firebase Auth UID
  orderType: "topup",                    // Order type
  status: "pending",                      // Order status (updated to "completed" after webhook)
  amount: 1250.0,                         // Payment amount
  currency: "KES",                        // Currency code
  invoiceId: "cbb13af1-...",             // IntaSend invoice ID
  phoneNumber: "254712345678",            // User's phone number (for webhook lookup)
  metadata: {
    invoiceId: "cbb13af1-...",
    paymentId: "cbb13af1-...",
    checkoutUrl: "https://...",
    phoneNumber: "254712345678",          // Included in metadata too
    createdAt: "2025-12-06T12:43:53.000Z"
  },
  createdAt: Timestamp,
  updatedAt: Timestamp
}
```

#### `/users/{userId}`
```javascript
{
  balance: 1262.0,                       // Current balance (master source)
  lastTopUp: Timestamp,                  // Last top-up timestamp
  // ... other user fields
}
```

#### `/transactions/{transactionId}`
```javascript
{
  userId: "user-uid",
  type: "topup",                         // Transaction type
  amount: 1250.0,                        // Transaction amount
  status: "completed",                   // Transaction status
  previousBalance: 12.0,                // Balance before transaction
  newBalance: 1262.0,                    // Balance after transaction
  metadata: {
    paymentId: "cbb13af1-...",
    currency: "KES",
    completedAt: "2025-12-06T12:44:00.000Z",
    source: "intasend",
    account: "254712345678"                // Phone number from webhook
  },
  createdAt: Timestamp
}
```

### Realtime Database Structure

#### `/wallet/pendingTopups/{invoiceId}`
```javascript
{
  userId: "user-uid",
  orderId: "z5QUPdKSnoOkPdk9cobh",
  amount: 1250.0,
  currency: "KES",
  phoneNumber: "254712345678",            // Phone number for webhook lookup
  createdAt: "2025-12-06T12:43:53.000Z"
}
```
**Note**: This mapping is deleted after webhook processing (cleanup).

#### `/wallet/phoneToInvoice/{phoneNumber}/{invoiceId}`
```javascript
{
  userId: "user-uid",
  orderId: "z5QUPdKSnoOkPdk9cobh",
  invoiceId: "cbb13af1-...",
  amount: 1250.0,
  currency: "KES",
  createdAt: "2025-12-06T12:43:53.000Z"
}
```
**Purpose**: Additional mapping for phone number-based lookup (backup strategy).

#### `/wallet/{userId}/fiat/{currency}`
```javascript
{
  balance: 1262.0,                       // Current balance (cached)
  currency: "KES",                       // Currency code
  createdAt: Timestamp,                  // First balance creation
  updatedAt: Timestamp                   // Last balance update
}
```
**Purpose**: Real-time balance mirror for Flutter app

#### `/payments/{invoiceId}`
```javascript
{
  invoice_id: "cbb13af1-...",
  state: "COMPLETE",
  net_amount: "1250.00",
  currency: "KES",
  account: "254712345678",
  user_id: "user-uid",                   // Added by webhook
  processed_at: "2025-12-06T12:44:01.000Z",
  // ... other IntaSend payload fields
}
```

---

## Security

### Webhook Authentication

1. **HMAC Signature Verification**:
   - IntaSend signs webhook payloads with shared secret
   - Signature in header: `x-intasend-signature` (hex-encoded HMAC-SHA256)
   - Function verifies signature using `INTASEND_SECRET` (Firebase Secret)

2. **Challenge Token Verification**:
   - Alternative authentication method
   - Challenge token in header: `x-intasend-challenge`
   - Function verifies against `INTASEND_CHALLENGE` (Firebase Secret)

3. **Configuration**:
   ```bash
   firebase functions:secrets:set INTASEND_SECRET
   firebase functions:secrets:set INTASEND_CHALLENGE
   ```

### Function Authentication

- `createPayment`: Requires Firebase Auth token (user must be authenticated)
- `handleTopUpWebhook`: No auth required (validated via signature/challenge)

---

## Error Handling

### createPayment Errors

1. **Authentication Error**:
   - Error: `unauthenticated`
   - Solution: User must be logged in

2. **Validation Error**:
   - Error: `invalid-argument`
   - Causes: Missing amount, invalid amount, missing currency, missing invoice ID
   - Solution: Provide all required fields

3. **Internal Error**:
   - Error: `internal`
   - Causes: Database write failures, network issues
   - Solution: Check logs, retry if needed

### handleTopUpWebhook Errors

1. **Authentication Failure**:
   - Status: `403 Forbidden`
   - Cause: Invalid signature or challenge
   - Action: Logs error, rejects webhook

2. **Missing Payment Identifier**:
   - Status: `400 Bad Request`
   - Cause: No `invoice_id` or `payment_id` in payload
   - Action: Returns error, logs for investigation

3. **User ID Resolution Failure**:
   - Status: `200 OK` (but no balance update)
   - Cause: Cannot find user for invoice ID
   - Action: Records payment in `/payments/{invoiceId}` for manual reconciliation

4. **Balance Update Failure**:
   - Status: `500 Internal Server Error`
   - Cause: Database transaction failure, insufficient balance (if negative not allowed)
   - Action: Logs error, IntaSend will retry webhook

---

## Idempotency

### Order Creation
- Orders are created with unique `orderId` (Firestore auto-generated)
- Multiple calls with same `invoiceId` will create multiple orders
- **Recommendation**: Check for existing order before creating new one (client-side)

### Balance Updates
- Firestore transactions ensure atomicity
- Multiple webhook calls for same payment will result in multiple balance updates
- **Mitigation**: Check if payment already processed before updating balance
- **Current Implementation**: Does not check for duplicate processing (relies on IntaSend not sending duplicates)

---

## Monitoring & Logging

### Key Log Points

1. **createPayment**:
   - `📥 Received createPayment request`
   - `🔄 Creating payment order for user: {userId}`
   - `✅ Created order document: {orderId}`
   - `✅ Created invoice mapping in RTDB: {invoiceId}`
   - `✅ Returning payment creation response`

2. **handleTopUpWebhook**:
   - `💰 Processing payment`
   - `✅ Found wallet ID from order lookup`
   - `✅ Found wallet ID from RTDB invoice mapping`
   - `✅ Webhook processed successfully: {userId}`
   - `❌ Error processing webhook balance update`

### Metrics to Monitor

- Order creation success rate
- Webhook processing success rate
- User ID resolution success rate (by strategy)
- Balance update failures
- Average processing time

---

## Testing

### Test createPayment

```javascript
// Using Firebase Functions emulator or deployed function
const createPayment = httpsCallable(functions, 'createPayment');

const result = await createPayment({
  amount: 100,
  currency: 'KES',
  checkoutUrl: 'https://payment.intasend.com/checkout/test-invoice-id/express/'
});

console.log(result.data);
// Expected: { success: true, orderId: "...", invoiceId: "...", ... }
```

### Test handleTopUpWebhook

```bash
# Using curl or Postman
curl -X POST https://us-central1-{project-id}.cloudfunctions.net/handleTopUpWebhook \
  -H "Content-Type: application/json" \
  -H "x-intasend-signature: {signature}" \
  -d '{
    "invoice_id": "test-invoice-id",
    "state": "COMPLETE",
    "net_amount": "100.00",
    "currency": "KES",
    "account": "254712345678"
  }'
```

---

## Troubleshooting

### Payment Not Credited

1. **Check Order Creation**:
   - Verify order exists in Firestore: `/orders/{orderId}`
   - Check `invoiceId` matches webhook `invoice_id`

2. **Check User ID Resolution**:
   - Review webhook logs for user ID resolution strategy used
   - Verify RTDB mapping exists: `/wallet/pendingTopups/{invoiceId}`
   - Check order has correct `userId`

3. **Check Balance Update**:
   - Review Firestore user document: `/users/{userId}` → `balance`
   - Check transaction log: `/transactions/{transactionId}`
   - Verify Realtime DB sync: `/wallet/{userId}/fiat/{currency}`

### Webhook Not Received

1. **Check IntaSend Configuration**:
   - Verify webhook URL is correct
   - Check IntaSend dashboard for webhook delivery status

2. **Check Function Deployment**:
   - Verify `handleTopUpWebhook` is deployed
   - Check function logs for incoming requests

3. **Check Security**:
   - Verify `INTASEND_SECRET` or `INTASEND_CHALLENGE` is configured
   - Check signature verification is working

---

## Summary

The top-up flow ensures:
- ✅ **Reliability**: Multiple strategies for user ID resolution
- ✅ **Atomicity**: Firestore transactions prevent race conditions
- ✅ **Real-time Updates**: Realtime DB sync for instant client updates
- ✅ **Audit Trail**: Transaction logging for all balance changes
- ✅ **Security**: Webhook signature verification
- ✅ **Error Recovery**: Payment recording even if user ID cannot be resolved

**Key Files**:
- `functions/payments.js` - Main payment functions
- `functions/utils/firestore.js` - Balance update logic
- `functions/utils/realtime.js` - Realtime DB sync
- `functions/utils/transactions.js` - Transaction logging

