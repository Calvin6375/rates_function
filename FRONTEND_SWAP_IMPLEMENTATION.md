# Frontend: Swap order implementation steps

Use this flow to implement **swap** (e.g. USDT → USD) in the Flutter app. The backend creates the order and updates balances; the client must **not** write to the `orders` collection.

---

## Prerequisites

- User must be **signed in** (Firebase Auth). The callable uses `request.auth.uid`.
- Backend must have **`createSwapOrder`** deployed:  
  `firebase deploy --only functions:createSwapOrder`

---

## Step 1: Remove client writes to `orders`

- Find any code that **creates or updates** a document in the `orders` collection (e.g. `FirebaseFirestore.instance.collection('orders').doc(...).set(...)` or `.add(...)`) when the user performs a swap.
- **Remove** that write. Do not create an order document from the client for swap flows.

---

## Step 2: Call `createSwapOrder` instead of writing to Firestore

When the user confirms a swap (e.g. “Swap 6 USDT → USD”):

1. **Ensure you have** (you likely already compute these for the UI):
   - `fromCurrency` (e.g. `"USDT"`)
   - `toCurrency` (e.g. `"USD"`)
   - `fromAmount` (e.g. `6.0`)
   - `exchangeRate` (e.g. `1.01297`)
   - `fee` (e.g. `0.03`) **or** `feeRate` (e.g. `0.005` for 0.5%)
   - Optionally `toAmount` (e.g. `6.07782`); if omitted, backend uses `fromAmount * exchangeRate`

2. **Call the callable** with that payload:

```dart
import 'package:cloud_functions/cloud_functions.dart';

Future<Map<String, dynamic>> createSwapOrder({
  required String fromCurrency,
  required String toCurrency,
  required double fromAmount,
  required double exchangeRate,
  double? fee,
  double? feeRate,
  double? toAmount,
}) async {
  final callable = FirebaseFunctions.instance.httpsCallable('createSwapOrder');
  final payload = <String, dynamic>{
    'fromCurrency': fromCurrency,
    'toCurrency': toCurrency,
    'fromAmount': fromAmount,
    'exchangeRate': exchangeRate,
  };
  if (fee != null) payload['fee'] = fee;
  if (feeRate != null) payload['feeRate'] = feeRate;
  if (toAmount != null) payload['toAmount'] = toAmount;

  final result = await callable.call(payload);
  return Map<String, dynamic>.from(result.data as Map);
}
```

3. **Handle the response**:

```dart
try {
  final data = await createSwapOrder(
    fromCurrency: 'USDT',
    toCurrency: 'USD',
    fromAmount: 6.0,
    exchangeRate: 1.01297,
    fee: 0.03,
    toAmount: 6.07782, // optional
  );

  final orderId = data['orderId'] as String;
  final toAmount = (data['toAmount'] as num).toDouble();
  final newBalances = data['newBalances'] as Map<String, dynamic>?;
  // e.g. newBalances['USD'], newBalances['USDT'], newBalances['balance']

  // Navigate to success, show confirmation, update local state from newBalances
  // or rely on Firestore/RTDB listeners to refresh balances.
} on FirebaseFunctionsException catch (e) {
  if (e.code == 'failed-precondition') {
    // Insufficient balance (e.message has details)
  } else if (e.code == 'invalid-argument') {
    // Bad parameters
  } else {
    // Other (e.g. internal)
  }
}
```

---

## Step 3: API contract (reference)

| Request field     | Type   | Required | Description |
|------------------|--------|----------|-------------|
| `fromCurrency`   | string | Yes      | e.g. `"USDT"` |
| `toCurrency`     | string | Yes      | e.g. `"USD"` |
| `fromAmount`     | number | Yes      | Amount to convert (e.g. `6.0`) |
| `exchangeRate`   | number | Yes      | Rate from fromCurrency → toCurrency (e.g. `1.01297`) |
| `fee`            | number | No       | Fee in fromCurrency (e.g. `0.03`). If set, `feeRate` is ignored. |
| `feeRate`        | number | No       | Fee rate (e.g. `0.005` = 0.5%) |
| `toAmount`       | number | No       | Exact destination amount; if omitted, server uses `fromAmount * exchangeRate` |

**Response (success):**

```json
{
  "success": true,
  "orderId": "jtVzWftVZpHKS98Ovbs0",
  "fromAmount": 6.0,
  "toAmount": 6.07782,
  "fee": 0.03,
  "newBalances": {
    "USD": 106.08,
    "KES": 0,
    "USDT": 93.97,
    "balance": 200.05
  }
}
```

**Errors:**

| Code                 | Meaning |
|----------------------|--------|
| `unauthenticated`    | User not signed in |
| `invalid-argument`   | Missing or invalid `fromCurrency`, `toCurrency`, `fromAmount`, or `exchangeRate` |
| `failed-precondition`| Insufficient balance in `fromCurrency` |
| `internal`           | Server error; retry or show generic error |

---

## Step 4: Optional – refresh UI from response

- Use **`orderId`** for order history or confirmation screens.
- Use **`newBalances`** to update local state immediately if you don’t rely only on Firestore/Realtime Database listeners for wallet balances.

---

## Checklist

- [ ] Removed all client-side writes to the `orders` collection for swap flows.
- [ ] Swap confirmation triggers a single call to `createSwapOrder` with the required fields (and optional `fee`/`feeRate`/`toAmount`).
- [ ] Success path uses `orderId` and optionally `newBalances` from the response.
- [ ] Error path handles `failed-precondition` (insufficient balance) and `invalid-argument`.
- [ ] User is signed in before calling `createSwapOrder`.
