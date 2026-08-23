/**
 * @fileoverview Poll IntaSend for Safari Card payouts stuck in non-terminal states.
 */

const config = require("../../config");
const { collection, serverTimestamp } = require("../../libs/firestore");
const intasendDisbursement = require("../intasend/intasendDisbursementProvider");
const safariCardPayoutService = require("./safariCardPayoutService");
const { PAYOUT_STATUS, TERMINAL_STATUSES } = require("../../utils/safariCardPayoutTypes");

const PAYOUTS_COL = config.collections.safariCardPayouts;

const RECONCILE_STATUSES = [
  PAYOUT_STATUS.PENDING,
  PAYOUT_STATUS.INITIATED,
  PAYOUT_STATUS.PROCESSING,
  PAYOUT_STATUS.RETRY,
  PAYOUT_STATUS.UNKNOWN,
];

/**
 * @param {string} payoutId
 * @returns {Promise<{ reconciled: boolean, payout: Object|null }>}
 */
async function reconcilePayout(payoutId) {
  const payout = await safariCardPayoutService.getPayoutById(payoutId);
  if (!payout) {
    return { reconciled: false, payout: null };
  }
  if (TERMINAL_STATUSES.has(payout.status)) {
    return { reconciled: false, payout };
  }
  if (!payout.providerTrackingId) {
    return { reconciled: false, payout };
  }

  const remote = await intasendDisbursement.getSendMoneyStatus(payout.providerTrackingId);
  const result = await safariCardPayoutService.applyProviderStatusUpdate(remote);

  await collection(PAYOUTS_COL).doc(payoutId).update({
    lastReconciledAt: serverTimestamp(),
  });

  return {
    reconciled: result.handled,
    payout: result.payout,
  };
}

/**
 * Reconcile in-flight payouts for a user (best-effort).
 * @param {string} userId
 * @param {number} [limit=5]
 * @returns {Promise<number>}
 */
async function reconcileUserPendingPayouts(userId, limit = 5) {
  const lim = Math.min(Math.max(parseInt(String(limit), 10) || 5, 1), 20);
  const snap = await collection(PAYOUTS_COL)
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .limit(lim)
      .get();

  let count = 0;
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    if (TERMINAL_STATUSES.has(data.status)) {
      continue;
    }
    if (!data.providerTrackingId) {
      continue;
    }
    try {
      const result = await reconcilePayout(doc.id);
      if (result.reconciled) {
        count++;
      }
    } catch (err) {
      console.warn("reconcileUserPendingPayouts:", doc.id, err.message);
    }
  }
  return count;
}

module.exports = {
  reconcilePayout,
  reconcileUserPendingPayouts,
};
