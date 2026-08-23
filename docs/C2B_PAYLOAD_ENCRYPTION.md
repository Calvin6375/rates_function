# C2B Payload Encryption (Flutter mobile app)

Optional **AES-256-GCM** encryption for consumer (C2B) REST APIs only. B2B portal, partner API, and webhooks are **not** encrypted with this scheme.

Transport security is still **HTTPS**. Firebase **ID token** auth is unchanged. This adds an encrypted JSON envelope on top for the mobile app wire format.

---

## Scope (C2B only)

| Function | Encrypted when client opts in |
|----------|------------------------------|
| `safariCardApi` | Yes |
| `transactionsApi` | Yes |
| `api` (`customerWalletsHttp`) | Yes |
| `cryptoApi` | Yes |
| `b2bPortal`, `partner`, webhooks | **No** |

---

## Setup

### 1. Generate a 32-byte key

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### 2. Store on backend (Firebase Secret)

Single key (recommended):

```bash
firebase functions:secrets:set C2B_PAYLOAD_ENCRYPTION_KEY
# paste base64 key
```

Key rotation (optional — store JSON in the **same** secret instead of a second one):

```bash
firebase functions:secrets:set C2B_PAYLOAD_ENCRYPTION_KEY
# paste JSON, e.g.:
# {"default":"<base64>","v2026-08":"<base64>"}
```

Legacy env `C2B_PAYLOAD_ENCRYPTION_KEYS` is still read if set manually, but deploy only binds `C2B_PAYLOAD_ENCRYPTION_KEY`.

Redeploy C2B functions after setting secrets:

```bash
cd functions
firebase deploy --only functions:safariCardApi,functions:transactionsApi,functions:api,functions:cryptoApi
```

### 3. Remote Config (Flutter)

| Parameter | Example | Purpose |
|-----------|---------|---------|
| `c2b_payload_encryption_enabled` | `true` | Feature flag |
| `c2b_payload_encryption_key` | same base64 as server | Shared symmetric key |
| `c2b_payload_encryption_key_id` | `default` | Must match server key ring id |

Store the key in **secure storage** after first fetch (Android Keystore / iOS Keychain).

### 4. Optional: require encryption

```bash
firebase functions:config:set c2b.encryption_required=true
# or set env C2B_PAYLOAD_ENCRYPTION_REQUIRED=true on deploy
```

When `true`, C2B APIs reject requests without `X-TruePay-Encrypted: 1`.

Default: **optional** (plaintext still works for gradual rollout).

---

## Wire protocol

### Request headers

| Header | Value |
|--------|-------|
| `Authorization` | `Bearer <Firebase ID token>` (unchanged) |
| `X-TruePay-Encrypted` | `1` |
| `X-TruePay-Key-Id` | `default` (or rotation id) |
| `Content-Type` | `application/json` |

### Encrypted request body (POST/PUT/PATCH)

Instead of plain JSON, send:

```json
{
  "v": 1,
  "kid": "default",
  "data": "<base64(iv + ciphertext + authTag)>"
}
```

The decrypted plaintext is the **normal API JSON** (e.g. Safari Card payout create body).

### GET requests

No body encryption. Send headers only; response is encrypted if `X-TruePay-Encrypted: 1`.

### Encrypted response

Same envelope shape `{ v, kid, data }` plus response headers:

```
X-TruePay-Encrypted: 1
X-TruePay-Key-Id: default
```

Decrypt `data` to get the normal `{ success, data }` or `{ success, false, error, code }` JSON.

---

## Flutter implementation sketch

```dart
import 'dart:convert';
import 'dart:typed_data';
import 'package:encrypt/encrypt.dart' as enc;
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:firebase_remote_config/firebase_remote_config.dart';
import 'package:http/http.dart' as http;

class C2bCrypto {
  C2bCrypto(this._storage);
  final FlutterSecureStorage _storage;

  Future<enc.Key?> loadKey() async {
    final cached = await _storage.read(key: 'c2b_payload_key');
    if (cached != null) return enc.Key(base64Decode(cached));

    final rc = FirebaseRemoteConfig.instance;
    await rc.fetchAndActivate();
    if (!rc.getBool('c2b_payload_encryption_enabled')) return null;

    final material = rc.getString('c2b_payload_encryption_key');
    await _storage.write(key: 'c2b_payload_key', value: material);
    return enc.Key(base64Decode(material));
  }

  Map<String, dynamic> encryptJson(Map<String, dynamic> payload, enc.Key key, String kid) {
    final iv = enc.IV.fromSecureRandom(12);
    final aes = enc.Encrypter(enc.AES(key, mode: enc.AESMode.gcm));
    final encrypted = aes.encrypt(jsonEncode(payload), iv: iv);
    final packed = Uint8List.fromList([...iv.bytes, ...encrypted.bytes]);
    return {'v': 1, 'kid': kid, 'data': base64Encode(packed)};
  }

  Map<String, dynamic> decryptJson(Map<String, dynamic> envelope, enc.Key key) {
    final packed = base64Decode(envelope['data'] as String);
    final iv = enc.IV(packed.sublist(0, 12));
    final cipherBytes = packed.sublist(12);
    final aes = enc.Encrypter(enc.AES(key, mode: enc.AESMode.gcm));
    final clear = aes.decrypt(enc.Encrypted(cipherBytes), iv: iv);
    return jsonDecode(clear) as Map<String, dynamic>;
  }
}
```

Wrap your HTTP client:

1. If encryption enabled → encrypt POST body, set headers.
2. On response, if `X-TruePay-Encrypted: 1` → decrypt envelope before parsing.
3. If encryption disabled → existing plaintext client (backwards compatible).

---

## Error codes

| `code` | HTTP | Meaning |
|--------|------|---------|
| `ENCRYPTION_REQUIRED` | 400 | Server requires encrypted requests |
| `INVALID_ENCRYPTED_PAYLOAD` | 400 | Body is not `{ v, data }` |
| `DECRYPTION_FAILED` | 400 | Bad key or tampered payload |
| `ENCRYPTION_NOT_CONFIGURED` | 503 | Secret not set on server |
| `ENCRYPTION_FAILED` | 500 | Server could not encrypt response |

---

## Security notes

- Remote Config key is **obfuscation**, not true secret storage — assume extractable from the APK/IPA.
- Still rely on **HTTPS + Firebase Auth** for real protection.
- Rotate keys via `C2B_PAYLOAD_ENCRYPTION_KEYS` + new Remote Config `key_id`.
- Never enable this on webhooks or B2B routes.

---

## Related docs

- [`pay.md`](./pay.md) — Safari Card payout API (encrypt the same JSON bodies)
- [`TRANSACTIONS_API.md`](./TRANSACTIONS_API.md) — transaction feed
- [`circle_c2b.md`](./circle_c2b.md) — USDC wallet API
