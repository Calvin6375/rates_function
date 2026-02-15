# Frontend: Send money order implementation steps

Use this flow to implement **send money** (P2P transfer) in the Flutter app. The backend creates the order and updates both users' balances; the client must **not** write to the `orders` collection.

---

## Prerequisites

- User must be **signed in** (Firebase Auth). The callable uses `request.auth.uid` as the sender.
- Backend must have **`createSendMoneyOrder`** deployed:  
  `firebase deploy --only functions:createSendMoneyOrder`

---

## Step 1: Remove client writes to `orders` for send money

- Find any code that **creates or updates** a document in the `orders` collection when the user performs a "send money" / transfer (e.g. "Creating order for user" in logs for send money).
- **Remove** that write. Do not create an order document from the client for send-money flows.

---

## Step 2: Call `createSendMoneyOrder` instead of writing to Firestore

When the user confirms sending money:

1. **Ensure you have**:
   - **Recipient**: either `recipientUserId` (Firebase UID) or `recipientPhoneNumber` (with or without `+`)
   - `amount` (e.g. `1.0`)
   - `currency` (e.g. `"USD"`, `"KES"`, or `"USDT"`)
   - Optionally `note` (string memo)

2. **Call the callable**:

```dart
import 'package:cloud_functions/cloud_functions.dart';

Future<Map<String, dynamic>> createSendMoneyOrder({
  String? recipientUserId,
  String? recipientPhoneNumber,
  required double amount,
  required String currency,
  String? note,
}) async {
  if (recipientUserId == null && recipientPhoneNumber == null) {
    throw ArgumentError('Either recipientUserId or recipientPhoneNumber is required');
  }
  final callable = FirebaseFunctions.instance.httpsCallable('createSendMoneyOrder');
  final payload = <String, dynamic>{
    'amount': amount,
    'currency': currency,
  };
  if (recipientUserId != null) payload['recipientUserId'] = recipientUserId;
  if (recipientPhoneNumber != null) payload['recipientPhoneNumber'] = recipientPhoneNumber;
  if (note != null) payload['note'] = note;

  final result = await callable.call(payload);
  return Map<String, dynamic>.from(result.data as Map);
}
```

3. **Handle the response**:

```dart
try {
  final data = await createSendMoneyOrder(
    recipientUserId: 'abc123',  // or recipientPhoneNumber: '+254...'
    amount: 1.0,
    currency: 'USD',
    note: 'Payment for lunch',
  );

  final orderId = data['orderId'] as String;
  final recipientUserId = data['recipientUserId'] as String;
  final senderNewBalances = data['senderNewBalances'] as Map<String, dynamic>?;
  final recipientNewBalances = data['recipientNewBalances'] as Map<String, dynamic>?;

  // Navigate to success, show confirmation, update local state from senderNewBalances
  // or rely on Firestore/RTDB listeners to refresh balances.
} on FirebaseFunctionsException catch (e) {
  if (e.code == 'failed-precondition') {
    // Insufficient balance
  } else if (e.code == 'not-found') {
    // Recipient not found (invalid userId or phone)
  } else if (e.code == 'invalid-argument') {
    // Bad parameters (e.g. send to self, invalid currency)
  } else {
    // Other (e.g. internal)
  }
}
```

---

## Step 3: API contract (reference)

| Request field          | Type   | Required | Description |
|------------------------|--------|----------|-------------|
| `recipientUserId`      | string | One of these | Firebase UID of recipient |
| `recipientPhoneNumber` | string | One of these | Recipient phone (with or without +) |
| `amount`               | number | Yes      | Amount to send (e.g. `1.0`) |
| `currency`             | string | Yes      | `"USD"`, `"KES"`, or `"USDT"` |
| `note`                 | string | No       | Optional memo |

**Response (success):**

```json
{
  "success": true,
  "orderId": "1Uf3YrpIvU9tobkX3VHs",
  "amount": 1.0,
  "currency": "USD",
  "recipientUserId": "xyz789",
  "senderNewBalances": { "USD": 99.0, "KES": 0, "USDT": 50.0, "balance": 149.0 },
  "recipientNewBalances": { "USD": 11.0, "KES": 0, "USDT": 0, "balance": 11.0 }
}
```

**Errors:**

| Code                 | Meaning |
|----------------------|--------|
| `unauthenticated`    | User not signed in |
| `invalid-argument`   | Missing/invalid params, or sending to self |
| `not-found`          | Recipient not found (invalid userId or phone) |
| `failed-precondition` | Insufficient balance in the given currency |
| `internal`            | Server error |

---

## Step 4: Optional – refresh UI from response

- Use **`orderId`** for order history or confirmation screens.
- Use **`senderNewBalances`** to update the sender’s wallet UI immediately if you don’t rely only on Firestore/Realtime Database listeners.

---

## Checklist

- [ ] Removed all client-side writes to the `orders` collection for send-money flows.
- [ ] Send-money confirmation triggers a single call to `createSendMoneyOrder` with `amount`, `currency`, and either `recipientUserId` or `recipientPhoneNumber`.
- [ ] Success path uses `orderId` and optionally `senderNewBalances`.
- [ ] Error path handles `failed-precondition` (insufficient balance), `not-found` (recipient not found), and `invalid-argument`.
- [ ] User is signed in before calling `createSendMoneyOrder`.
