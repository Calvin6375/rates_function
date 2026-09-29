# Grid sandbox C2B funding

Lightspark Grid is a USD funding rail on the existing `createPayment` path. KES top-ups stay on Paystack. Grid does not replace the TruePay ledger, and it does not touch merchant settlement or M-Pesa.

Set `FUNDING_USD_PROVIDER=paystack` to send USD top-ups back through the previous Paystack KES checkout.

## Environment

Grid sandbox and production share one base URL. The API token selects the environment. `GRID_ENVIRONMENT` is TruePay's own gate for the sandbox fund helper.

| Name | Where | Purpose |
|---|---|---|
| `GRID_CLIENT_ID` | Secret Manager | Basic-auth username. Sandbox token from the Grid dashboard. |
| `GRID_CLIENT_SECRET` | Secret Manager | Basic-auth password. Never sent to Flutter. |
| `GRID_WEBHOOK_PUBLIC_KEY` | Secret Manager | PEM public key from Grid dashboard → Developers → webhooks. |
| `GRID_ENVIRONMENT` | Function env | `sandbox` for this integration. Any other value disables `gridSandboxFund`. |
| `GRID_API_BASE_URL` | Optional env | Default `https://api.lightspark.com/grid/2025-10-13`. |
| `FUNDING_USD_PROVIDER` | Function env | `grid` (default) or `paystack`. |
| `FUNDING_DEFAULT_PROVIDER` | Function env | Unchanged. Still `paystack`. It does not route USD. |

```bash
firebase functions:secrets:set GRID_CLIENT_ID
firebase functions:secrets:set GRID_CLIENT_SECRET
firebase functions:secrets:set GRID_WEBHOOK_PUBLIC_KEY
```

Set `GRID_ENVIRONMENT=sandbox` and `FUNDING_USD_PROVIDER=grid` on the functions that call Grid (`createPayment`, `api`, `handleGridWebhook`, `gridSandboxFund`). Do not put these values in the Flutter app.

Webhook URL to register in the Grid dashboard:

```text
https://us-central1-<project>.cloudfunctions.net/handleGridWebhook
```

## Provider routing

`createPayment` and `POST /funding/orders` (when the body omits `provider`):

| Currency | Provider |
|---|---|
| `USD` | `FUNDING_USD_PROVIDER` (`grid` unless set to `paystack`) |
| `KES` and every other currency | Paystack, including the existing KES conversion and fee |

An explicit `provider` on `POST /funding/orders` is honored. The callable ignores a client `provider` field.

## Customer and account mapping

One Grid customer per TruePay user. Lookup order:

1. `users/{uid}.grid.customerId`
2. `GET /customers?platformCustomerId={uid}`
3. `POST /customers` with `customerType: INDIVIDUAL`, `platformCustomerId` = uid, `currencies: ["USD"]`, the user's email, and `fullName` from `firstName` + `lastName` (or the user profile). Grid sandbox rejects a create that omits either.

The USD account is the auto-provisioned `INTERNAL_FIAT` account from `GET /customers/internal-accounts?customerId=&currency=USD`. It is reused on later top-ups. On an unregulated platform Grid does not create that account until `agreementConsents` is recorded. If the list is empty, TruePay loads `GET /customers/agreements` and `PATCH /customers/{id}` with the missing acceptances (`CLICK_TO_ACCEPT`, the caller's IP, and the version Grid returned), then lists again.

`POST /internal-accounts` only creates `RULE_BASED` accounts, which require a sweep destination and do not hold a balance. The C2B path does not call it. The adapter still exposes `createInternalAccount` for that documented endpoint.

Firestore:

```text
users/{uid}.grid
  customerId
  platformCustomerId
  usdInternalAccountId
  updatedAt

gridCustomerLinks/{gridCustomerId}
  userId
  customerId
  usdInternalAccountId
  updatedAt
```

Deploy the new `fundingOrders` index (`userId` + `provider` + `status`) before webhook matching in production.

## USD funding flow

```text
Flutter createPayment { amount, currency: "USD" }
  → c2bFundingBridgeService
  → fundingOrders/{fund_...} status=pending provider=grid
  → Grid customer (create or reuse)
  → Grid USD internal account (reuse)
  → funding instructions
  → response.fundingInstructions
```

The funding order is written before any Grid call. A Grid error marks that order `failed` and does not credit the ledger.

`createPayment` does not invent a checkout URL. For Grid, `checkoutUrl`, `url`, and `authorization_url` are `null`. Bank details are the `USD_ACCOUNT` object Grid returned, under `fundingInstructions` (and the full `fundingPaymentInstructions` array). Fields such as `accountNumber`, `routingNumber`, `bankName`, and `intermediaryBankName` are passed through when Grid sends them.

The TruePay order stays the business record:

```text
fundingOrders/{fund_...}
  userId, amount, currency: USD, provider: grid, status
  providerCustomerId
  providerAccountId
  metadata.fundingInstructions
  metadata.requestedAmount / requestedCurrency
```

The Grid balance is not the user's TruePay balance.

## Webhook

`POST` `handleGridWebhook`

1. Read the raw body.
2. Verify `X-Grid-Signature` with `GRID_WEBHOOK_PUBLIC_KEY` (base64, or JSON `{"v":"1","s":"<base64>"}`, SHA-256).
3. Ignore anything that is not `INCOMING_PAYMENT.*`. `TEST` is acknowledged and not credited.
4. Dedupe on the Grid webhook `id` via `webhookReceipts`.
5. Match an open `grid` funding order for that customer and amount. The same Grid transaction id always maps to the same order.
6. `GET /transactions/{id}` and require status `COMPLETED` and the same USD amount.
7. `fundingWebhookService` → `transactionService.completeFundingOrder` credits the fiat ledger once.

The handler does not write the ledger itself. A second delivery of the same event returns 200 and does not credit again. The ledger reference is `fund_grid_{gridTransactionId}`.

Client `POST /funding/confirm` cannot complete a Grid order that has no Grid transaction id yet.

## Sandbox test

`gridSandboxFund` is served only when `GRID_ENVIRONMENT=sandbox`. It calls `POST /sandbox/internal-accounts/{accountId}/fund` with the order amount in cents. It does not credit TruePay. Wait for the webhook.

1. Sign in a TruePay user in the C2B app.
2. Call `createPayment` with `{ "amount": 100, "currency": "USD" }`.
3. Confirm the response `provider` is `grid`, `checkoutUrl` is null, and `fundingInstructions.accountOrWalletInfo` has the bank fields Grid returned.
4. Confirm `users/{uid}.grid.customerId` and `usdInternalAccountId` exist. Call `createPayment` again and confirm those ids did not change.
5. As that user, `POST` `gridSandboxFund` with `{ "fundingOrderId": "<orderId>" }` and a Firebase ID token.
6. Grid sends `INCOMING_PAYMENT.COMPLETED` to `handleGridWebhook`.
7. Confirm the funding order is `completed` once, and the USD fiat balance increased once. Deliver the same webhook again and confirm the balance does not move.

KES `createPayment` should still return a Paystack `checkoutUrl`.

## Disable Grid

```text
FUNDING_USD_PROVIDER=paystack
```

USD top-ups go back to Paystack KES checkout. Existing Paystack orders and webhooks are unchanged. Set `GRID_ENVIRONMENT` to a value other than `sandbox` to make `gridSandboxFund` return 404.

## Not in this change

Production Grid keys, KYC completion, KES conversion, merchant settlement, Daraja, and M-Pesa payouts are unchanged. A received amount that does not match the funding order is not credited. Two pending USD orders for the same amount are matched oldest-first.
