/**
 * @fileoverview Job A — provider recovery for stale pending funding orders.
 */

const config = require("../../config");
const { collection } = require("../../libs/firestore");
const fundingOrderService = require("./fundingOrderService");
const fundingRailService = require("./fundingRailService");
const fundingWebhookService = require("./fundingWebhookService");
const { FUNDING_STATUSES, isTerminalFundingStatus } = require("../../utils/fundingTypes");
const { createLogger } = require("../../utils/paymentOpsLogger");
const { recordEvent } = require("../ops/paymentTimelineService");
const { TIMELINE_EVENT_TYPES } = require("../../utils/fundingTypes");
const opsMetrics = require("../ops/opsMetricsService");

const logger = createLogger({ service: "fundingReconciliation" });
const STALE_MS = (config.funding.reconcileStaleMinutes || 20) * 60 * 1000;

/**
 * @returns {Promise<{ scanned: number, recovered: number, failed: number, errors: Array }>}
 */
async function reconcileStaleFundingOrders() {
  const cutoff = new Date(Date.now() - STALE_MS);
  const snap = await collection(config.collections.fundingOrders)
      .where("status", "in", [FUNDING_STATUSES.pending, FUNDING_STATUSES.processing])
      .limit(100)
      .get();

  let scanned = 0;
  let recovered = 0;
  let failed = 0;
  /** @type {Array<{ fundingOrderId: string, error: string }>} */
  const errors = [];

  for (const doc of snap.docs) {
    const data = doc.data();
    const createdAt = data.createdAt?.toDate?.();
    if (createdAt && createdAt > cutoff) {
      continue;
    }
    if (isTerminalFundingStatus(data.status)) {
      continue;
    }

    scanned++;
    const fundingOrderId = doc.id;

    try {
      const verified = await fundingRailService.verifyPayment(data.provider, data.providerReference);

      if (verified.status === "success") {
        const result = await fundingWebhookService.processFundingEvent({
          provider: data.provider,
          event: verified,
          webhookEventId: `recon_${fundingOrderId}_${verified.providerTransactionId || verified.providerReference}`,
        });

        if (result.success) {
          recovered++;
          await recordEvent({
            fundingOrderId,
            correlationId: data.correlationId || fundingOrderId,
            eventType: TIMELINE_EVENT_TYPES.reconciliation_recovery,
            provider: data.provider,
            status: FUNDING_STATUSES.completed,
            metadata: { source: "reconcileFundingOrders", duplicate: result.duplicate },
          });
          await opsMetrics.increment("funding.reconciliationRecovered", 1);
        } else {
          failed++;
          errors.push({ fundingOrderId, error: result.error || "process failed" });
        }
      } else if (verified.status === "failed") {
        await fundingOrderService.updateFundingOrder(fundingOrderId, {
          status: FUNDING_STATUSES.failed,
          failureReason: verified.failureReason || "Provider reported failure during reconciliation",
        });
        failed++;
        await opsMetrics.increment("funding.reconciliationFailed", 1);
      }
    } catch (err) {
      failed++;
      errors.push({ fundingOrderId, error: err.message });
      logger.error("reconcile.stale.failed", { fundingOrderId, error: err.message });
    }
  }

  await opsMetrics.increment("funding.reconciliationScanned", scanned);

  return { scanned, recovered, failed, errors };
}

module.exports = {
  reconcileStaleFundingOrders,
};
