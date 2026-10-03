/**
 * @fileoverview Bridge B2B portal Add Money to a funding checkout.
 * KES stays on Paystack. USD, EUR, INR, and CAD use PayLio.
 */

const fundingOrderService = require("./fundingOrderService");
const fundingRailService = require("./fundingRailService");
const fundingIdempotencyService = require("./fundingIdempotencyService");
const { resolveB2bPaystackCallbackUrl } = require("./fundingCallbackService");
const { recordEvent } = require("../ops/paymentTimelineService");
const opsMetrics = require("../ops/opsMetricsService");
const productPricingService = require("../pricing/productPricingService");
const { createPaymentContext } = require("../../utils/paymentContext");
const { createLogger } = require("../../utils/paymentOpsLogger");
const {
  B2B_PAYSTACK_CURRENCY,
  B2B_SELF_TOPUP_PRODUCT,
  FUNDING_PROVIDERS,
  FUNDING_STATUSES,
  TIMELINE_EVENT_TYPES,
  isPaylioCheckoutCurrency,
} = require("../../utils/fundingTypes");

const logger = createLogger({ service: "b2bFundingBridge" });

const MIN_KES_AMOUNT = 1;

/**
 * Create a hosted checkout for partner Add Money.
 * KES uses Paystack. USD, EUR, INR, and CAD use PayLio.
 *
 * @param {Object} params
 * @param {string} params.partnerId
 * @param {string} params.actorUid - Firebase uid of the partner user initiating checkout
 * @param {number} params.amount - Amount in major units of `currency`
 * @param {string} [params.currency] - KES, or a PayLio currency (USD, EUR, INR, CAD)
 * @param {string} [params.email]
 * @param {string} [params.callbackUrl]
 * @param {string} [params.idempotencyKey]
 * @param {string} [params.correlationId]
 * @param {Object} [params.metadata]
 * @returns {Promise<Object>}
 */
async function createB2bSelfTopupCheckout(params) {
  const currency = String(params.currency || B2B_PAYSTACK_CURRENCY).toUpperCase();
  if (isPaylioCheckoutCurrency(currency)) {
    return createB2bPaylioSelfTopupCheckout({ ...params, currency });
  }
  return createB2bPaystackSelfTopupCheckout({ ...params, currency });
}

/**
 * @param {Object} params
 * @returns {Promise<Object>}
 */
