/**
 * @fileoverview Provider-aware crypto ledger reconciliation.
 * Circle path is unchanged. Turnkey compares Fuji on-chain USDC to the ledger.
 */

const {collection} = require("../../libs/firestore");
const ledgerService = require("../ledger/ledgerService");
const evmRpcService = require("./evm/evmRpcService");
const cryptoRailProvider = require("./cryptoRailProvider");
const {runCircleLedgerReconciliation} = require("../../jobs/reconcileCircleLedger");
const config = require("../../config");

const ASSET = "USDC";
const RECON_BUCKET_MS = 6 * 60 * 60 * 1000;

/**
 * Fuji/test default is off. Only credit/debit the ledger when explicitly enabled.
 * @returns {boolean}
 */
function isReconcileAutoAdjustEnabled() {
  const raw = process.env.CRYPTO_RECONCILE_AUTO_ADJUST;
  if (raw != null && String(raw).trim() !== "") {
    return String(raw).toLowerCase() === "true";
  }
  return config.cryptoRail.reconcileAutoAdjust === true;
}

/**
 * Compare Turnkey/Fuji on-chain USDC to TruePay ledger.
 * Auto-adjust uses the same idempotent bucket pattern as Circle when enabled.
 * @returns {Promise<{ checked: number, adjusted: number, drifted: number, errors: Array }>}
 */
async function runTurnkeyLedgerReconciliation() {
  const snap = await collection("cryptoWallets")
      .where("provider", "==", "turnkey")
      .limit(500)
      .get();

  let checked = 0;
  let adjusted = 0;
  let drifted = 0;
  const errors = [];
  const bucket = Math.floor(Date.now() / RECON_BUCKET_MS);
  const autoAdjust = isReconcileAutoAdjustEnabled();

  for (const doc of snap.docs) {
    const wallet = doc.data();
    const userId = wallet.userId;
    const address = wallet.address;
    if (!userId || !address) continue;

    checked++;
    try {
      const [onChain, ledgerBalance] = await Promise.all([
        evmRpcService.getOnChainBalances(address),
        ledgerService.getLedgerBalance(userId, ASSET),
      ]);

      const delta = onChain.usdc - ledgerBalance;
      if (Math.abs(delta) < 0.000001) continue;

      drifted++;
      const referenceId = `recon_${userId}_${bucket}_${Math.round(onChain.usdc * 1e6)}`;

      console.warn("reconcileCryptoLedger: turnkey discrepancy", {
        userId,
        address,
        onChainUsdc: onChain.usdc,
        ledgerBalance,
        delta,
        autoAdjust,
        referenceId,
      });

      if (!autoAdjust) continue;
      if (await ledgerService.hasLedgerEntry(referenceId)) continue;

      await ledgerService.appendReconciliationAdjustment({
        userId,
        asset: ASSET,
        amount: Math.abs(delta),
        direction: delta > 0 ? "credit" : "debit",
        referenceId,
      });
      adjusted++;
    } catch (err) {
      errors.push({userId, address, error: err.message});
      console.error("reconcileCryptoLedger: turnkey user failed", {
        userId,
        error: err.message,
      });
    }
  }

  return {provider: "turnkey", checked, adjusted, drifted, errors};
}

/**
 * @returns {Promise<Object>}
 */
async function runCryptoLedgerReconciliation() {
  const provider = cryptoRailProvider.getCryptoRailProviderName();
  if (provider === "turnkey") {
    return runTurnkeyLedgerReconciliation();
  }
  const result = await runCircleLedgerReconciliation();
  return {provider: "circle", ...result};
}

module.exports = {
  isReconcileAutoAdjustEnabled,
  runTurnkeyLedgerReconciliation,
  runCryptoLedgerReconciliation,
};
