# Transactions History API - Flutter App Usage

## Endpoint

**Base URL**: `https://us-central1-truepay-72060.cloudfunctions.net/transactionsApi`

**Function Name**: `transactionsApi`

## Get Transaction History

### Endpoint
```
GET /transactions
```

### Full URL
```
https://us-central1-truepay-72060.cloudfunctions.net/transactionsApi/transactions
```

### Required Headers
```
Authorization: Bearer <Firebase Auth ID Token>
Content-Type: application/json
```

### Optional Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `source` | string | `"both"` | Data source: `"firestore"`, `"realtime"`, or `"both"` |
| `limit` | number | `50` | Number of transactions to return (max: 100) |
| `startAfter` | string | `null` | Transaction ID for pagination (get next page) |
| `type` | string | `null` | Filter by transaction type: `"credit"`, `"debit"`, etc. |
| `status` | string | `null` | Filter by status: `"completed"`, `"pending"`, `"failed"` |

### Flutter/Dart Example

```dart
import 'package:http/http.dart' as http;
import 'package:firebase_auth/firebase_auth.dart';
import 'dart:convert';

Future<Map<String, dynamic>> getTransactionHistory({
  int? limit,
  String? source,
  String? startAfter,
  String? type,
  String? status,
}) async {
  try {
    // Get Firebase Auth token
    final user = FirebaseAuth.instance.currentUser;
    if (user == null) {
      throw Exception('User not authenticated');
    }
    
    final token = await user.getIdToken();
    
    // Build query parameters
    final queryParams = <String, String>{};
    if (limit != null) queryParams['limit'] = limit.toString();
    if (source != null) queryParams['source'] = source;
    if (startAfter != null) queryParams['startAfter'] = startAfter;
    if (type != null) queryParams['type'] = type;
    if (status != null) queryParams['status'] = status;
    
    // Build URL
    final uri = Uri.parse(
      'https://us-central1-truepay-72060.cloudfunctions.net/transactionsApi/transactions'
    ).replace(queryParameters: queryParams);
    
    // Make request
    final response = await http.get(
      uri,
      headers: {
        'Authorization': 'Bearer $token',
        'Content-Type': 'application/json',
      },
    );
    
    if (response.statusCode == 200) {
      return json.decode(response.body);
    } else {
      final error = json.decode(response.body);
      throw Exception(error['message'] ?? 'Failed to fetch transactions');
    }
  } catch (e) {
    throw Exception('Error fetching transactions: $e');
  }
}
```

### Usage Examples

```dart
// Get first 50 transactions from both sources
final result = await getTransactionHistory();

// Get first 20 transactions from Firestore only
final result = await getTransactionHistory(
  limit: 20,
  source: 'firestore',
);

// Get only credit transactions
final result = await getTransactionHistory(
  type: 'credit',
);

// Get pending transactions
final result = await getTransactionHistory(
  status: 'pending',
);

// Pagination: Get next page
final firstPage = await getTransactionHistory(limit: 50);
final lastTransactionId = firstPage['data']['pagination']['startAfter'];
final nextPage = await getTransactionHistory(
  limit: 50,
  startAfter: lastTransactionId,
);
```

### Response Format

```json
{
  "success": true,
  "data": {
    "transactions": [
      {
        "id": "tx_1234567890_abc123",
        "userId": "user123",
        "type": "credit",
        "amount": 1000,
        "status": "completed",
        "previousBalance": 0,
        "newBalance": 1000,
        "timestamp": "2024-01-15T10:30:00.000Z",
        "metadata": {},
        "source": "firestore"
      }
    ],
    "pagination": {
      "limit": 50,
      "count": 10,
      "hasMore": false,
      "startAfter": "tx_1234567890_abc123"
    },
    "sources": ["firestore"]
  }
}
```

### Error Response

```json
{
  "success": false,
  "error": "Unauthorized",
  "message": "Authentication required"
}
```

---

## Get Single Transaction

### Endpoint
```
GET /transactions/:transactionId
```

### Full URL
```
https://us-central1-truepay-72060.cloudfunctions.net/transactionsApi/transactions/{transactionId}
```

### Required Headers
```
Authorization: Bearer <Firebase Auth ID Token>
Content-Type: application/json
```

### Flutter/Dart Example

```dart
Future<Map<String, dynamic>> getTransaction(String transactionId) async {
  try {
    final user = FirebaseAuth.instance.currentUser;
    if (user == null) {
      throw Exception('User not authenticated');
    }
    
    final token = await user.getIdToken();
    
    final uri = Uri.parse(
      'https://us-central1-truepay-72060.cloudfunctions.net/transactionsApi/transactions/$transactionId'
    );
    
    final response = await http.get(
      uri,
      headers: {
        'Authorization': 'Bearer $token',
        'Content-Type': 'application/json',
      },
    );
    
    if (response.statusCode == 200) {
      final result = json.decode(response.body);
      return result['data'];
    } else {
      final error = json.decode(response.body);
      throw Exception(error['message'] ?? 'Transaction not found');
    }
  } catch (e) {
    throw Exception('Error fetching transaction: $e');
  }
}
```

### Response Format

```json
{
  "success": true,
  "data": {
    "id": "tx_1234567890_abc123",
    "userId": "user123",
    "type": "credit",
    "amount": 1000,
    "status": "completed",
    "previousBalance": 0,
    "newBalance": 1000,
    "timestamp": "2024-01-15T10:30:00.000Z",
    "metadata": {},
    "source": "firestore"
  }
}
```

---

## Common Use Cases

### 1. Display Transaction List (First Page)
```dart
final result = await getTransactionHistory(limit: 20);
final transactions = result['data']['transactions'] as List;
```

### 2. Load More Transactions (Pagination)
```dart
final hasMore = result['data']['pagination']['hasMore'] as bool;
if (hasMore) {
  final startAfter = result['data']['pagination']['startAfter'] as String;
  final nextPage = await getTransactionHistory(
    limit: 20,
    startAfter: startAfter,
  );
}
```

### 3. Filter by Transaction Type
```dart
// Get only deposits (credits)
final deposits = await getTransactionHistory(type: 'credit');

// Get only withdrawals (debits)
final withdrawals = await getTransactionHistory(type: 'debit');
```

### 4. Get Pending Transactions
```dart
final pending = await getTransactionHistory(status: 'pending');
```

### 5. Query Specific Source
```dart
// Firestore only (primary source)
final firestoreTx = await getTransactionHistory(source: 'firestore');

// Realtime Database only (if exists)
final rtdbTx = await getTransactionHistory(source: 'realtime');

// Both sources (default, deduplicated)
final allTx = await getTransactionHistory(source: 'both');
```

---

## Local Development (Emulator)

When testing locally with Firebase Emulators, use:

```
http://localhost:5001/truepay-72060/us-central1/transactionsApi/transactions
```

### Local Example
```dart
// For local emulator
final uri = Uri.parse(
  'http://localhost:5001/truepay-72060/us-central1/transactionsApi/transactions'
);
```

---

## Notes

1. **Authentication**: All requests require a valid Firebase Auth ID token
2. **CORS**: Enabled for Flutter web apps
3. **Source Parameter**: 
   - `"both"` (default): Queries both databases, deduplicates, and merges results
   - `"firestore"`: Only queries Firestore (primary source)
   - `"realtime"`: Only queries Realtime Database (may be empty if not used)
4. **Pagination**: Use `startAfter` with the last transaction ID from the previous response
5. **Max Limit**: Maximum 100 transactions per request
6. **Error Handling**: Always check `response.statusCode` and handle errors appropriately
