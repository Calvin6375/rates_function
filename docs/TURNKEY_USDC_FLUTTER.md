# SafariTap USDC top-up — Flutter notes (Turnkey)

Use this instead of Circle deposit addresses for **Top Up USDC**.

The backend now owns:

- persistent per-customer Avalanche Fuji USDC deposit addresses
- short-lived deposit monitoring
- ledger credit and RTDB projection

Flutter must **not** scan the blockchain, store Turnkey credentials, or send `userId` in the body.

Circle wallet APIs stay in the repo, but **do not use `GET /crypto/wallet` for USDC top-up**. That path can still return a Circle address.

---

## What to implement

When the user taps **Top Up USDC**:

1. Call `POST /crypto/deposit/watch`.
2. Show the returned address + network.
3. Show “Waiting for deposit…”.
4. Listen to RTDB `wallet/{uid}/crypto/USDC` for display updates.
5. Do not poll the chain.
6. Do not call the watch endpoint in a loop.

The same address is reused for that user. Do not create or cache a new address locally.

---

## Base URL

| Environment | Base URL |
|-------------|----------|
| Production | `https://us-central1-truepay-72060.cloudfunctions.net/cryptoApi` |
| Emulator | `http://localhost:5001/truepay-72060/us-central1/cryptoApi` |
| Android emulator → host | `http://10.0.2.2:5001/truepay-72060/us-central1/cryptoApi` |

Path: `{base}/crypto/deposit/watch`

---

## Auth

Every request needs a Firebase ID token. Derive the user from that token.

```http
POST /crypto/deposit/watch
Authorization: Bearer <firebase-id-token>
Content-Type: application/json
```

Do **not** send `userId`.

---

## Request

```json
{
  "asset": "USDC",
  "network": "avalanche-fuji"
}
```

Only `USDC` + `avalanche-fuji` are supported in this MVP.

---

## Response

```json
{
  "success": true,
  "intentId": "zCSjRelA26UhDhAuzVycQ13zEFX2_avalanche-fuji_USDC",
  "userId": "zCSjRelA26UhDhAuzVycQ13zEFX2",
  "asset": "USDC",
  "network": "avalanche-fuji",
  "address": "0x3fa194303A09bEa29a76201D3f4C96E321345b2d",
  "status": "monitoring",
  "expiresAt": "2026-09-15T08:30:00.000Z"
}
```

Show in the UI:

```text
Send USDC to:
0x....

Network:
Avalanche Fuji

Waiting for deposit...
```

Also show a QR of `address`.

Backend monitoring lasts about **60 seconds**. After that the address remains valid; a later deposit is still credited by the backend scanner. Flutter does not need to keep calling watch.

A second tap while monitoring is active returns the **same** `intentId` and address.

---

## Suggested Dart client

Add this next to the existing `cryptoApi` client. Do not put Turnkey keys in the app.

```dart
class DepositWatchResult {
  DepositWatchResult({
    required this.intentId,
    required this.userId,
    required this.asset,
    required this.network,
    required this.address,
    required this.status,
    required this.expiresAt,
  });

  final String intentId;
  final String userId;
  final String asset;
  final String network;
  final String address;
  final String status;
  final DateTime expiresAt;

  factory DepositWatchResult.fromJson(Map<String, dynamic> json) {
    return DepositWatchResult(
      intentId: json['intentId'] as String,
      userId: json['userId'] as String,
      asset: json['asset'] as String,
      network: json['network'] as String,
      address: json['address'] as String,
      status: json['status'] as String,
      expiresAt: DateTime.parse(json['expiresAt'] as String),
    );
  }
}

Future<DepositWatchResult> startUsdcDepositWatch() async {
  final res = await _http.post(
    Uri.parse('$baseUrl/crypto/deposit/watch'),
    headers: await _headers(),
    body: jsonEncode({
      'asset': 'USDC',
      'network': 'avalanche-fuji',
    }),
  );
  final body = jsonDecode(res.body) as Map<String, dynamic>;
  if (res.statusCode != 200 || body['success'] != true) {
    throw CryptoApiException(res.statusCode, body['error']?.toString());
  }
  return DepositWatchResult.fromJson(body);
}
```

Wire the Top Up button:

```dart
Future<void> onTopUpUsdc() async {
  final watch = await cryptoApi.startUsdcDepositWatch();
  // Navigate to deposit screen with watch.address / watch.network
}
```

---

## Balance display

Authoritative balance is the backend ledger.

For live UI updates, listen only:

```text
wallet/{userId}/crypto/USDC
```

```dart
FirebaseDatabase.instance
    .ref('wallet/$uid/crypto/USDC')
    .onValue
    .listen((event) {
  final value = event.snapshot.value;
  final usdc = value is num ? value.toDouble() : 0;
  // Display only. Do not treat this as the source of truth.
});
```

Do **not**:

- compute balance from transaction history
- write this RTDB path
- show the old Circle address
- fall back to USDT / `users.cryptoBalance`

Optional: after credit, refresh `GET /crypto/balance` and `GET /crypto/transactions`.

---

## What not to implement

- Blockchain RPC / Transfer log scanning
- Turnkey API keys, wallet IDs, derivation paths
- Sending `userId` from the client
- Creating a new address on every tap
- A second local balance store
- Circle faucet or Circle wallet create from Flutter
- Withdraw / sweep / send changes for this task

Send USDC (`POST /crypto/send`) is unchanged and is not part of this top-up flow.

---

## B2B

The same endpoint can be used from B2B checkout / payment-link flows **if** the request is authenticated as the customer (or another authorized Firebase user whose token `uid` is the user to credit).

Do not allow an unauthenticated caller to pass an arbitrary `userId`.

---

## QA checklist

1. Signed-in user taps Top Up USDC.
2. App shows a Fuji USDC address and “Waiting for deposit…”.
3. Tapping Top Up again shows the same address.
4. Sending Fuji USDC to that address credits that user only.
5. RTDB `wallet/{uid}/crypto/USDC` updates without the app scanning the chain.
6. A second identical on-chain event does not double-credit.
7. Old Circle addresses are no longer shown after backend migration.