async function createB2bPaystackSelfTopupCheckout(params) {
  const {
    partnerId,
    actorUid,
    amount,
    currency = B2B_PAYSTACK_CURRENCY,
    email = null,
    callbackUrl = null,
    idempotencyKey = null,
    correlationId = null,
    metadata = {},
  } = params;

  if (!partnerId) {
    const err = new Error("partnerId is required");
    err.statusCode = 400;
    throw err;
  }
  if (!actorUid) {
    const err = new Error("actorUid is required");
    err.statusCode = 400;
    throw err;
  }

  const cur = String(currency || B2B_PAYSTACK_CURRENCY).toUpperCase();
  if (cur !== B2B_PAYSTACK_CURRENCY) {
    const err = new Error(
        "B2B Add Money supports KES on Paystack, or USD, EUR, INR, and CAD on PayLio",
    );
    err.statusCode = 400;
    throw err;
  }

  const amountKes = Number(amount);
  if (!Number.isFinite(amountKes) || amountKes < MIN_KES_AMOUNT) {
    const err = new Error(`amount must be a number >= ${MIN_KES_AMOUNT}`);
    err.statusCode = 400;
    throw err;
  }

  // Face amount → wallet; Paystack charge = face + local_topup fee when live.
  const topupCharge = await productPricingService.computeLocalTopupPaystackCharge(amountKes);
  const creditKes = topupCharge.creditAmountKes;
  const chargeKes = topupCharge.chargeAmountKes;

  const provider = FUNDING_PROVIDERS.paystack;
  const idempotencyOwner = `partner:${partnerId}`;

  const ctx = createPaymentContext({
    correlationId,
    userId: actorUid,
    provider,
    source: "b2b_add_money",
  });

  const duplicate = await resolveIdempotentOrder(idempotencyOwner, idempotencyKey);
  if (duplicate) {
    return mapB2bCheckoutResponse(duplicate, { duplicate: true, correlationId: ctx.correlationId });
  }

  const orderId = fundingOrderService.generateFundingOrderId();
  const claimed = await claimIdempotency(idempotencyOwner, idempotencyKey, orderId);
  if (claimed) {
    return mapB2bCheckoutResponse(claimed, { duplicate: true, correlationId: ctx.correlationId });
  }

  const order = await fundingOrderService.createFundingOrder({
    id: orderId,
    userId: actorUid,
    provider,
    amount: chargeKes,
    currency: B2B_PAYSTACK_CURRENCY,
    correlationId: ctx.correlationId,
    fundingRequestId: idempotencyKey,
    metadata: {
      ...metadata,
      product: B2B_SELF_TOPUP_PRODUCT,
      partnerId: String(partnerId),
      actorUid: String(actorUid),
      correlationId: ctx.correlationId,
      provider,
      source: "b2b_portal_add_money",
      requestedAmount: creditKes,
      requestedCurrency: B2B_PAYSTACK_CURRENCY,
      paystackCurrency: B2B_PAYSTACK_CURRENCY,
      platformFee: topupCharge.feeAmount,
      feeAmount: topupCharge.feeAmount,
      pricingProductKey: topupCharge.pricingProductKey,
      pricingApplied: topupCharge.applied,
      chargeAmount: chargeKes,
    },
  });

  const resolvedCallback = resolveB2bPaystackCallbackUrl(callbackUrl);

  let updated;
  try {
    const session = await fundingRailService.initializePayment({
      provider,
      amount: chargeKes,
      currency: B2B_PAYSTACK_CURRENCY,
      email: email || null,
      callbackUrl: resolvedCallback,
      providerReference: order.providerReference,
      fundingOrderId: order.id,
      userId: actorUid,
      correlationId: ctx.correlationId,
      metadata: order.metadata,
    });
    await opsMetrics.increment("funding.checkout.initialized", 1);

    updated = await fundingOrderService.updateFundingOrder(order.id, {
      providerReference: session.providerReference,
      providerTransactionId: session.providerTransactionId || null,
      checkoutUrl: session.checkoutUrl,
    });
  } catch (err) {
    await opsMetrics.increment("funding.checkout.failed", 1);
    await fundingOrderService.updateFundingOrder(order.id, {
      status: FUNDING_STATUSES.failed,
      failureReason: err.message,
    });
    logger.error("b2b.checkout.failed", {
      correlationId: ctx.correlationId,
      fundingOrderId: order.id,
      partnerId,
      provider,
      error: err.message,
    });
    throw err;
  }

  await recordEvent({
    fundingOrderId: order.id,
    correlationId: ctx.correlationId,
    eventType: TIMELINE_EVENT_TYPES.order_created,
    provider,
    status: updated.status,
    metadata: {
      amount: chargeKes,
      creditAmount: creditKes,
      feeAmount: topupCharge.feeAmount,
      currency: B2B_PAYSTACK_CURRENCY,
      partnerId,
      product: B2B_SELF_TOPUP_PRODUCT,
      source: "b2b_portal_add_money",
    },
  });

  await recordEvent({
    fundingOrderId: order.id,
    correlationId: ctx.correlationId,
    eventType: TIMELINE_EVENT_TYPES.provider_initialized,
    provider,
    metadata: { checkoutUrl: updated.checkoutUrl, partnerId },
  });

  logger.info("b2b.checkout.created", {
    correlationId: ctx.correlationId,
    fundingOrderId: order.id,
    partnerId,
    providerReference: updated.providerReference,
    provider,
  });

  return mapB2bCheckoutResponse(updated, { correlationId: ctx.correlationId });
}

/**
 * Partner Add Money in a PayLio currency. The requested amount is credited.
 * PayLio adds its fee on the hosted checkout.
 *
 * @param {Object} params
 * @returns {Promise<Object>}
 */
