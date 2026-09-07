/**
 * @fileoverview Bridge C2B Flutter `createPayment` callable to the funding layer.
 * Keeps the legacy response shape while using fundingOrders as source of truth.
 */

const config = require("../../config");
const fundingOrderService = require("./fundingOrderService");
const fundingRailService = require("./fundingRailService");
const fundingIdempotencyService = require("./fundingIdempotencyService");
const { convertToKesForPaystack, assertC2bTopupWithinMaxKes, getC2bMaxTopupKes, maxAmountForCurrency } = require("./c2bFundingFxService");
const { resolvePaystackCallbackUrl } = require("./fundingCallbackService");
const { recordEvent } = require("../ops/paymentTimelineService");
const opsMetrics = require("../ops/opsMetricsService");
const productPricingService = require("../pricing/productPricingService");
const { createPaymentContext } = require("../../utils/paymentContext");
const { createLogger } = require("../../utils/paymentOpsLogger");
const { resolveFundingCustomerEmail } = require("../../utils/fundingCustomerEmail");
const {
  C2B_PAYSTACK_CURRENCY,
  FUNDING_PROVIDERS,
  FUNDING_CURRENCY,
  FUNDING_STATUSES,
  TIMELINE_EVENT_TYPES,
} = require("../../utils/fundingTypes");

const logger = createLogger({ service: "c2bFundingBridge" });

/**
 * Resolve provider for non-C2B callers (e.g. response mapping).
 * C2B `createPayment` always uses Paystack — see createC2bTopupCheckout.
 * @param {string|null} [explicitProvider]
 * @returns {string}
 */
function resolveFundingProvider(explicitProvider = null) {
  return String(explicitProvider || config.funding.defaultProvider || FUNDING_PROVIDERS.paystack).toLowerCase();
}

/**
 * Create a checkout for C2B tourist wallet top-up via Paystack.
 * Response matches the legacy `createPayment` callable shape for Flutter compatibility.
 * Always routes to Paystack (ignores FUNDING_DEFAULT_PROVIDER and client `provider`).
 * Transak remains available via REST `POST /funding/orders` with provider=transak.
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
  return createC2bPaystackTopupCheckout(params);
}

/**
 * @param {Object} params
 * @returns {Promise<Object>}
 */
async function createC2bPaystackTopupCheckout(params) {
  const {
    userId,
    amount,
    currency = "USD",
    email = null,
    tokenEmail = null,
    callbackUrl = null,
    idempotencyKey = null,
    correlationId = null,
    metadata = {},
  } = params;

  const checkoutEmail = (await resolveFundingCustomerEmail(userId, {
    clientEmail: email,
    tokenEmail,
  })).email;

  const provider = FUNDING_PROVIDERS.paystack;
  const charge = await convertToKesForPaystack(amount, currency);
  assertC2bTopupWithinMaxKes(charge);
  // Fee on Paystack KES leg; wallet still credits requestedAmount/currency.
  const topupCharge = await productPricingService.computeLocalTopupPaystackCharge(
      charge.amountKes,
  );
  const paystackChargeKes = topupCharge.chargeAmountKes;

  logger.info("c2b.checkout.fx", {
    userId,
    requestedAmount: charge.requestedAmount,
    requestedCurrency: charge.requestedCurrency,
    amountKes: charge.amountKes,
    paystackChargeKes,
    feeAmount: topupCharge.feeAmount,
    fxRate: charge.fxRate,
  });

  const ctx = createPaymentContext({
    correlationId,
    userId,
    provider,
    source: "createPayment",
  });

  const duplicate = await resolveIdempotentOrder(userId, idempotencyKey);
  if (duplicate) {
    return mapFundingOrderToCreatePaymentResponse(duplicate, { duplicate: true });
  }

  const orderId = fundingOrderService.generateFundingOrderId();
  const claimed = await claimIdempotency(userId, idempotencyKey, orderId);
  if (claimed) {
    return mapFundingOrderToCreatePaymentResponse(claimed, { duplicate: true });
  }

  const order = await fundingOrderService.createFundingOrder({
    id: orderId,
    userId,
    provider,
    amount: paystackChargeKes,
    currency: C2B_PAYSTACK_CURRENCY,
    correlationId: ctx.correlationId,
    fundingRequestId: idempotencyKey,
    metadata: {
      ...metadata,
      product: "tourist",
      correlationId: ctx.correlationId,
      userId,
      provider,
      source: "c2b_createPayment",
      requestedAmount: charge.requestedAmount,
      requestedCurrency: charge.requestedCurrency,
      fxRate: charge.fxRate,
      paystackCurrency: charge.paystackCurrency,
      faceAmountKes: topupCharge.creditAmountKes,
      platformFee: topupCharge.feeAmount,
      feeAmount: topupCharge.feeAmount,
      pricingProductKey: topupCharge.pricingProductKey,
      pricingApplied: topupCharge.applied,
      chargeAmount: paystackChargeKes,
    },
  });

  const updated = await initializeProviderCheckout({
    provider,
    order,
    ctx,
    amount: paystackChargeKes,
    currency: C2B_PAYSTACK_CURRENCY,
    email: checkoutEmail,
    callbackUrl: resolvePaystackCallbackUrl(callbackUrl),
    metadata: order.metadata,
  });

  await recordCheckoutTimeline({
    orderId: order.id,
    correlationId: ctx.correlationId,
    provider,
    status: updated.status,
    amount: paystackChargeKes,
    currency: C2B_PAYSTACK_CURRENCY,
    metadata: {
      requestedAmount: charge.requestedAmount,
      requestedCurrency: charge.requestedCurrency,
      faceAmountKes: topupCharge.creditAmountKes,
      feeAmount: topupCharge.feeAmount,
      fxRate: charge.fxRate,
      source: "createPayment",
    },
    checkoutUrl: updated.checkoutUrl,
  });

  logger.info("c2b.checkout.created", {
    correlationId: ctx.correlationId,
    fundingOrderId: order.id,
    providerReference: updated.providerReference,
    provider,
  });

  return mapFundingOrderToCreatePaymentResponse(updated, {
    correlationId: ctx.correlationId,
  });
}

