# Platform admin — partner wallet top-up (frontend handoff)

## Why Enterprise showed 50k but Send showed 0

Two different stores were used:

| UI | API | Balance source |
|----|-----|----------------|
| Super admin **Enterprise (B2B)** (old credit) | `POST /api/customer-wallets/:userId/credit` | `users/{uid}.kesBalance` |
| Partner **Send** virtual cards | `GET /b2bPortal/portal/wallet` | `wallets` (`ownerType: partner`) |

**Fix (backend):**
1. `GET /portal/wallet` migrates stranded `users/{uid}` balances into the partner wallet **once**.
2. Future C2B-style credits on B2B users also credit the **partner wallet**.
3. Preferred admin API remains `POST /platform/partners/:partnerId/wallet/credit`.

After deploy, partner should **Refresh** on Send — the 50k KES moves into the partner wallet automatically.

---

Super-admin manual credit/debit of **B2B partner wallets**, same idea as C2B:

| C2B (existing) | B2B (new) |
|----------------|-----------|
| `POST /api/customer-wallets/:id/credit` | `POST /b2bPortal/platform/partners/:partnerId/wallet/credit` |
| Customer user wallet | Partner org wallet (`wallets` / `ownerType: partner`) |

---

## Auth

```http
Authorization: Bearer <Firebase ID token>
```

Token must be a **platform admin** (`admin: true` / `userType: admin` / master super-admin email). Same auth as other `/platform/*` routes.

Base URL:

```
https://us-central1-truepay-72060.cloudfunctions.net/b2bPortal
```

---

## 1. Read partner wallet

```http
GET /platform/partners/:partnerId/wallet
```

**Response** `200`

```json
{
  "success": true,
  "data": {
    "partnerId": "partner_…",
    "partnerName": "Acme Hotel",
    "walletId": "wallet_partner_…",
    "balances": {
      "USD": 0,
      "KES": 5000,
      "USDT": 0
    }
  }
}
```

Use this on the partner detail screen (and after credit/debit to refresh).

---

## 2. Credit (manual top-up)

```http
POST /platform/partners/:partnerId/wallet/credit
Content-Type: application/json

{
  "amount": 5000,
  "currency": "KES",
  "description": "Manual top-up from ops"
}
```

| Field | Required | Notes |
|-------|----------|--------|
| `amount` | Yes | Number `> 0` |
| `currency` | No | `KES` (default), `USD`, or `USDT` |
| `description` | No | Shown in transaction metadata / audit |

**Response** `200`

```json
{
  "success": true,
  "data": {
    "partnerId": "partner_…",
    "partnerName": "Acme Hotel",
    "wallet": {
      "walletId": "wallet_partner_…",
      "balances": { "USD": 0, "KES": 10000, "USDT": 0 }
    },
    "transaction": {
      "transactionId": "txr_…",
      "type": "credit",
      "amount": 5000,
      "currency": "KES",
      "description": "Manual top-up from ops",
      "previousBalance": 5000,
      "newBalance": 10000
    }
  }
}
```

**Errors**

| HTTP | `error` | When |
|------|---------|------|
| `400` | `INVALID_AMOUNT` | Missing / ≤ 0 |
| `400` | `INVALID_CURRENCY` | Not USD/KES/USDT |
| `403` | — | Not platform admin |
| `404` | `PARTNER_NOT_FOUND` | Unknown partner |

---

## 3. Debit (optional, same pattern as C2B)

```http
POST /platform/partners/:partnerId/wallet/debit
Content-Type: application/json

{
  "amount": 1000,
  "currency": "KES",
  "description": "Adjustment"
}
```

`400` `INSUFFICIENT_BALANCE` if the partner wallet cannot cover the debit.

---

## Suggested UI (Partners tab)

On **Partner detail** (next to wallet / balances):

1. Show balances from `GET …/wallet` (KES / USD / USDT).
2. **Top up** button → modal:
   - Amount (number)
   - Currency select (`KES` default)
   - Description (optional)
3. Submit → `POST …/wallet/credit`
4. Toast success with `newBalance`; refresh wallet + transactions list.
5. Transactions appear as `type: "b2b_admin_topup"` on `GET /platform/transactions` / partner transaction lists (`metadata.direction: "credit"`).

Mirror the existing C2B customer-wallet credit form; only the URL and `:partnerId` path param change.

### Example

```ts
async function creditPartnerWallet(
  partnerId: string,
  idToken: string,
  body: { amount: number; currency?: string; description?: string },
) {
  const res = await fetch(
    `${B2B_PORTAL_BASE}/platform/partners/${partnerId}/wallet/credit`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${idToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  const json = await res.json();
  if (!res.ok) throw new Error(json.message || json.error || "Credit failed");
  return json.data;
}
```

---

## Notes

- Credits the **partner org wallet**, not a Firebase user’s tourist fiat ledger.
- Does **not** use Paystack; this is an ops/manual adjustment.
- Partner self-topup (Add Money) remains `POST /portal/funding/checkout`.
- Deploy: `firebase deploy --only functions:b2bPortal`