async function createB2bPaylioSelfTopupCheckout(params) {
  const {
    partnerId,
    actorUid,
    amount,
    currency,
    email = null,
    idempotencyKey = null,
    correlationId = null,
    metadata = {},
  } = params;

  if (!partnerId) {
    const err = new Error("partnerId is required");
    err.statusCode = 400;
    throw err;
  }
  if (!actorUid) {
    const err = new Error("actorUid is required");
    err.statusCode = 400;
    throw err;
  }

  const chargeCurrency = String(currency || "").toUpperCase();
  const chargeAmount = Number(amount);
  if (!Number.isFinite(chargeAmount) || chargeAmount < MIN_KES_AMOUNT) {
    const err = new Error(`amount must be a number >= ${MIN_KES_AMOUNT}`);
    err.statusCode = 400;
    throw err;
  }

  const provider = FUNDING_PROVIDERS.paylio;
  const idempotencyOwner = `partner:${partnerId}`;
  const ctx = createPaymentContext({
    correlationId,
    userId: actorUid,
    provider,
    source: "b2b_add_money",
  });

  const duplicate = await resolveIdempotentOrder(idempotencyOwner, idempotencyKey);
  if (duplicate) {
    return mapB2bCheckoutResponse(duplicate, { duplicate: true, correlationId: ctx.correlationId });
  }

  const orderId = fundingOrderService.generateFundingOrderId();
  const claimed = await claimIdempotency(idempotencyOwner, idempotencyKey, orderId);
  if (claimed) {
    return mapB2bCheckoutResponse(claimed, { duplicate: true, correlationId: ctx.correlationId });
  }

  const order = await fundingOrderService.createFundingOrder({
    id: orderId,
    userId: actorUid,
    provider,
    amount: chargeAmount,
    currency: chargeCurrency,
    correlationId: ctx.correlationId,
    fundingRequestId: idempotencyKey,
    metadata: {
      ...metadata,
      product: B2B_SELF_TOPUP_PRODUCT,
      partnerId: String(partnerId),
      actorUid: String(actorUid),
      correlationId: ctx.correlationId,
      provider,
      source: "b2b_portal_add_money",
      requestedAmount: chargeAmount,
      requestedCurrency: chargeCurrency,
    },
  });

  let updated;
  try {
    const session = await fundingRailService.initializePayment({
      provider,
      amount: chargeAmount,
      currency: chargeCurrency,
      email: email || null,
      callbackUrl: null,
      providerReference: order.providerReference,
      fundingOrderId: order.id,
      userId: actorUid,
      correlationId: ctx.correlationId,
      metadata: order.metadata,
    });
    await opsMetrics.increment("funding.checkout.initialized", 1);

    const customerPayAmount = Number(session.raw?.customerPayAmount);
    const patch = {
      providerReference: session.providerReference,
      providerTransactionId: session.providerTransactionId || null,
      checkoutUrl: session.checkoutUrl,
      metadata: {
        ...order.metadata,
        providerFee: session.raw?.providerFee ?? null,
        customerPayAmount: session.raw?.customerPayAmount ?? null,
        netSettlementAmount: session.raw?.netSettlementAmount ?? null,
        feePercent: session.raw?.feePercent ?? null,
        passFeeToCustomer: session.raw?.passFeeToCustomer === true,
        feeAmount: session.raw?.providerFee ?? null,
        paymentId: session.raw?.paymentId || null,
        settlementCoin: session.raw?.settlementCoin || "polygon_usdc",
      },
    };
    if (Number.isFinite(customerPayAmount) && customerPayAmount > 0) {
      patch.amount = customerPayAmount;
    }
    updated = await fundingOrderService.updateFundingOrder(order.id, patch);
  } catch (err) {
    await opsMetrics.increment("funding.checkout.failed", 1);
    await fundingOrderService.updateFundingOrder(order.id, {
      status: FUNDING_STATUSES.failed,
      failureReason: err.message,
    });
    logger.error("b2b.checkout.failed", {
      correlationId: ctx.correlationId,
      fundingOrderId: order.id,
      partnerId,
      provider,
      error: err.message,
    });
    throw err;
  }

  await recordEvent({
    fundingOrderId: order.id,
    correlationId: ctx.correlationId,
    eventType: TIMELINE_EVENT_TYPES.order_created,
    provider,
    status: updated.status,
    metadata: {
      amount: chargeAmount,
      currency: chargeCurrency,
      partnerId,
      product: B2B_SELF_TOPUP_PRODUCT,
      source: "b2b_portal_add_money",
    },
  });

  await recordEvent({
    fundingOrderId: order.id,
    correlationId: ctx.correlationId,
    eventType: TIMELINE_EVENT_TYPES.provider_initialized,
    provider,
    metadata: { checkoutUrl: updated.checkoutUrl, partnerId },
  });

  logger.info("b2b.checkout.created", {
    correlationId: ctx.correlationId,
    fundingOrderId: order.id,
    partnerId,
    providerReference: updated.providerReference,
    provider,
    status: updated.status,
  });

  return mapB2bCheckoutResponse(updated, { correlationId: ctx.correlationId });
}

