# B2B Partner API — public sandbox

Use this environment to try the **Partner API** without creating a partner in Firestore or touching production wallets. All responses are **mocked** (fixtures + in-memory state). Successful JSON bodies include **`"sandbox": true`**.

For production integration (per-partner API keys, real Firestore), see [`B2B_docs.md`](./B2B_docs.md).

---

## Static base URL

Firebase HTTP functions use this pattern (replace placeholders with your deployment):

```text
https://{region}-{projectId}.cloudfunctions.net/partnerSandbox
```

| Placeholder | Meaning |
|-------------|---------|
| `{region}` | Same as production (repo default: `us-central1`; env `FUNCTIONS_REGION`) |
| `{projectId}` | Your Firebase / GCP project ID |

**Examples**

```text
https://us-central1-your-project-id.cloudfunctions.net/partnerSandbox
```

**Emulator (local)**

```text
http://localhost:5001/{projectId}/{region}/partnerSandbox
```

Example:

```text
http://localhost:5001/truepay-72060/us-central1/partnerSandbox
```

Paths are the same as the live Partner API, but under the **`partnerSandbox`** function name (e.g. `.../partnerSandbox/rates`).

---

## Static API key (not issued via platform)

Every sandbox request must send:

```http
X-API-KEY: KalvoB2B-Sandbox-public-test-key-2026
```

This value is the **default** baked into the function config. You may override it per deployment with the environment variable **`B2B_SANDBOX_PUBLIC_API_KEY`** (or legacy **`B2B_SANDBOX_API_KEY`**). The virtual `partnerId` in payloads defaults to **`__b2b_sandbox__`**; override with **`B2B_SANDBOX_PARTNER_ID`** if needed.

**Security note:** The default key is public by design so anyone can test. If that is unacceptable for a given project, set `B2B_SANDBOX_PUBLIC_API_KEY` to a private value and share it only with trusted testers—or omit deploying `partnerSandbox` from that project.

---

## Endpoints (mirror `partner`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/rates` | Fixture rates (`fiat`, `asset` query params; defaults KES / USDT) |
| `POST` | `/payments` | Simulated payment; updates **in-memory** wallet only |
| `GET` | `/transactions` | In-memory list (includes simulated payments) |
| `POST` | `/checkout` | Checkout-style payload with fixture rate |
| `GET` | `/settlements` | Static fixture settlements |
| `GET` | `/wallet` | In-memory balances |
| `GET` | `/safaricoin/balance` | Static fixture balance |

`OPTIONS` is supported for CORS.

---

## Example: rates

```bash
curl -sS "https://us-central1-your-project-id.cloudfunctions.net/partnerSandbox/rates?fiat=KES&asset=USDT" \
  -H "X-API-KEY: KalvoB2B-Sandbox-public-test-key-2026"
```

## Example: record a payment

```bash
curl -sS -X POST "https://us-central1-your-project-id.cloudfunctions.net/partnerSandbox/payments" \
  -H "Content-Type: application/json" \
  -H "X-API-KEY: KalvoB2B-Sandbox-public-test-key-2026" \
  -d '{"amount": 1000, "currency": "KES", "reference": "demo-001"}'
```

Then `GET .../wallet` and `GET .../transactions` reflect the in-memory run (state resets on **cold start** of the Cloud Function instance).

---

## Differences from live `partner`

| Topic | `partnerSandbox` | Live `partner` |
|--------|------------------|----------------|
| Base URL | `.../partnerSandbox` | `.../partner` |
| API key | Static public default (or env override) | Unique key per partner from Firestore |
| Data | Memory + fixtures | Firestore / real services |
| Binance / bank | Not called for sandbox rates | Live or cached production paths |

The B2B **portal** (`b2bPortal`, Firebase Bearer) is unchanged; this sandbox covers only the **machine Partner API** surface.
