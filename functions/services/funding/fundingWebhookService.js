/**
 * @fileoverview Orchestrates funding webhook / confirm processing.
 * Never credits wallets directly — delegates to transactionService.
 */

const fundingOrderService = require("./fundingOrderService");
const fundingRailService = require("./fundingRailService");
const transactionService = require("../transactionService");
const webhookReceiptService = require("../ops/webhookReceiptService");
const { recordEvent } = require("../ops/paymentTimelineService");
const opsMetrics = require("../ops/opsMetricsService");
const paymentNotifications = require("../ops/paymentNotificationService");
const { FUNDING_STATUSES, WEBHOOK_RECEIPT_STATUSES, TIMELINE_EVENT_TYPES } = require("../../utils/fundingTypes");
const { createLogger } = require("../../utils/paymentOpsLogger");

const logger = createLogger({ service: "fundingWebhook" });

/**
 * @param {string} eventId
 * @returns {Promise<boolean>}
 */
async function isWebhookDuplicate(eventId) {
  if (!eventId) return false;
  const receipt = await webhookReceiptService.getReceipt(
      webhookReceiptService.receiptDocId("paystack", eventId),
  );
  if (!receipt) return false;
  return receipt.status === WEBHOOK_RECEIPT_STATUSES.processed ||
    receipt.status === WEBHOOK_RECEIPT_STATUSES.duplicate;
}

/**
 * @param {string} eventId
 * @param {Object} payload
 * @param {Object} [ctx]
 * @returns {Promise<void>}
 */
async function recordWebhookEvent(eventId, payload, ctx = {}) {
  if (!eventId) return;
  await webhookReceiptService.updateReceiptStatus(
      webhookReceiptService.receiptDocId("paystack", eventId),
      WEBHOOK_RECEIPT_STATUSES.processed,
      { fundingOrderId: ctx.fundingOrderId || null, correlationId: ctx.correlationId || null },
  );
}

/**
 * Process a normalized funding event (from webhook or confirm endpoint).
 *
 * @param {Object} params
 * @param {string} params.provider
 * @param {import("../../utils/fundingTypes").NormalizedFundingEvent} params.event
 * @param {string} [params.webhookEventId]
 * @returns {Promise<{ success: boolean, duplicate?: boolean, fundingOrderId?: string, error?: string }>}
 */
