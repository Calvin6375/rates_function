# B2B Partner API — public sandbox

Use this environment to try the **Partner API** without creating a partner in Firestore or touching production wallets. All responses are **mocked** (fixtures + in-memory state). Successful JSON bodies include **`"sandbox": true`**.

For production integration (per-partner API keys, real Firestore), see [`B2B_docs.md`](./B2B_docs.md).

---

## Base URL (TruePay project)

This repo’s Firebase / GCP **project ID** is **`truepay-72060`** (use the same value if your integration docs call it **product_id** or environment id). Use it wherever `{projectId}` appears below.

**Production pattern**

```text
https://{region}-{projectId}.cloudfunctions.net/partnerSandbox
```

**TruePay example (`us-central1`)**

```text
https://us-central1-truepay-72060.cloudfunctions.net/partnerSandbox
```

| Placeholder | Meaning |
|-------------|---------|
| `{region}` | Same as production (repo default: `us-central1`; env `FUNCTIONS_REGION`) |
| `{projectId}` | Firebase / GCP project ID — **`truepay-72060`** for TruePay |

**Emulator (local)**

```text
http://localhost:5001/truepay-72060/{region}/partnerSandbox
```

Example:

```text
http://localhost:5001/truepay-72060/us-central1/partnerSandbox
```

Paths are the same as the live Partner API where mirrored (e.g. `.../partnerSandbox/rates`), plus sandbox helpers under `rates/` and per-transaction reads.

---

## Static API key (not issued via platform)

Every sandbox request must send:

```http
X-API-KEY: KalvoB2B-Sandbox-public-test-key-2026
```

This value is the **default** baked into the function config. You may override it per deployment with the environment variable **`B2B_SANDBOX_PUBLIC_API_KEY`** (or legacy **`B2B_SANDBOX_API_KEY`**). The virtual `partnerId` in payloads defaults to **`__b2b_sandbox__`**; override with **`B2B_SANDBOX_PARTNER_ID`** if needed.

**Security note:** The default key is public by design so anyone can test. If that is unacceptable for a given project, set `B2B_SANDBOX_PUBLIC_API_KEY` to a private value and share it only with trusted testers—or omit deploying `partnerSandbox` from that project.

---

## Suggested integration flow

1. **Currency codes** — `GET /currencies` (fiats with fixture rates, quote asset, payment / wallet codes, defaults).
2. **Discover fixture rates** — `GET /rates/all` (all sandbox fiat rows for the default asset).
3. **Quote one pair** — `GET /rates/pair` (or legacy `GET /rates`) with `fiat` and `asset` query params. Responses include **`customerPrice`** (and metadata); they do **not** include raw **`marketPrice`**.
4. **Optional checkout helper** — `POST /checkout` with amount/currency.
5. **Simulate a payment** — `POST /payments` (returns `transactionId`).
6. **Poll transaction status** — `GET /transactions/:transactionId` (single record, includes `status`).
7. **List recent activity** — `GET /transactions` (in-memory list).
8. **Wallet / settlements / SafariCoin** — `GET /wallet`, `GET /settlements`, `GET /safaricoin/balance`.

In-memory wallet and transaction state resets on **cold start** of the Cloud Function instance.

---

## Endpoints

| Order      | Method | Path | Description |
|------------|--------|------|-------------|
| 1 | `GET`  | `/currencies` | Fiat codes with fixture rates, quote `assets`, `paymentCurrencies` (wallet), defaults, deduped `all` |
| 2 | `GET`  | `/rates/all` | All fixture rates (per listed fiat × default asset, e.g. USDT); no `marketPrice` |
| 3 | `GET`  | `/rates/pair` | One pair: query `fiat`, `asset` (defaults KES / USDT); no `marketPrice` |
| — | `GET`  | `/rates` | Same as `/rates/pair` (matches live `GET /partner/rates`) |
| 4 | `POST` | `/checkout` | Checkout-style payload with fixture rate |
| 5 | `POST` | `/payments` | Simulated payment; updates **in-memory** wallet only |
| 6 | `GET`  | `/transactions/:transactionId` | Single transaction (status, amounts, metadata) |
| 7 | `GET`  | `/transactions` | In-memory list (includes simulated payments); optional `limit` |
| 8 | `GET`  | `/wallet` | In-memory balances |
| 9 | `GET`  | `/settlements` | Static fixture settlements |
| 10 | `GET` | `/safaricoin/balance` | Static fixture balance |

`OPTIONS` is supported for CORS.

---

## Examples (`truepay-72060`)

**Base for curls**

```text
https://us-central1-truepay-72060.cloudfunctions.net/partnerSandbox
```

**1. Currencies**

```bash
curl -sS "https://us-central1-truepay-72060.cloudfunctions.net/partnerSandbox/currencies" \
  -H "X-API-KEY: KalvoB2B-Sandbox-public-test-key-2026"
```

**2. All rates**

```bash
curl -sS "https://us-central1-truepay-72060.cloudfunctions.net/partnerSandbox/rates/all" \
  -H "X-API-KEY: KalvoB2B-Sandbox-public-test-key-2026"
```

**3. One pair**

```bash
curl -sS "https://us-central1-truepay-72060.cloudfunctions.net/partnerSandbox/rates/pair?fiat=KES&asset=USDT" \
  -H "X-API-KEY: KalvoB2B-Sandbox-public-test-key-2026"
```

**4. Record a payment, then 5. query that transaction**

```bash
curl -sS -X POST "https://us-central1-truepay-72060.cloudfunctions.net/partnerSandbox/payments" \
  -H "Content-Type: application/json" \
  -H "X-API-KEY: KalvoB2B-Sandbox-public-test-key-2026" \
  -d '{"amount": 1000, "currency": "KES", "reference": "demo-001"}'
```

Use the `transactionId` from the response:

```bash
curl -sS "https://us-central1-truepay-72060.cloudfunctions.net/partnerSandbox/transactions/sbx_tx_REPLACE_ME" \
  -H "X-API-KEY: KalvoB2B-Sandbox-public-test-key-2026"
```

Then `GET .../wallet` and `GET .../transactions` reflect the same in-memory run.

---

## Differences from live `partner`

| Topic    | `partnerSandbox` | Live `partner` |
|----------|------------------|----------------|
| Base URL | `.../partnerSandbox` | `.../partner` |
| API key  | Static public default (or env override) | Unique key per partner from Firestore |
| Data     | Memory + fixtures | Firestore / real services |
| Binance / bank | Not called for sandbox rates | Live or cached production paths |
| Currencies | `GET /currencies` | Not on `partner` in this repo |
| Rates | `/rates/all`, `/rates/pair`, `/rates` (no `marketPrice` in JSON) | `GET /rates` (includes `marketPrice`) |
| Transaction by id | `GET /transactions/:id` (memory) | Not exposed on partner API in this repo |

The B2B **portal** (`b2bPortal`, Firebase Bearer) is unchanged; this sandbox covers only the **machine Partner API** surface.
