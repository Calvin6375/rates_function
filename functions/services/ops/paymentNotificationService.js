/**
 * @fileoverview Tourist Payments notifications — funding and settlement events.
 */

const { createNotification, NOTIFICATION_TYPES } = require("../../utils/notifications");
const { defaultLogger } = require("../../utils/paymentOpsLogger");

/** Extend notification types for tourist payments */
const PAYMENT_NOTIFICATION_TYPES = Object.freeze({
  ...NOTIFICATION_TYPES,
  FUNDING_COMPLETED: "funding_completed",
  FUNDING_FAILED: "funding_failed",
  MERCHANT_PAYMENT_COMPLETED: "merchant_payment_completed",
  MERCHANT_PAYMENT_FAILED: "merchant_payment_failed",
});

/**
 * @param {Object} params
 * @returns {Promise<void>}
 */
async function notifyFundingCompleted(params) {
  const { userId, fundingOrderId, amount, currency = "USD", correlationId = null } = params;
  if (!userId) return;

  try {
    await createNotification({
      userId,
      type: PAYMENT_NOTIFICATION_TYPES.FUNDING_COMPLETED,
      title: "Wallet funded",
      message: `Your wallet has been credited with ${currency} ${Number(amount).toFixed(2)}.`,
      metadata: { fundingOrderId, correlationId, amount, currency },
    });
  } catch (err) {
    defaultLogger.warn("notification.funding.completed.failed", { userId, error: err.message });
  }
}

/**
 * @param {Object} params
 * @returns {Promise<void>}
 */
async function notifyFundingFailed(params) {
  const { userId, fundingOrderId, reason, correlationId = null } = params;
  if (!userId) return;

  try {
    await createNotification({
      userId,
      type: PAYMENT_NOTIFICATION_TYPES.FUNDING_FAILED,
      title: "Funding failed",
      message: reason || "Your payment could not be completed. Please try again.",
      metadata: { fundingOrderId, correlationId, reason },
    });
  } catch (err) {
    defaultLogger.warn("notification.funding.failed.failed", { userId, error: err.message });
  }
}

/**
 * @param {Object} params
 * @returns {Promise<void>}
 */
async function notifySettlementCompleted(params) {
  const { userId, merchantPaymentId, amountUsd, amountKes } = params;
  if (!userId) return;

  try {
    await createNotification({
      userId,
      type: PAYMENT_NOTIFICATION_TYPES.MERCHANT_PAYMENT_COMPLETED,
      title: "Payment sent",
      message: `KES ${Number(amountKes).toFixed(0)} sent to merchant (USD ${Number(amountUsd).toFixed(2)}).`,
      metadata: { merchantPaymentId, amountUsd, amountKes },
    });
  } catch (err) {
    defaultLogger.warn("notification.settlement.completed.failed", { userId, error: err.message });
  }
}

/**
 * @param {Object} params
 * @returns {Promise<void>}
 */
async function notifySettlementFailed(params) {
  const { userId, merchantPaymentId, reason } = params;
  if (!userId) return;

  try {
    await createNotification({
      userId,
      type: PAYMENT_NOTIFICATION_TYPES.MERCHANT_PAYMENT_FAILED,
      title: "Merchant payment failed",
      message: reason || "Your merchant payment could not be completed. Funds have been released.",
      metadata: { merchantPaymentId, reason },
    });
  } catch (err) {
    defaultLogger.warn("notification.settlement.failed.failed", { userId, error: err.message });
  }
}

module.exports = {
  PAYMENT_NOTIFICATION_TYPES,
  notifyFundingCompleted,
  notifyFundingFailed,
  notifySettlementCompleted,
  notifySettlementFailed,
};
