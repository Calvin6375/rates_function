/**
 * @fileoverview Shared constants and normalized models for the funding layer.
 * Tourist Payments funds in USD only; FX to KES happens at settlement.
 */

/** @typedef {"paystack"|"intasend"|"transfi"|"circle"|"transak"|"bridge"|"stripe"} FundingProviderId */

/** @typedef {"pending"|"processing"|"completed"|"failed"} FundingOrderStatus */

/** @typedef {"success"|"failed"|"pending"} NormalizedPaymentStatus */

/**
 * @typedef {Object} NormalizedFundingEvent
 * @property {string} providerReference
 * @property {string} providerTransactionId
 * @property {number} amount
 * @property {string} currency
 * @property {NormalizedPaymentStatus} status
 * @property {string} [failureReason]
 */

/**
 * @typedef {Object} InitializePaymentResult
 * @property {string} checkoutUrl
 * @property {string} providerReference
 * @property {string} [providerTransactionId]
 * @property {Object} [raw]
 */

const FUNDING_PROVIDERS = Object.freeze({
  paystack: "paystack",
  intasend: "intasend",
  transfi: "transfi",
  circle: "circle",
  transak: "transak",
  bridge: "bridge",
  stripe: "stripe",
});

const FUNDING_STATUSES = Object.freeze({
  pending: "pending",
  processing: "processing",
  completed: "completed",
  failed: "failed",
});

/** Tourist Payments funding currency — wallet/settlement layer (USD). */
const FUNDING_CURRENCY = "USD";

/** C2B Paystack checkout charge currency (Kenya merchant default). */
const C2B_PAYSTACK_CURRENCY = "KES";

const FIAT_ASSETS = Object.freeze(["USD", "KES", "NGN", "GHS", "GBP", "EUR", "USDT"]);

const MERCHANT_PAYMENT_STATUSES = Object.freeze({
  pending: "pending",
  processing: "processing",
  completed: "completed",
  failed: "failed",
});

const SETTLEMENT_JOB_STATUSES = Object.freeze({
  pending: "pending",
  processing: "processing",
  completed: "completed",
  failed: "failed",
});

const SETTLEMENT_RAILS = Object.freeze({
  daraja_b2b: "daraja_b2b",
});

const TIMELINE_EVENT_TYPES = Object.freeze({
  order_created: "order_created",
  provider_initialized: "provider_initialized",
  webhook_received: "webhook_received",
  webhook_processed: "webhook_processed",
  funding_completed: "funding_completed",
  funding_failed: "funding_failed",
  merchant_payment_created: "merchant_payment_created",
  reservation_created: "reservation_created",
  reservation_released: "reservation_released",
  settlement_initiated: "settlement_initiated",
  settlement_completed: "settlement_completed",
  settlement_failed: "settlement_failed",
  settlement_retry: "settlement_retry",
  reconciliation_recovery: "reconciliation_recovery",
  integrity_check: "integrity_check",
});

const WEBHOOK_RECEIPT_STATUSES = Object.freeze({
  received: "received",
  processing: "processing",
  processed: "processed",
  failed: "failed",
  duplicate: "duplicate",
});

const SETTLEMENT_JOB_STATUSES_EXTENDED = Object.freeze({
  ...SETTLEMENT_JOB_STATUSES,
  dead_letter: "dead_letter",
});

/**
 * @param {string} provider
 * @returns {boolean}
 */
function isKnownFundingProvider(provider) {
  return Object.values(FUNDING_PROVIDERS).includes(String(provider || "").toLowerCase());
}

/**
 * @param {string} status
 * @returns {boolean}
 */
function isTerminalFundingStatus(status) {
  const s = String(status || "").toLowerCase();
  return s === FUNDING_STATUSES.completed || s === FUNDING_STATUSES.failed;
}

module.exports = {
  FUNDING_PROVIDERS,
  FUNDING_STATUSES,
  FUNDING_CURRENCY,
  C2B_PAYSTACK_CURRENCY,
  FIAT_ASSETS,
  MERCHANT_PAYMENT_STATUSES,
  SETTLEMENT_JOB_STATUSES,
  SETTLEMENT_JOB_STATUSES_EXTENDED,
  SETTLEMENT_RAILS,
  TIMELINE_EVENT_TYPES,
  WEBHOOK_RECEIPT_STATUSES,
  isKnownFundingProvider,
  isTerminalFundingStatus,
};
