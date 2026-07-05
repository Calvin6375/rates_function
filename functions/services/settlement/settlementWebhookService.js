/**
 * @fileoverview Daraja B2B callback processing — complete or fail settlement jobs.
 */

const config = require("../../config");
const { collection, serverTimestamp } = require("../../libs/firestore");
const settlementRailService = require("./settlementRailService");
const merchantSettlementService = require("./merchantSettlementService");
const fiatReservationService = require("../ledger/fiatReservationService");
const {
  SETTLEMENT_JOB_STATUSES,
  MERCHANT_PAYMENT_STATUSES,
} = require("../../utils/fundingTypes");
const { createLogger } = require("../../utils/paymentOpsLogger");
const { recordEvent } = require("../ops/paymentTimelineService");
const { TIMELINE_EVENT_TYPES } = require("../../utils/fundingTypes");
const paymentNotifications = require("../ops/paymentNotificationService");

const logger = createLogger({ service: "settlementWebhook" });
const SJ_COL = config.collections.settlementJobs;
const MP_COL = config.collections.merchantPayments;

/**
 * @param {Object} payload Raw Daraja callback body
 * @returns {Promise<{ success: boolean, duplicate?: boolean, error?: string }>}
 */
async function processDarajaCallback(payload) {
  const rail = settlementRailService.resolveSettlementRail();
  const normalized = rail.normalizeCallback(payload);

  if (!normalized) {
    return { success: false, error: "Unrecognized Daraja callback payload" };
  }

  const snap = await collection(SJ_COL)
      .where("providerReference", "==", normalized.providerReference)
      .limit(1)
      .get();

  if (snap.empty) {
    logger.warn("daraja.callback.no_job", { providerReference: normalized.providerReference });
    return { success: true, error: "No matching settlement job" };
  }

  const jobDoc = snap.docs[0];
  const job = { id: jobDoc.id, ...jobDoc.data() };

  if (job.status === SETTLEMENT_JOB_STATUSES.completed) {
    return { success: true, duplicate: true };
  }

  const mpDoc = await collection(MP_COL).doc(job.merchantPaymentId).get();
  if (!mpDoc.exists) {
    return { success: false, error: "Merchant payment not found" };
  }
  const mp = mpDoc.data();

  if (normalized.status === "success") {
    await merchantSettlementService.completeMerchantPayment({
      userId: mp.userId,
      mpId: job.merchantPaymentId,
      sjId: job.id,
      merchantId: mp.merchantId,
      numericUsd: Number(mp.amountUsd),
      amountKes: Number(mp.amountKes),
      fxRate: Number(mp.fxRate),
      requestId: mp.requestId,
      metadata: mp.metadata || {},
      providerReference: job.providerReference,
    });

    await recordEvent({
      fundingOrderId: job.merchantPaymentId,
      correlationId: mp.correlationId || job.merchantPaymentId,
      eventType: TIMELINE_EVENT_TYPES.settlement_completed,
      status: SETTLEMENT_JOB_STATUSES.completed,
      metadata: { providerReference: normalized.providerReference },
    });

    await paymentNotifications.notifySettlementCompleted({
      userId: mp.userId,
      merchantPaymentId: job.merchantPaymentId,
      amountUsd: Number(mp.amountUsd),
      amountKes: Number(mp.amountKes),
    });

    return { success: true };
  }

  if (normalized.status === "failed") {
    await collection(SJ_COL).doc(job.id).update({
      status: SETTLEMENT_JOB_STATUSES.failed,
      lastError: normalized.resultDesc || "Daraja callback failure",
      updatedAt: serverTimestamp(),
    });
    await collection(MP_COL).doc(job.merchantPaymentId).update({
      status: MERCHANT_PAYMENT_STATUSES.failed,
      updatedAt: serverTimestamp(),
    });
    await fiatReservationService.releaseReservation(mp.requestId);

    await recordEvent({
      fundingOrderId: job.merchantPaymentId,
      correlationId: mp.correlationId || job.merchantPaymentId,
      eventType: TIMELINE_EVENT_TYPES.settlement_failed,
      status: SETTLEMENT_JOB_STATUSES.failed,
      metadata: { resultCode: normalized.resultCode, resultDesc: normalized.resultDesc },
    });

    await paymentNotifications.notifySettlementFailed({
      userId: mp.userId,
      merchantPaymentId: job.merchantPaymentId,
      reason: normalized.resultDesc,
    });

    return { success: true };
  }

  return { success: true };
}

module.exports = {
  processDarajaCallback,
};
