/**
 * @fileoverview Bridge C2B Flutter `createPayment` callable to the funding layer.
 * Keeps the legacy response shape while using Paystack + fundingOrders as source of truth.
 */

const config = require("../../config");
const fundingOrderService = require("./fundingOrderService");
const fundingRailService = require("./fundingRailService");
const fundingIdempotencyService = require("./fundingIdempotencyService");
const { convertToKesForPaystack } = require("./c2bFundingFxService");
const { resolvePaystackCallbackUrl } = require("./fundingCallbackService");
const { recordEvent } = require("../ops/paymentTimelineService");
const opsMetrics = require("../ops/opsMetricsService");
const { createPaymentContext } = require("../../utils/paymentContext");
const { createLogger } = require("../../utils/paymentOpsLogger");
const {
  C2B_PAYSTACK_CURRENCY,
  FUNDING_PROVIDERS,
  FUNDING_STATUSES,
  TIMELINE_EVENT_TYPES,
} = require("../../utils/fundingTypes");

const logger = createLogger({ service: "c2bFundingBridge" });
const PROVIDER = FUNDING_PROVIDERS.paystack;

/**
 * Create a Paystack checkout for C2B tourist wallet top-up.
 * Response matches the legacy `createPayment` callable shape for Flutter compatibility.
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {number} params.amount
 * @param {string} [params.currency]
 * @param {string} [params.email]
 * @param {string} [params.callbackUrl]
 * @param {string} [params.idempotencyKey]
 * @param {string} [params.correlationId]
 * @param {Object} [params.metadata]
 * @returns {Promise<Object>}
 */
async function createC2bTopupCheckout(params) {
  const {
    userId,
    amount,
    currency = "USD",
    email = null,
    callbackUrl = null,
    idempotencyKey = null,
    correlationId = null,
    metadata = {},
  } = params;

  const charge = await convertToKesForPaystack(amount, currency);

  const ctx = createPaymentContext({
    correlationId,
    userId,
    provider: PROVIDER,
    source: "createPayment",
  });

  if (idempotencyKey) {
    const existing = await fundingIdempotencyService.lookupIdempotencyKey(userId, idempotencyKey);
    if (existing) {
      const prior = await fundingOrderService.getFundingOrderForUser(userId, existing.fundingOrderId);
      if (prior) {
        return mapFundingOrderToCreatePaymentResponse(prior, { duplicate: true });
      }
    }
  }

  const orderId = fundingOrderService.generateFundingOrderId();

  if (idempotencyKey) {
    const claim = await fundingIdempotencyService.claimIdempotencyKey({
      userId,
      idempotencyKey,
      fundingOrderId: orderId,
    });
    if (claim.duplicate && claim.fundingOrderId !== orderId) {
      const prior = await fundingOrderService.getFundingOrderForUser(userId, claim.fundingOrderId);
      if (prior) {
        return mapFundingOrderToCreatePaymentResponse(prior, { duplicate: true });
      }
    }
  }

  const order = await fundingOrderService.createFundingOrder({
    id: orderId,
    userId,
    provider: PROVIDER,
    amount: charge.amountKes,
    currency: C2B_PAYSTACK_CURRENCY,
    correlationId: ctx.correlationId,
    fundingRequestId: idempotencyKey,
    metadata: {
      ...metadata,
      product: "tourist",
      correlationId: ctx.correlationId,
      source: "c2b_createPayment",
      requestedAmount: charge.requestedAmount,
      requestedCurrency: charge.requestedCurrency,
      fxRate: charge.fxRate,
      paystackCurrency: charge.paystackCurrency,
    },
  });

  let session;
  try {
    session = await fundingRailService.initializePayment({
      provider: PROVIDER,
      amount: charge.amountKes,
      currency: C2B_PAYSTACK_CURRENCY,
      email,
      callbackUrl: resolvePaystackCallbackUrl(callbackUrl),
      providerReference: order.providerReference,
      fundingOrderId: order.id,
      userId,
      correlationId: ctx.correlationId,
      metadata: order.metadata,
    });
    await opsMetrics.increment("funding.checkout.initialized", 1);
  } catch (err) {
    await opsMetrics.increment("funding.checkout.failed", 1);
    await fundingOrderService.updateFundingOrder(order.id, {
      status: FUNDING_STATUSES.failed,
      failureReason: err.message,
    });
    logger.error("c2b.checkout.failed", {
      correlationId: ctx.correlationId,
      fundingOrderId: order.id,
      providerReference: order.providerReference,
      error: err.message,
    });
    throw err;
  }

  const updated = await fundingOrderService.updateFundingOrder(order.id, {
    providerReference: session.providerReference,
    providerTransactionId: session.providerTransactionId || null,
    checkoutUrl: session.checkoutUrl,
  });

  await recordEvent({
    fundingOrderId: order.id,
    correlationId: ctx.correlationId,
    eventType: TIMELINE_EVENT_TYPES.order_created,
    provider: PROVIDER,
    status: updated.status,
    metadata: {
      amount: charge.amountKes,
      currency: C2B_PAYSTACK_CURRENCY,
      requestedAmount: charge.requestedAmount,
      requestedCurrency: charge.requestedCurrency,
      fxRate: charge.fxRate,
      source: "createPayment",
    },
  });

  await recordEvent({
    fundingOrderId: order.id,
    correlationId: ctx.correlationId,
    eventType: TIMELINE_EVENT_TYPES.provider_initialized,
    provider: PROVIDER,
    metadata: { checkoutUrl: session.checkoutUrl },
  });

  logger.info("c2b.checkout.created", {
    correlationId: ctx.correlationId,
    fundingOrderId: order.id,
    providerReference: updated.providerReference,
    provider: PROVIDER,
  });

  return mapFundingOrderToCreatePaymentResponse(updated, {
    correlationId: ctx.correlationId,
  });
}

/**
 * Map funding order to legacy createPayment response for Flutter C2B app.
 *
 * @param {Object} order
 * @param {Object} [extra]
 * @returns {Object}
 */
function mapFundingOrderToCreatePaymentResponse(order, extra = {}) {
  const reference = order.providerReference || order.id;
  const requestedAmount = order.metadata?.requestedAmount ?? order.amount;
  const requestedCurrency = order.metadata?.requestedCurrency ?? order.currency;
  const checkoutUrl = order.checkoutUrl || "";
  return {
    success: true,
    duplicate: extra.duplicate || false,
    orderId: order.id,
    fundingOrderId: order.id,
    invoiceId: reference,
    paymentId: reference,
    amount: requestedAmount,
    currency: requestedCurrency,
    paystackAmount: order.amount,
    paystackCurrency: order.currency,
    status: order.status || "pending",
    checkoutUrl,
    /** Legacy aliases — always use checkoutUrl from this response, not client IntaSend URLs */
    url: checkoutUrl,
    authorization_url: checkoutUrl,
    correlationId: extra.correlationId || order.correlationId || null,
    provider: order.provider || PROVIDER,
    createdAt: order.createdAt || new Date().toISOString(),
  };
}

module.exports = {
  createC2bTopupCheckout,
  mapFundingOrderToCreatePaymentResponse,
};
