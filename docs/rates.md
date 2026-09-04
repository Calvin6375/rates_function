# Customer rates & cross pairs

> **RATE ENGINE INVARIANT:** Every canonical customer-book rate represents the **KES value of exactly one unit** of the currency. Public Send→Get rates are derived as **Get-units per one Send-unit**. No canonical rate is interpreted as units-per-USDT.

**Code:** `functions/utils/customerRatesResolve.js`  
**Quotes:** `functions/services/exchangeQuoteService.js`  
**Settlement capability:** `functions/services/settlementCapabilityService.js`  
**Storage:** Firestore `config/customerRates`, `exchangeQuotes`

---

## 1. Canonical model (KES numeraire)

```text
buyRate / sellRate = KES per 1 unit of that currency
```

### Authoritative Buy / Sell definition (platform-side)

Stored on each currency as KES per 1 unit. API keeps names `buyRate` / `sellRate`:

| Field | Alias | Meaning |
|-------|-------|---------|
| **`buyRate`** | `platformBuyRate` | KES value TruePay uses when **acquiring** 1 unit of the currency from the market/customer book |
| **`sellRate`** | `platformSellRate` | KES value TruePay uses when **disposing** / selling 1 unit into the book |

**Exchange customer flow** (customer sells SEND, receives GET):

```text
rate = sellRate(SEND/GET)
     = KES_send.sell / KES_get.buy
getAmount = sendAmount × rate
```

Rationale: the customer is disposing of SEND (use send **sell** side) and acquiring GET (use get **buy** side).

The engine **never auto-flips** admin-entered buy/sell values, even when one currency has buy&gt;sell and another buy&lt;sell.

### Canonical storage keys

```json
{
  "baseCurrency": "KES",
  "rateMeaning": "KES_PER_UNIT",
  "rateVersion": 12,
  "rates": {
    "ETB": { "buyRate": 1.4415, "sellRate": 1.4327 },
    "USDC": { "buyRate": 129.50, "sellRate": 128.15 }
  }
}
```

**New writes store only currency codes** (plus optional explicit pair overrides). They do **not** write `USDT/ETB` or `ETB/KES` mirrors.

### Legacy read (temporary)

| Key | Interpretation |
|-----|----------------|
| `ETB` | Canonical — KES per ETB |
| `USDT/ETB` | Legacy — same meaning (KES per ETB), **read only** |
| `ETB/KES` | Legacy — KES per ETB |
| `ETB/USDC` | **Explicit override** — USDC per ETB (not KES) |

Precedence when multiple forms exist:

1. Canonical currency key  
2. `CURRENCY/KES` / `KES/CURRENCY`  
3. Legacy `USDT/CURRENCY`  

If they **conflict**, canonical wins and a warning / `rateConflicts` diagnostic is emitted.

---

## 2. Cross formula

```text
buyRate(SEND/GET)  = KES_send.buy  / KES_get.sell
sellRate(SEND/GET) = KES_send.sell / KES_get.buy
```

Customer **sells Send, receives Get** → Exchange uses:

```text
rate = sellRate
getAmount = sendAmount × rate
```

**ETB → USDC:** `1.4327 / 129.50 ≈ 0.01106` — never `1/1.4415 ≈ 0.6937`.

Missing priced leg → **`404 MISSING_RATE`**. No silent `1.0` peg for USD/USDC/USDT.

Resolution order: `admin_exact` → `admin_inverse` → `admin_cross` → `identity`.

---

## 3. Endpoints

### Quote (Exchange)

```http
GET /api/customer-rates?send=ETB&get=USDC
GET /api/customer-rates?send=ETB&get=USDC&sendAmount=100000
```

Optional `sendAmount` creates a **locked quote** (`quoteId`, `expiresAt`, `getAmount`).

```http
POST /api/exchange-quotes
{ "send": "ETB", "get": "USDC", "sendAmount": 100000 }
```

### Book

```http
GET /api/rates
```

Returns `book` (canonical), `rates` (derived crosses), `baseCurrency`, `rateMeaning`, `rateVersion`.

### Admin

```http
PUT /api/config/fees
```

Accepts `ETB` or legacy `USDT/ETB` on input; persists **canonical keys** + bumps `rateVersion`.

Remove a currency (and `USDT/UGX`, `UGX/KES`, … aliases):

```http
PUT /api/config/fees
{ "removeCurrencies": ["UGX"] }
```

Rates live in Firestore **`config/customerRates`**, not `config/fees` (`config/fees` holds commission/`arbitrageFee` only).

### Binance (separate)

```http
GET /api/binance/rates
```

Market reference only. **Never** mutates `customerRates` on the quote path.

---

## 4. Quote locking & swap (security)

```text
Authenticated quote (POST /exchange-quotes or GET …&sendAmount=)
        → quoteId bound to userId
createSwapOrder({ quoteId })
        → settlement uses ONLY locked quote fields
```

