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

/** B2B partner self-topup product marker on fundingOrders.metadata.product */
const B2B_SELF_TOPUP_PRODUCT = "b2b_self_topup";

/** B2B Paystack collection currency (KES-only merchant). */
const B2B_PAYSTACK_CURRENCY = "KES";

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

/**
 * Customer-facing funding amount/currency (wallet credit), not the Paystack
 * charge. FX top-ups store charge in order.amount (KES) and the deposit in
 * metadata.requestedAmount / requestedCurrency.
 *
 * @param {Object|null|undefined} data fundingOrders / transactionRecords / orders doc
 * @param {string} [fallbackCurrency]
 * @returns {{ amount: number, currency: string }}
 */
function resolveFundingDisplayMoney(data, fallbackCurrency = "KES") {
  const meta = data && data.metadata && typeof data.metadata === "object" ?
    data.metadata :
    {};
  const requestedAmount = Number(meta.requestedAmount);
  const requestedCurrency = meta.requestedCurrency ?
    String(meta.requestedCurrency).toUpperCase() :
    "";
  const hasRequested = Number.isFinite(requestedAmount) && requestedAmount > 0;
  const fallback = String(fallbackCurrency || "KES").toUpperCase();
  const orderCurrency = data && data.currency ? String(data.currency).toUpperCase() : "";
  const metaCurrency = meta.currency ? String(meta.currency).toUpperCase() : "";

  if (hasRequested && requestedCurrency) {
    return {amount: requestedAmount, currency: requestedCurrency};
  }
  return {
    amount: hasRequested ? requestedAmount : (Number(data && data.amount) || 0),
    currency: requestedCurrency || orderCurrency || metaCurrency || fallback,
  };
}

module.exports = {
  FUNDING_PROVIDERS,
  FUNDING_STATUSES,
  FUNDING_CURRENCY,
  C2B_PAYSTACK_CURRENCY,
  B2B_SELF_TOPUP_PRODUCT,
  B2B_PAYSTACK_CURRENCY,
  FIAT_ASSETS,
  MERCHANT_PAYMENT_STATUSES,
  SETTLEMENT_JOB_STATUSES,
  SETTLEMENT_JOB_STATUSES_EXTENDED,
  SETTLEMENT_RAILS,
  TIMELINE_EVENT_TYPES,
  WEBHOOK_RECEIPT_STATUSES,
  isKnownFundingProvider,
  isTerminalFundingStatus,
  resolveFundingDisplayMoney,
};