/**
 * @param {Object} params
 * @returns {Promise<Object>}
 */
async function createC2bTransakTopupCheckout(params) {
  const {
    userId,
    amount,
    currency = FUNDING_CURRENCY,
    email = null,
    callbackUrl = null,
    idempotencyKey = null,
    correlationId = null,
    transakAccessToken = null,
    metadata = {},
  } = params;

  const provider = FUNDING_PROVIDERS.transak;
  const chargeCurrency = String(currency || FUNDING_CURRENCY).toUpperCase();
  const chargeAmount = Number(amount);

  const ctx = createPaymentContext({
    correlationId,
    userId,
    provider,
    source: "createPayment",
  });

  const duplicate = await resolveIdempotentOrder(userId, idempotencyKey);
  if (duplicate) {
    return mapFundingOrderToCreatePaymentResponse(duplicate, { duplicate: true });
  }

  const orderId = fundingOrderService.generateFundingOrderId();
  const claimed = await claimIdempotency(userId, idempotencyKey, orderId);
  if (claimed) {
    return mapFundingOrderToCreatePaymentResponse(claimed, { duplicate: true });
  }

  const treasuryWallet = process.env.TRANSAK_TREASURY_WALLET || config.transak?.treasuryWallet || null;
  const order = await fundingOrderService.createFundingOrder({
    id: orderId,
    userId,
    provider,
    amount: chargeAmount,
    currency: chargeCurrency,
    correlationId: ctx.correlationId,
    fundingRequestId: idempotencyKey,
    metadata: {
      ...metadata,
      product: "tourist",
      correlationId: ctx.correlationId,
      userId,
      provider,
      environment: process.env.GCLOUD_PROJECT || config.transak?.environment || "staging",
      source: "c2b_createPayment",
      requestedAmount: chargeAmount,
      requestedCurrency: chargeCurrency,
      treasuryWallet,
      cryptoCurrency: process.env.TRANSAK_DEFAULT_CRYPTO || config.transak?.defaultCrypto || "USDT",
    },
  });

  const updated = await initializeProviderCheckout({
    provider,
    order,
    ctx,
    amount: chargeAmount,
    currency: chargeCurrency,
    email,
    callbackUrl: resolvePaystackCallbackUrl(callbackUrl),
    transakAccessToken,
    metadata: order.metadata,
  });

  await recordCheckoutTimeline({
    orderId: order.id,
    correlationId: ctx.correlationId,
    provider,
    status: updated.status,
    amount: chargeAmount,
    currency: chargeCurrency,
    metadata: {
      requestedAmount: chargeAmount,
      requestedCurrency: chargeCurrency,
      treasuryWallet,
      cryptoCurrency: updated.metadata?.cryptoCurrency || order.metadata.cryptoCurrency,
      source: "createPayment",
    },
    checkoutUrl: updated.checkoutUrl,
  });

  logger.info("c2b.checkout.created", {
    correlationId: ctx.correlationId,
    fundingOrderId: order.id,
    providerReference: updated.providerReference,
    provider,
    treasuryWallet,
  });

  return mapFundingOrderToCreatePaymentResponse(updated, {
    correlationId: ctx.correlationId,
  });
}

