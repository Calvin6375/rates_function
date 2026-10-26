/**
 * @fileoverview Reconcile Circle on-chain USDC balances against Firestore ledger.
 * Safe to run repeatedly — adjustments are idempotent by referenceId.
 */

const { collection } = require("../libs/firestore");
const ledgerService = require("../services/ledger/ledgerService");
const circleService = require("../services/circle/circleService");

const ASSET = "USDC";
const RECON_BUCKET_MS = 6 * 60 * 60 * 1000;

/**
 * Fetch Circle USDC balance for a wallet id.
 * @param {string} walletId
 * @returns {Promise<number>}
 */
async function fetchCircleUsdcBalance(walletId) {
  const client = circleService.getSdkClient();
  const response = await client.getWalletTokenBalance({ id: walletId });
  const balances = response.data?.tokenBalances || response.data?.balances || [];
  let total = 0;
  for (const row of balances) {
    const token = row?.token || row;
    const symbol = String(token?.symbol || token?.name || "").toUpperCase();
    if (symbol === "USDC") {
      total += Number(row?.amount || token?.amount || 0);
    }
  }
  return total;
}

/**
 * @returns {Promise<{ checked: number, adjusted: number, errors: Array }>}
 */
async function runCircleLedgerReconciliation() {
  if (!circleService.isCircleConfigured()) {
    console.log("reconcileCircleLedger: Circle not configured, skipping");
    return { checked: 0, adjusted: 0, errors: [] };
  }

  const snap = await collection("cryptoWallets")
      .where("provider", "==", "circle")
      .limit(500)
      .get();

  let checked = 0;
  let adjusted = 0;
  const errors = [];

  const bucket = Math.floor(Date.now() / RECON_BUCKET_MS);

  for (const doc of snap.docs) {
    const wallet = doc.data();
    const userId = wallet.userId;
    const walletId = wallet.walletId;
    if (!userId || !walletId) continue;

    checked++;
    try {
      const [circleBalance, ledgerBalance] = await Promise.all([
        fetchCircleUsdcBalance(walletId),
        ledgerService.getLedgerBalance(userId, ASSET),
      ]);

      const delta = circleBalance - ledgerBalance;
      if (Math.abs(delta) < 0.000001) continue;

      const referenceId = `recon_${userId}_${bucket}_${Math.round(circleBalance * 1e6)}`;
      if (await ledgerService.hasLedgerEntry(referenceId)) continue;

      const direction = delta > 0 ? "credit" : "debit";
      const amount = Math.abs(delta);

      await ledgerService.appendReconciliationAdjustment({
        userId,
        asset: ASSET,
        amount,
        direction,
        referenceId,
      });

      console.warn("reconcileCircleLedger: adjustment applied", {
        userId,
        walletId,
        circleBalance,
        ledgerBalance,
        delta,
        referenceId,
      });
      adjusted++;
    } catch (err) {
      errors.push({ userId, walletId, error: err.message });
      console.error("reconcileCircleLedger: user reconciliation failed", {
        userId,
        walletId,
        error: err.message,
      });
    }
  }

  return { checked, adjusted, errors };
}

module.exports.runCircleLedgerReconciliation = runCircleLedgerReconciliation;
