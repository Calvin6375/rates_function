/**
 * @fileoverview Settlement retry engine — exponential backoff + dead letter.
 */

const config = require("../../config");
const { collection, serverTimestamp } = require("../../libs/firestore");
const settlementRailService = require("./settlementRailService");
const merchantSettlementService = require("./merchantSettlementService");
const {
  SETTLEMENT_JOB_STATUSES,
  SETTLEMENT_JOB_STATUSES_EXTENDED,
  MERCHANT_PAYMENT_STATUSES,
} = require("../../utils/fundingTypes");
const { createLogger } = require("../../utils/paymentOpsLogger");
const { recordEvent } = require("../ops/paymentTimelineService");
const { TIMELINE_EVENT_TYPES } = require("../../utils/fundingTypes");
const opsMetrics = require("../ops/opsMetricsService");

const logger = createLogger({ service: "settlementRetry" });
const SJ_COL = config.collections.settlementJobs;
const MP_COL = config.collections.merchantPayments;
const MAX_RETRIES = config.fiatOps.settlementMaxRetries || 5;
const BASE_MS = config.fiatOps.settlementRetryBaseMs || 60000;

/**
 * @param {number} retryCount
 * @returns {number}
 */
function backoffMs(retryCount) {
  return BASE_MS * Math.pow(2, Math.min(retryCount, 6));
}

/**
 * @param {Object} job
 * @returns {Promise<{ retried: boolean, completed?: boolean, deadLetter?: boolean }>}
 */
async function retrySettlementJob(job) {
  const jobId = job.id;
  const retryCount = Number(job.retryCount || 0);

  if (retryCount >= MAX_RETRIES) {
    await collection(SJ_COL).doc(jobId).update({
      status: SETTLEMENT_JOB_STATUSES_EXTENDED.dead_letter,
      lastError: job.lastError || "Max retries exceeded",
      updatedAt: serverTimestamp(),
    });
    await opsMetrics.increment("settlement.deadLetter", 1);
    return { retried: false, deadLetter: true };
  }

  const rail = settlementRailService.resolveSettlementRail(job.provider);
  const statusResult = await rail.queryPaymentStatus(job.providerReference);

  if (statusResult.status === "completed" || statusResult.status === "success") {
    const mpDoc = await collection(MP_COL).doc(job.merchantPaymentId).get();
    if (!mpDoc.exists) {
      return { retried: false };
    }
    const mp = mpDoc.data();

    await merchantSettlementService.completeMerchantPayment({
      userId: mp.userId,
      mpId: job.merchantPaymentId,
      sjId: jobId,
      merchantId: mp.merchantId,
      numericUsd: Number(mp.amountUsd),
      amountKes: Number(mp.amountKes),
      fxRate: Number(mp.fxRate),
      requestId: mp.requestId,
      metadata: mp.metadata || {},
      providerReference: job.providerReference,
    });

    await opsMetrics.recordMerchantVolume(Number(mp.amountUsd));
    return { retried: true, completed: true };
  }

  if (statusResult.status === "failed") {
    await collection(SJ_COL).doc(jobId).update({
      status: SETTLEMENT_JOB_STATUSES.failed,
      lastError: "Provider reported failure",
      updatedAt: serverTimestamp(),
    });
    await collection(MP_COL).doc(job.merchantPaymentId).update({
      status: MERCHANT_PAYMENT_STATUSES.failed,
      updatedAt: serverTimestamp(),
    });
    return { retried: false };
  }

  const nextRetry = retryCount + 1;
  const mpDoc = await collection(MP_COL).doc(job.merchantPaymentId).get();
  const mpData = mpDoc.exists ? mpDoc.data() : {};

  await collection(SJ_COL).doc(jobId).update({
    retryCount: nextRetry,
    nextRetryAt: new Date(Date.now() + backoffMs(nextRetry)),
    updatedAt: serverTimestamp(),
  });

  await recordEvent({
    fundingOrderId: job.merchantPaymentId,
    correlationId: mpData.correlationId || job.merchantPaymentId,
    eventType: TIMELINE_EVENT_TYPES.settlement_retry,
    status: SETTLEMENT_JOB_STATUSES.processing,
    metadata: { jobId, retryCount: nextRetry },
  });

  await opsMetrics.increment("settlement.retries", 1);
  logger.info("settlement.retry.scheduled", { jobId, retryCount: nextRetry });

  return { retried: true };
}

/**
 * @returns {Promise<{ scanned: number, retried: number, completed: number, deadLetter: number }>}
 */
async function processRetryableJobs() {
  const snap = await collection(SJ_COL)
      .where("status", "==", SETTLEMENT_JOB_STATUSES.processing)
      .limit(50)
      .get();

  let scanned = 0;
  let retried = 0;
  let completed = 0;
  let deadLetter = 0;

  for (const doc of snap.docs) {
    const job = { id: doc.id, ...doc.data() };
    const nextRetryAt = job.nextRetryAt?.toDate?.() || job.createdAt?.toDate?.();
    if (nextRetryAt && nextRetryAt > new Date()) {
      continue;
    }

    scanned++;
    try {
      const result = await retrySettlementJob(job);
      if (result.completed) completed++;
      if (result.deadLetter) deadLetter++;
      if (result.retried) retried++;
    } catch (err) {
      logger.error("settlement.retry.failed", { jobId: job.id, error: err.message });
      await collection(SJ_COL).doc(job.id).update({
        lastError: err.message,
        updatedAt: serverTimestamp(),
      });
    }
  }

  return { scanned, retried, completed, deadLetter };
}

module.exports = {
  retrySettlementJob,
  processRetryableJobs,
  backoffMs,
};