/**
 * @param {string} userId
 * @param {string|null} idempotencyKey
 * @returns {Promise<Object|null>}
 */
async function resolveIdempotentOrder(userId, idempotencyKey) {
  if (!idempotencyKey) {
    return null;
  }
  const existing = await fundingIdempotencyService.lookupIdempotencyKey(userId, idempotencyKey);
  if (!existing) {
    return null;
  }
  return fundingOrderService.getFundingOrderForUser(userId, existing.fundingOrderId);
}

/**
 * @param {string} userId
 * @param {string|null} idempotencyKey
 * @param {string} orderId
 * @returns {Promise<Object|null>}
 */
async function claimIdempotency(userId, idempotencyKey, orderId) {
  if (!idempotencyKey) {
    return null;
  }
  const claim = await fundingIdempotencyService.claimIdempotencyKey({
    userId,
    idempotencyKey,
    fundingOrderId: orderId,
  });
  if (!claim.duplicate || claim.fundingOrderId === orderId) {
    return null;
  }
  return fundingOrderService.getFundingOrderForUser(userId, claim.fundingOrderId);
}

/**
 * @param {Object} params
 * @returns {Promise<Object>}
 */
async function initializeProviderCheckout(params) {
  const {
    provider,
    order,
    ctx,
    amount,
    currency,
    email,
    callbackUrl,
    transakAccessToken = null,
    metadata,
  } = params;

  let session;
  try {
    session = await fundingRailService.initializePayment({
      provider,
      amount,
      currency,
      email,
      callbackUrl,
      providerReference: order.providerReference,
      fundingOrderId: order.id,
      userId: order.userId,
      correlationId: ctx.correlationId,
      transakAccessToken,
      metadata,
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
      provider,
      error: err.message,
      ...(err.details ? {
        transakRequest: {
          method: err.details.httpMethod || null,
          url: err.details.url || null,
          params: err.details.requestParams || null,
          body: err.details.requestBody || null,
        },
        transakResponse: {
          statusCode: err.details.statusCode || null,
          body: err.details.responseBody || null,
        },
        supportReport: err.details.supportReport || null,
      } : {}),
    });
    throw err;
  }

  const patch = {
    providerReference: session.providerReference,
    providerTransactionId: session.providerTransactionId || null,
    checkoutUrl: session.checkoutUrl,
  };

  if (provider === FUNDING_PROVIDERS.transak && session.raw) {
    patch.metadata = {
      ...metadata,
      quoteId: session.raw.quote?.quoteId || metadata.quoteId || null,
      cryptoAmount: session.raw.cryptoAmount || session.raw.quote?.cryptoAmount || null,
      treasuryWallet: session.raw.treasuryWallet || metadata.treasuryWallet || null,
    };
  }

  return fundingOrderService.updateFundingOrder(order.id, patch);
}

/**
 * @param {Object} params
 * @returns {Promise<void>}
 */
async function recordCheckoutTimeline(params) {
  const {
    orderId,
    correlationId,
    provider,
    status,
    amount,
    currency,
    metadata,
    checkoutUrl,
  } = params;

  await recordEvent({
    fundingOrderId: orderId,
    correlationId,
    eventType: TIMELINE_EVENT_TYPES.order_created,
    provider,
    status,
    metadata: {
      amount,
      currency,
      ...metadata,
    },
  });

  await recordEvent({
    fundingOrderId: orderId,
    correlationId,
    eventType: TIMELINE_EVENT_TYPES.provider_initialized,
    provider,
    metadata: { checkoutUrl },
  });
}

/**
 * Map funding order to legacy createPayment response for Flutter C2B app.
 *
 * @param {Object} order
 * @param {Object} [extra]
 * @returns {Object}
 */
/**
 * Quote Local Topup (Paystack) breakdown for the Deposit Review screen.
 * Does not create a funding order or open checkout.
 *
 * @param {Object} params
 * @param {number} params.amount - Face amount the user wants to receive
 * @param {string} [params.currency="KES"]
 * @returns {Promise<Object>}
 */
