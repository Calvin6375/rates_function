# Funding Ops Runbook

Operational guide for Tourist Payments production hardening.

## Scheduled Functions

| Export | Schedule | Secrets |
|--------|----------|---------|
| `reconcileFundingOrders` | `*/15 * * * *` | PAYSTACK_SECRET_KEY |
| `releaseExpiredReservations` | `*/10 * * * *` | — |
| `retrySettlementJobs` | `*/5 * * * *` | DARAJA_* |
| `reconcileWalletIntegrity` | `0 3 * * *` | — |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FUNDING_RECONCILE_STALE_MINUTES` | 20 | Pending order age before recon attempts verify |
| `FUNDING_IDEMPOTENCY_TTL_HOURS` | 24 | Idempotency-Key retention |
| `FIAT_RESERVATION_TTL_MINUTES` | 30 | Reservation auto-release |
| `SETTLEMENT_MAX_RETRIES` | 5 | Max Daraja retry attempts |
| `SETTLEMENT_RETRY_BASE_MS` | 60000 | Exponential backoff base |
| `DARAJA_RESULT_URL` | — | Callback URL for live Daraja B2B |

## Metrics

Daily rollups in `opsMetricsDaily/{YYYY-MM-DD}`:

- `funding.successCount`, `funding.volumeUsd`, `funding.reconciliationRecovered`
- `settlement.successCount`, `settlement.volumeUsd`, `settlement.deadLetter`
- `integrity.fiatMismatch`, `integrity.usersChecked`

Query via `GET /funding/ops/metrics/daily`.

## Incident Response

1. **Stuck pending funding order** — Check timeline: `GET /funding/ops/timeline/{id}`. Recon job will verify with Paystack after stale threshold.
2. **Webhook received but not credited** — Check `webhookReceipts` doc; audit: `GET /funding/ops/audit/{correlationId}`.
3. **Fiat balance mismatch** — Review `reconcileWalletIntegrity` logs; compare `walletAggregatesFiat` vs `users.usdBalance`.
4. **Settlement dead letter** — Inspect `settlementJobs` where `status=dead_letter`; manual ops settlement required.

## Deploy Checklist

1. Deploy Firestore indexes: `firebase deploy --only firestore:indexes`
2. Deploy functions including new scheduled jobs
3. Set `DARAJA_RESULT_URL` to `handleDarajaCallback` URL for live Daraja
4. Verify Paystack webhook still points to `handlePaystackWebhook`