async function processFundingEvent(params) {
  const { provider, event, webhookEventId = null, receiptId = null } = params;
  const started = Date.now();

  if (webhookEventId && await isWebhookDuplicate(webhookEventId)) {
    return { success: true, duplicate: true };
  }

  if (!event || !event.providerReference) {
    return { success: false, error: "Missing provider reference" };
  }

  const fundingOrder = await fundingOrderService.findByProviderReference(provider, event.providerReference);
  if (!fundingOrder) {
    if (receiptId) {
      await webhookReceiptService.updateReceiptStatus(receiptId, WEBHOOK_RECEIPT_STATUSES.failed, {
        error: "Funding order not found",
      });
    }
    return { success: false, error: "Funding order not found" };
  }

  const correlationId = fundingOrder.correlationId || fundingOrder.id;

  await recordEvent({
    fundingOrderId: fundingOrder.id,
    correlationId,
    eventType: TIMELINE_EVENT_TYPES.webhook_received,
    provider,
    status: event.status,
    idempotencyKey: webhookEventId || undefined,
    metadata: { providerReference: event.providerReference },
  });

  if (fundingOrder.status === FUNDING_STATUSES.completed) {
    if (webhookEventId) {
      await recordWebhookEvent(webhookEventId, event, {
        fundingOrderId: fundingOrder.id,
        correlationId,
      });
    }
    return { success: true, duplicate: true, fundingOrderId: fundingOrder.id };
  }

  if (event.status === "failed") {
    await fundingOrderService.updateFundingOrder(fundingOrder.id, {
      status: FUNDING_STATUSES.failed,
      failureReason: event.failureReason || "Payment failed",
      providerTransactionId: event.providerTransactionId || fundingOrder.providerTransactionId,
    });
    await recordEvent({
      fundingOrderId: fundingOrder.id,
      correlationId,
      eventType: TIMELINE_EVENT_TYPES.funding_failed,
      provider,
      status: FUNDING_STATUSES.failed,
      metadata: { reason: event.failureReason },
    });
    await paymentNotifications.notifyFundingFailed({
      userId: fundingOrder.userId,
      fundingOrderId: fundingOrder.id,
      reason: event.failureReason,
      correlationId,
    });
    await opsMetrics.increment("funding.failed", 1);
    if (webhookEventId) {
      await recordWebhookEvent(webhookEventId, event, {
        fundingOrderId: fundingOrder.id,
        correlationId,
      });
    }
    return { success: true, fundingOrderId: fundingOrder.id };
  }

  if (event.status !== "success") {
    return { success: true, fundingOrderId: fundingOrder.id };
  }

  const verified = await fundingRailService.verifyPayment(provider, event.providerReference);
  if (verified.status !== "success") {
    return { success: false, error: "Payment verification failed" };
  }

  if (Math.abs(verified.amount - fundingOrder.amount) > 0.01) {
    return { success: false, error: "Verified amount mismatch" };
  }

  const result = await transactionService.completeFundingOrder({
    fundingOrder,
    verifiedEvent: verified,
  });

  if (result.success && !result.duplicate) {
    await recordEvent({
      fundingOrderId: fundingOrder.id,
      correlationId,
      eventType: TIMELINE_EVENT_TYPES.funding_completed,
      provider,
      status: FUNDING_STATUSES.completed,
      metadata: { transactionRecordId: result.transactionRecordId },
    });
    await opsMetrics.recordFundingVolume(fundingOrder.amount);
    await paymentNotifications.notifyFundingCompleted({
      userId: fundingOrder.userId,
      fundingOrderId: fundingOrder.id,
      amount: fundingOrder.amount,
      currency: fundingOrder.currency,
      correlationId,
    });
  }

  await recordEvent({
    fundingOrderId: fundingOrder.id,
    correlationId,
    eventType: TIMELINE_EVENT_TYPES.webhook_processed,
    provider,
    status: result.success ? FUNDING_STATUSES.completed : FUNDING_STATUSES.failed,
    metadata: { duplicate: result.duplicate },
  });

  if (webhookEventId) {
    await recordWebhookEvent(webhookEventId, event, {
      fundingOrderId: fundingOrder.id,
      correlationId,
    });
  }

  if (receiptId) {
    await webhookReceiptService.updateReceiptStatus(
        receiptId,
        result.success ? WEBHOOK_RECEIPT_STATUSES.processed : WEBHOOK_RECEIPT_STATUSES.failed,
        { fundingOrderId: fundingOrder.id, correlationId, error: result.error || null },
    );
  }

  await opsMetrics.recordTiming("webhook.processing", Date.now() - started);
  logger.info("funding.event.processed", {
    correlationId,
    fundingOrderId: fundingOrder.id,
    success: result.success,
    duplicate: result.duplicate,
  });

  return {
    success: result.success,
    duplicate: result.duplicate,
    fundingOrderId: fundingOrder.id,
    error: result.error,
  };
}

/**
 * Confirm a funding order by server-side verify (client redirect fallback).
 *
 * @param {string} userId
 * @param {string} fundingOrderId
 * @returns {Promise<Object>}
 */
async function confirmFundingOrder(userId, fundingOrderId) {
  const order = await fundingOrderService.getFundingOrderForUser(userId, fundingOrderId);
  if (!order) {
    const err = new Error("Funding order not found");
    err.statusCode = 404;
    throw err;
  }

  if (order.status === FUNDING_STATUSES.completed) {
    return { success: true, duplicate: true, fundingOrder: order };
  }

  const verified = await fundingRailService.verifyPayment(order.provider, order.providerReference);
  return processFundingEvent({
    provider: order.provider,
    event: verified,
  });
}

module.exports = {
  isWebhookDuplicate,
  recordWebhookEvent,
  processFundingEvent,
  confirmFundingOrder,
};
