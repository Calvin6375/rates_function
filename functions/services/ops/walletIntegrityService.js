/**
 * @fileoverview Job B — read-only wallet / ledger integrity checks (daily).
 */

const config = require("../../config");
const { collection } = require("../../libs/firestore");
const fiatLedgerService = require("../ledger/fiatLedgerService");
const { createLogger } = require("../../utils/paymentOpsLogger");
const opsMetrics = require("./opsMetricsService");
const { recordEvent } = require("./paymentTimelineService");
const { TIMELINE_EVENT_TYPES } = require("../../utils/fundingTypes");

const logger = createLogger({ service: "walletIntegrity" });
const TOLERANCE = 0.01;

/**
 * Compare users.usdBalance vs fiatLedger aggregate for a user.
 * @param {string} userId
 * @returns {Promise<{ ok: boolean, userBalance: number, ledgerBalance: number, delta: number }>}
 */
async function checkUserFiatIntegrity(userId) {
  const [userDoc, ledgerBalance] = await Promise.all([
    collection(config.collections.users).doc(userId).get(),
    fiatLedgerService.getLedgerBalance(userId, "USD"),
  ]);

  const userBalance = userDoc.exists ? Number(userDoc.data().usdBalance || 0) : 0;
  const delta = userBalance - ledgerBalance;
  const ok = Math.abs(delta) <= TOLERANCE;

  return { ok, userBalance, ledgerBalance, delta };
}

/**
 * @param {number} [limit=200]
 * @returns {Promise<{ checked: number, mismatches: number, details: Array }>}
 */
async function runWalletIntegrityCheck(limit = 200) {
  const snap = await collection(config.collections.walletAggregatesFiat)
      .limit(limit)
      .get();

  let checked = 0;
  let mismatches = 0;
  /** @type {Array<Object>} */
  const details = [];

  for (const doc of snap.docs) {
    const userId = doc.id;
    checked++;

    try {
      const result = await checkUserFiatIntegrity(userId);
      if (!result.ok) {
        mismatches++;
        details.push({ userId, ...result });
        logger.warn("integrity.mismatch", { userId, ...result });
        await opsMetrics.increment("integrity.fiatMismatch", 1);
      }
    } catch (err) {
      logger.error("integrity.check.failed", { userId, error: err.message });
      details.push({ userId, error: err.message });
    }
  }

  await opsMetrics.increment("integrity.usersChecked", checked);

  if (mismatches > 0) {
    await recordEvent({
      fundingOrderId: "system_integrity",
      correlationId: `integrity_${new Date().toISOString().slice(0, 10)}`,
      eventType: TIMELINE_EVENT_TYPES.integrity_check,
      status: "mismatch",
      metadata: { checked, mismatches, sample: details.slice(0, 5) },
      source: "reconcileWalletIntegrity",
    });
  }

  return { checked, mismatches, details };
}

module.exports = {
  checkUserFiatIntegrity,
  runWalletIntegrityCheck,
};
