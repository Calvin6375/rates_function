# Customer USDC sweep to TruePay Treasury

After a **mainnet** deposit is credited on the user ledger, the backend moves that Avalanche C-Chain USDC from the customer's deposit address to the company treasury. Fuji / testnet wallets are never swept. The user's app balance does not change. Mainnet off-ramp / `POST /crypto/send` spends from the treasury; Fuji sends still leave the customer testnet address.

This is an omnibus rail: **ledger = customer balance**, **treasury = company float**.

## What does not change

- `ledgerService` still credits the deposit. Sweeps never debit or credit the user.
- RTDB `wallet/{uid}/crypto/USDC` still follows the ledger.
- The admin TruePay Treasury widget remains a live on-chain read of the treasury address. After sweeps succeed (and treasury has AVAX for gas), that USDC balance should rise.
- Customer deposit addresses stay the receive addresses. Do not show the treasury address to customers.

## Flow

1. Monitor confirms a mainnet USDC `Transfer` to a live Turnkey customer address.
2. `creditDeposit` appends a ledger `deposit` and a `cryptoTransactions` row.
3. On **avalanche** only, `enqueueSweepAfterCredit` writes `cryptoSweeps/avalanche_{txHash}_{logIndex}`. Fuji credits are not enqueued.
4. `monitorCryptoChainMainnet` runs `runSweepCycle` once a day at **08:00 Africa/Nairobi**:
   - optionally enqueues leftover **mainnet** customer USDC credited before this feature
   - funds customer gas from treasury AVAX if needed (~0.01 AVAX)
   - sends the customer's on-chain USDC to `CRYPTO_TREASURY_ADDRESS`
5. Mainnet `POST /crypto/send` reserves ledger funds and signs from treasury. Fuji sends still leave the customer testnet address.

Firestore collection key is `config.collections.cryptoSweeps` (`cryptoSweeps`). Backend-only; clients do not write it.

## `cryptoSweeps` fields

| Field | Meaning |
|-------|---------|
| `status` | `pending` / `complete` / `failed` |
| `type` | `deposit` or `outstanding` |
| `fromAddress` | Customer deposit address |
| `toAddress` | Treasury |
| `amount` | Credited USDC (6 dp) |
| `network` / `chainId` | `avalanche` (43114) only |
| `depositReferenceId` | Ledger reference (`txHash_logIndex`) |
| `sweepTxHash` | Customer → treasury USDC tx |
| `gasTxHash` | Treasury → customer AVAX top-up, if any |
| `lastError` | Last failure. `INSUFFICIENT_GAS` stays `pending` for retry |

Doc id is `{network}_{referenceId}`. Complete and pending rows are not re-enqueued.

## Gas

Customer deposit addresses typically have **0 AVAX**. The sweep:

1. Estimates USDC-transfer gas on the customer's address.
2. If the customer cannot pay it, treasury sends AVAX first.
3. Then the customer address sends USDC to treasury.

If the treasury has **0 AVAX**, sweeps stay `pending` with `Treasury has insufficient AVAX to fund sweep gas`. Fund the treasury with AVAX on Avalanche C-Chain (`43114`) before leftover or new deposits will move.

Send/off-ramp also spends treasury AVAX for gas.

## Ops

- Treasury address comes from `CRYPTO_TREASURY_ADDRESS` / `config.cryptoRail.treasuryAddress` (Turnkey-controlled). Do not hard-code it in the app.
- After deploy, existing credited customer USDC is picked up as `type: outstanding` at the next **08:00 Africa/Nairobi** sweep. Deposit credits still run every minute.
- Flutter does not call a sweep API. Deposit and send stay ledger-based.

## Tests

```bash
cd functions
./node_modules/.bin/jest test/crypto/treasurySweepService.test.js test/crypto/turnkeyRailAdapter.test.js test/crypto/chainMonitorService.test.js
```