async function quoteLocalTopupPaystack(params) {
  const amount = Number(params.amount);
  const currency = String(params.currency || "KES").toUpperCase();
  if (!Number.isFinite(amount) || amount <= 0) {
    const err = new Error("amount must be a positive number");
    err.statusCode = 400;
    throw err;
  }

  const charge = await convertToKesForPaystack(amount, currency);
  assertC2bTopupWithinMaxKes(charge);
  const topupCharge = await productPricingService.computeLocalTopupPaystackCharge(
      charge.amountKes,
  );

  const youDeposit = charge.requestedAmount;
  const depositCurrency = charge.requestedCurrency;
  const processingFees = topupCharge.feeAmount;
  const paymentMethodFees = 0;
  const youWillPay = topupCharge.chargeAmountKes;
  const paystackCurrency = C2B_PAYSTACK_CURRENCY;
  const maxTopupKes = getC2bMaxTopupKes();
  const maxTopupAmount = depositCurrency === paystackCurrency ?
    maxTopupKes :
    maxAmountForCurrency(maxTopupKes, charge.fxRate);

  const formatLine = (value, cur) => {
    const n = Number(value) || 0;
    if (n <= 0) return "Free";
    return `${n.toFixed(2)} ${cur}`;
  };

  return {
    method: "local_topup",
    provider: FUNDING_PROVIDERS.paystack,
    checkoutProvider: "Paystack",
    /** Face amount credited after success (same currency as user entered) */
    youDeposit,
    youReceive: youDeposit,
    amount: youDeposit,
    currency: depositCurrency,
    /** Platform fee (KES) from local_topup when live */
    processingFees,
    processingFeesCurrency: paystackCurrency,
    paymentMethodFees,
    paymentMethodFeesCurrency: paystackCurrency,
    /** Total charged on Paystack (KES) */
    youWillPay,
    totalToPay: youWillPay,
    paystackAmount: youWillPay,
    paystackCurrency,
    faceAmountKes: topupCharge.creditAmountKes,
    feeAmount: processingFees,
    feePercent: topupCharge.feePercent,
    flatFeeKes: topupCharge.flatFee,
    pricingApplied: topupCharge.applied,
    pricingProductKey: topupCharge.pricingProductKey,
    fxRate: charge.fxRate,
    maxTopupKes,
    maxTopupAmount,
    maxTopupCurrency: depositCurrency,
    lines: [
      {
        key: "you_deposit",
        label: "You deposit",
        amount: youDeposit,
        currency: depositCurrency,
        display: formatLine(youDeposit, depositCurrency),
      },
      {
        key: "processing_fees",
        label: "Processing fees",
        amount: processingFees,
        currency: paystackCurrency,
        display: formatLine(processingFees, paystackCurrency),
      },
      {
        key: "payment_method_fees",
        label: "Payment method fees",
        amount: paymentMethodFees,
        currency: paystackCurrency,
        display: formatLine(paymentMethodFees, paystackCurrency),
      },
      {
        key: "you_will_pay",
        label: "You will pay",
        amount: youWillPay,
        currency: paystackCurrency,
        display: formatLine(youWillPay, paystackCurrency),
      },
    ],
  };
}

function mapFundingOrderToCreatePaymentResponse(order, extra = {}) {
  const reference = order.providerReference || order.id;
  const requestedAmount = order.metadata?.requestedAmount ?? order.amount;
  const requestedCurrency = order.metadata?.requestedCurrency ?? order.currency;
  const checkoutUrl = order.checkoutUrl || "";
  const provider = order.provider || config.funding.defaultProvider || FUNDING_PROVIDERS.paystack;
  const providerAmount = order.amount;
  const providerCurrency = order.currency;
  const feeAmount = Number(order.metadata?.feeAmount ?? order.metadata?.platformFee ?? 0) || 0;

  return {
    success: true,
    duplicate: extra.duplicate || false,
    orderId: order.id,
    fundingOrderId: order.id,
    invoiceId: reference,
    paymentId: reference,
    /** Face amount credited to SafariTap after success */
    amount: requestedAmount,
    youReceive: requestedAmount,
    currency: requestedCurrency,
    /** Amount posted to Paystack (KES face + local_topup fee when live) */
    paystackAmount: providerAmount,
    totalToPay: providerAmount,
    feeAmount,
    platformFee: feeAmount,
    pricingProductKey: order.metadata?.pricingProductKey || null,
    paystackCurrency: providerCurrency,
    status: order.status || "pending",
    checkoutUrl,
    /** Legacy aliases — always use checkoutUrl from this response, not client IntaSend URLs */
    url: checkoutUrl,
    authorization_url: checkoutUrl,
    correlationId: extra.correlationId || order.correlationId || null,
    provider,
    createdAt: order.createdAt || new Date().toISOString(),
  };
}

module.exports = {
  createC2bTopupCheckout,
  createC2bPaystackTopupCheckout,
  createC2bTransakTopupCheckout,
  quoteLocalTopupPaystack,
  mapFundingOrderToCreatePaymentResponse,
  resolveFundingProvider,
};