/**
 * Quote for the Add Money review screen. Does not open a PayLio checkout.
 * The customer fee is added by PayLio on the hosted page.
 *
 * @param {Object} params
 * @param {number} params.amount
 * @param {string} params.currency
 * @returns {Object}
 */
function quoteB2bInternationalTopup(params) {
  const amount = Number(params.amount);
  const currency = String(params.currency || "").toUpperCase();
  if (!isPaylioCheckoutCurrency(currency)) {
    const err = new Error("PayLio quote supports USD, EUR, INR, and CAD");
    err.statusCode = 400;
    throw err;
  }
  if (!Number.isFinite(amount) || amount < MIN_KES_AMOUNT) {
    const err = new Error(`amount must be a number >= ${MIN_KES_AMOUNT}`);
    err.statusCode = 400;
    throw err;
  }
  return {
    method: "international_collection",
    provider: FUNDING_PROVIDERS.paylio,
    checkoutProvider: "PayLio",
    youDeposit: amount,
    youReceive: amount,
    amount,
    currency,
    passFeeToCustomer: true,
    feeAmount: null,
    totalToPay: null,
  };
}

/**
 * @param {string} ownerKey
 * @param {string|null} idempotencyKey
 * @returns {Promise<Object|null>}
 */
async function resolveIdempotentOrder(ownerKey, idempotencyKey) {
  if (!idempotencyKey) {
    return null;
  }
  const existing = await fundingIdempotencyService.lookupIdempotencyKey(ownerKey, idempotencyKey);
  if (!existing) {
    return null;
  }
  return fundingOrderService.getFundingOrder(existing.fundingOrderId);
}

/**
 * @param {string} ownerKey
 * @param {string|null} idempotencyKey
 * @param {string} orderId
 * @returns {Promise<Object|null>}
 */
async function claimIdempotency(ownerKey, idempotencyKey, orderId) {
  if (!idempotencyKey) {
    return null;
  }
  const claim = await fundingIdempotencyService.claimIdempotencyKey({
    userId: ownerKey,
    idempotencyKey,
    fundingOrderId: orderId,
  });
  if (!claim.duplicate || claim.fundingOrderId === orderId) {
    return null;
  }
  return fundingOrderService.getFundingOrder(claim.fundingOrderId);
}

/**
 * @param {Object} order
 * @param {Object} [extra]
 * @returns {Object}
 */
function mapB2bCheckoutResponse(order, extra = {}) {
  const reference = order.providerReference || order.id;
  const checkoutUrl = order.checkoutUrl || "";
  const creditAmount = order.metadata?.requestedAmount ?? order.amount;
  const feeAmount = Number(order.metadata?.feeAmount ?? order.metadata?.platformFee ?? 0) || 0;
  return {
    orderId: order.id,
    fundingOrderId: order.id,
    invoiceId: reference,
    paymentId: reference,
    /** Face amount credited to partner virtual KES card after success */
    amount: creditAmount,
    youReceive: creditAmount,
    currency: order.metadata?.requestedCurrency ?? order.currency,
    /** Amount posted to Paystack (face + platform fee when local_topup is live) */
    paystackAmount: order.amount,
    totalToPay: order.amount,
    feeAmount,
    platformFee: feeAmount,
    pricingProductKey: order.metadata?.pricingProductKey || null,
    paystackCurrency: order.currency,
    status: order.status || FUNDING_STATUSES.pending,
    checkoutUrl,
    url: checkoutUrl,
    authorization_url: checkoutUrl,
    provider: order.provider || FUNDING_PROVIDERS.paystack,
    partnerId: order.metadata?.partnerId || null,
    correlationId: extra.correlationId || order.correlationId || null,
    duplicate: Boolean(extra.duplicate),
    createdAt: order.createdAt || new Date().toISOString(),
  };
}

module.exports = {
  createB2bSelfTopupCheckout,
  quoteB2bInternationalTopup,
  mapB2bCheckoutResponse,
  MIN_KES_AMOUNT,
};