**Client `exchangeRate` / `toAmount` / currency overrides are never trusted.**

| Path | Rate source |
|------|-------------|
| `quoteId` present | Immutable quote (ownership required) |
| Legacy no `quoteId` | Server re-resolves from KES book for USDT/USD/KES only |

| Error | Meaning |
|-------|---------|
| `MISSING_RATE` | No KES book leg |
| `QUOTE_EXPIRED` | Past `expiresAt` |
| `QUOTE_ALREADY_USED` | Replay / concurrent loser |
| `UNAUTHORIZED_QUOTE` | Wrong user or unbound quote |
| `PAIR_NOT_SETTLEABLE` | Quotable but swap ledger cannot settle |
| `QUOTE_NOT_FOUND` | Unknown quoteId |

`quotable` vs `settleable` come from `settlementCapabilityService` (swap ledger today: **USDT, USD, KES**), not from the rate math.

---

## 5. Fee convention (`FEE_ON_SEND`)

Server reads `config/fees.swapFeeRate` (decimal) or `swapFee` (percent). Default **0** (book spreads already price the FX).

```text
feeAmount      = sendAmount × feeRate     (in SEND currency)
totalDebit     = sendAmount + feeAmount
grossGetAmount = sendAmount × exchangeRate
netGetAmount   = grossGetAmount           (fee does NOT reduce Get)
```

Example (1% fee configured):

```text
100,000 ETB × 0.0110633 ≈ 1,106.33 USDC gross (= net Get)
fee = 1,000 ETB
totalDebit = 101,000 ETB
```

Client `fee` / `feeRate` are **ignored**. Locked on the quote at creation.

## 6. Client checklist

1. Authenticated quote with `sendAmount` → use `quoteId`.  
2. Use locked `rate` / `grossGetAmount` / `feeAmount` — never invent values.  
3. `createSwapOrder({ quoteId })` only — no client financial fields.  
4. On `QUOTE_EXPIRED`, request a new quote.  
5. Admin: KES per 1 unit; optional `config/fees.swapFeeRate`.

---

## 7. Accounts API (C2B wallets)

Replace Flutter `WalletRepository` RTDB reads with:

```http
GET /api/accounts
Authorization: Bearer <Firebase ID token>
```

Alias: `GET /api/wallets` (same payload).

**C2B wallets:** exactly four accounts — fiat `KES` + `USD`, crypto `USDT` + `USDC`. Rates-book currencies (ETB, GBP, …) are for quotes/exchange, not extra wallets.

```json
{
  "success": true,
  "data": {
    "userId": "<uid>",
    "fiat": [
      { "currency": "KES", "balance": 1500, "type": "fiat" }
    ],
    "crypto": [
      { "currency": "USDC", "balance": 12.5, "type": "crypto" },
      { "currency": "USDT", "balance": 0, "type": "crypto" }
    ],
    "accounts": [ "...flat fiat+crypto..." ],
    "balances": {
      "fiat": { "KES": 1500, "USD": 0 },
      "crypto": { "USDT": 0, "USDC": 12.5 }
    }
  }
}
```

| Client migration | Was | Use |
|------------------|-----|-----|
| Fiat list | `wallet/{uid}/fiat` | `data.fiat` or `data.balances.fiat` |
| Crypto list | `wallet/{uid}/crypto` | `data.crypto` or `data.balances.crypto` |
| Circle deposit address | still `cryptoApi` `GET /crypto/wallet` | unchanged |

Deploy: `firebase deploy --only functions:api`

---

## 8. Supported currencies (= former “countries”)

**Source of truth:** keys in `config/customerRates` (P2P rates book).

| Action | API |
|--------|-----|
| List supported assets | `GET /api/countries` (also partner `/countries`) |
| Add / edit / remove | `PUT /api/config/fees` only |

Response (field `countries` is **legacy name**; values are **currency codes**):

```json
{
  "success": true,
  "data": {
    "countries": ["ETB", "KES", "USDC"],
    "currencies": ["ETB", "KES", "USDC"],
    "source": "customerRates",
    "rateVersion": 12,
    "updatedAt": "...",
    "isDefault": false
  }
}
```

- Prefer `data.currencies` in new clients.
- Callable `setSupportedCountries` is **deprecated** and returns `failed-precondition`.
- Admin portal: remove the Countries tab; manage support only via P2P Rates.

---

## 9. Tests

```bash
cd functions
npm test -- test/customerRatesResolve.test.js test/exchangeQuoteService.test.js test/supportedCountriesService.test.js test/walletAccounts.test.js
```

Critical regressions: ETB→USDC ≈ 0.01106; missing USDC ≠ 0.6937; canonical-only writes; quote expiry/replay; countries list = rates book.
