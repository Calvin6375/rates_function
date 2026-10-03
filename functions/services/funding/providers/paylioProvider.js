/**
 * @fileoverview PayLio Funding Provider adapter.
 * Hosted checkout only. Wallet credit happens after GET /payment-status
 * confirms status=paid and forward_status=completed.
 *
 * Docs: https://paylio.org/api-docs
 * Auth: Authorization: Bearer PAYLIO_API_KEY (no API secret).
 * Callback: GET with query params. PayLio does not document an HMAC signature.
 * Authenticity is the server-side status call, which cannot be spoofed with the query string.
 */

const axios = require("axios");
const config = require("../../../config");
const fundingOrderService = require("../fundingOrderService");
const { createLogger } = require("../../../utils/paymentOpsLogger");
const {
  FUNDING_PROVIDERS,
  FUNDING_CURRENCY,
  isPaylioCheckoutCurrency,
  PAYLIO_CHECKOUT_CURRENCIES,
} = require("../../../utils/fundingTypes");

const PROVIDER_ID = FUNDING_PROVIDERS.paylio;
const logger = createLogger({ service: "paylioProvider", provider: PROVIDER_ID });

/** Documented payment-status values. */
const PAYMENT_STATUSES = Object.freeze(["unpaid", "paid", "canceled"]);
/** Documented USDC forward statuses. completed is final settlement. */
const FORWARD_STATUSES = Object.freeze(["pending", "processing", "completed", "failed"]);

class PaylioApiError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number|null, code?: string|null }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = "PaylioApiError";
    this.statusCode = details.status || null;
    this.paylioCode = details.code || null;
  }
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function money(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount * 100) / 100;
}

/**
 * @returns {string|null}
 */
function getApiKey() {
  return process.env.PAYLIO_API_KEY || config.paylio?.apiKey || null;
}

/**
 * @returns {string|null}
 */
function getPolygonWallet() {
  return process.env.PAYLIO_POLYGON_WALLET || config.paylio?.polygonWallet || null;
}

/**
 * @returns {string}
 */
function apiBaseUrl() {
  return String(process.env.PAYLIO_API_BASE_URL || config.paylio?.baseUrl || "https://paylio.org/api/v1")
      .replace(/\/$/, "");
}

/**
 * Public webhook PayLio GETs after payment. fundingOrderId is ours; PayLio appends ipn_token.
 *
 * @param {string} fundingOrderId
 * @returns {string}
 */
function callbackUrlForOrder(fundingOrderId) {
  const configured = process.env.PAYLIO_CALLBACK_BASE_URL || config.paylio?.callbackBaseUrl || null;
  const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "truepay-72060";
  const region = config.region || "us-central1";
  const base = configured || `https://${region}-${project}.cloudfunctions.net/handlePaylioWebhook`;
  const url = new URL(base);
  url.searchParams.set("fundingOrderId", String(fundingOrderId));
  return url.toString();
}

/**
 * @param {import("axios").AxiosError} err
 * @returns {PaylioApiError}
 */
function formatPaylioError(err) {
  const status = err.response?.status || null;
  const body = err.response?.data;
  const message = typeof body?.error === "string" ? body.error : err.message;
  const code = typeof body?.code === "string" ? body.code : null;
  const text = status ? `PayLio ${status}: ${message}` : message;
  return new PaylioApiError(text, { status, code });
}

/**
 * Map a payment-status body onto the funding rail status.
 * Credit only when the card payment is paid AND Polygon USDC forwarding completed.
 *
 * @param {Object} body
 * @returns {{ status: "success"|"failed"|"pending", failureReason?: string }}
 */
function mapPaymentStatus(body) {
  const status = String(body?.status || "").toLowerCase();
  const forward = String(body?.forward_status || "").toLowerCase();
  if (status === "canceled" || status === "cancelled") {
    return { status: "failed", failureReason: "Payment canceled" };
  }
  if (forward === "failed") {
    return { status: "failed", failureReason: "USDC settlement failed" };
  }
  if (status === "paid" && forward === "completed") {
    return { status: "success" };
  }
  return { status: "pending" };
}

/**
 * @param {Object} params
 * @returns {Promise<Object>}
 */
async function initializePayment(params) {
  const currency = String(params.currency || "").toUpperCase();
  if (!isPaylioCheckoutCurrency(currency)) {
    throw new PaylioApiError(
        `PayLio funding supports ${PAYLIO_CHECKOUT_CURRENCIES.join(", ")} only`,
    );
  }
  const apiKey = getApiKey();
  const address = getPolygonWallet();
  if (!apiKey) {
    throw new PaylioApiError("PayLio API key is not configured");
  }
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new PaylioApiError("PayLio Polygon USDC wallet is not configured");
  }
  const amount = money(params.amount);
  if (!amount || amount <= 0) {
    throw new PaylioApiError("PayLio amount must be a positive number");
  }
  if (!params.fundingOrderId) {
    throw new PaylioApiError("PayLio checkout requires a funding order id");
  }

  const ctx = {
    correlationId: params.correlationId || null,
    fundingOrderId: params.fundingOrderId,
    userId: params.userId || null,
    provider: PROVIDER_ID,
  };
  const email = params.email ? String(params.email).trim() : "";
  const body = {
    address,
    callback: callbackUrlForOrder(params.fundingOrderId),
    amount: amount.toFixed(2),
    currency,
    passFeeToCustomer: true,
    note: `fundingOrderId=${params.fundingOrderId}`,
  };
  if (email) {
    body.email = email;
  }

  let data;
  try {
    const response = await axios.post(`${apiBaseUrl()}/wallet`, body, {
      timeout: Number(config.paylio?.timeoutMs) || 20000,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });
    data = response.data || {};
  } catch (err) {
    throw formatPaylioError(err);
  }

  const checkoutUrl = data.checkout_url ? String(data.checkout_url) : "";
  const ipnToken = data.ipn_token ? String(data.ipn_token) : "";
  const paymentId = data.payment_id ? String(data.payment_id) : "";
  if (!checkoutUrl || !ipnToken) {
    throw new PaylioApiError("PayLio checkout did not return checkout_url and ipn_token");
  }

  const requestedAmount = money(data.original_amount) ?? amount;
  const customerPayAmount = money(data.amount) ?? amount;
  const providerFee = money(data.customer_fee_amount) ??
    Math.round((customerPayAmount - requestedAmount) * 100) / 100;

  logger.info("paylio.initialize.success", {
    ...ctx,
    providerReference: ipnToken,
    status: data.status || "unpaid",
  });

  return {
    checkoutUrl,
    providerReference: ipnToken,
    providerTransactionId: paymentId || ipnToken,
    raw: {
      paymentId: paymentId || null,
      requestedAmount,
      providerFee,
      customerPayAmount,
      netSettlementAmount: null,
      feePercent: Number.isFinite(Number(data.fee_percent)) ? Number(data.fee_percent) : null,
      passFeeToCustomer: data.pass_fee_to_customer !== false,
      status: data.status || "unpaid",
      settlementWallet: address,
      settlementCoin: "polygon_usdc",
    },
  };
}

/**
 * GET /payment-status is authoritative. Query-string callbacks are hints only.
 *
 * @param {string} providerReference ipn_token
 * @param {Object} [ctx]
 * @returns {Promise<Object>}
 */
async function verifyPayment(providerReference, ctx = {}) {
  const ipnToken = String(providerReference || "").trim();
  const base = {
    providerReference: ipnToken,
    providerTransactionId: ctx.providerTransactionId || ipnToken,
    amount: 0,
    currency: FUNDING_CURRENCY,
    status: "pending",
  };
  if (!ipnToken) {
    return base;
  }
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new PaylioApiError("PayLio API key is not configured");
  }

  let data;
  try {
    const response = await axios.get(`${apiBaseUrl()}/payment-status`, {
      timeout: Number(config.paylio?.timeoutMs) || 20000,
      params: { ipn_token: ipnToken },
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    data = response.data || {};
  } catch (err) {
    const formatted = formatPaylioError(err);
    if (formatted.statusCode === 404) {
      return { ...base, status: "pending", failureReason: "Payment not found" };
    }
    throw formatted;
  }

  const mapped = mapPaymentStatus(data);
  const customerPayAmount = money(data.amount) ?? 0;
  const requestedAmount = money(data.original_amount);
  const providerFee = money(data.customer_fee_amount);
  const netSettlementAmount = money(data.forwarded_amount ?? data.value_coin);
  const event = {
    providerReference: ipnToken,
    providerTransactionId: data.payment_id ? String(data.payment_id) : (ctx.providerTransactionId || ipnToken),
    amount: customerPayAmount,
    currency: String(data.currency || FUNDING_CURRENCY).toUpperCase(),
    status: mapped.status,
    failureReason: mapped.failureReason,
    requestedAmount,
    providerFee,
    customerPayAmount,
    netSettlementAmount,
  };

  if (mapped.status === "success" && ctx.fundingOrderId) {
    await rememberSettlement(ctx, {
      netSettlementAmount,
      settlementCoin: data.coin || "polygon_usdc",
      settlementTxId: data.txid_out || null,
    });
  }

  logger.info("paylio.verify", {
    correlationId: ctx.correlationId || null,
    fundingOrderId: ctx.fundingOrderId || null,
    userId: ctx.userId || null,
    provider: PROVIDER_ID,
    providerReference: ipnToken,
    status: mapped.status,
    providerStatus: data.status || null,
    forwardStatus: data.forward_status || null,
  });

  return event;
}

/**
 * @param {Object} ctx
 * @param {{ netSettlementAmount: number|null, settlementCoin: string, settlementTxId: string|null }} fields
 * @returns {Promise<void>}
 */
async function rememberSettlement(ctx, fields) {
  try {
    const order = await fundingOrderService.getFundingOrder(ctx.fundingOrderId);
    if (!order) return;
    await fundingOrderService.updateFundingOrder(ctx.fundingOrderId, {
      metadata: {
        ...(order.metadata || {}),
        netSettlementAmount: fields.netSettlementAmount,
        settlementCoin: fields.settlementCoin,
        settlementTxId: fields.settlementTxId,
      },
    });
  } catch (err) {
    logger.warn("paylio.settlement.metadata_failed", {
      fundingOrderId: ctx.fundingOrderId,
      provider: PROVIDER_ID,
      error: err.message,
    });
  }
}

/**
 * Callback query or JSON. paid is a hint that must still pass verifyPayment.
 * Unknown statuses are ignored. canceled is returned as failed only after the
 * webhook handler re-checks payment-status.
 *
 * @param {Object} payload
 * @returns {Object|null}
 */
function normalizeWebhook(payload) {
  const token = String(payload?.ipn_token || payload?.ipnToken || "").trim();
  if (!token) return null;
  const status = String(payload?.status || "").toLowerCase();
  const paymentId = payload?.payment_id || payload?.paymentId || null;
  const currency = String(payload?.currency || FUNDING_CURRENCY).toUpperCase();
  const amount = money(payload?.amount) ?? 0;
  if (status === "paid") {
    return {
      providerReference: token,
      providerTransactionId: paymentId ? String(paymentId) : token,
      amount,
      currency,
      status: "success",
    };
  }
  if (status === "canceled" || status === "cancelled") {
    return {
      providerReference: token,
      providerTransactionId: paymentId ? String(paymentId) : token,
      amount,
      currency,
      status: "failed",
      failureReason: "Payment canceled",
    };
  }
  return null;
}

/**
 * PayLio documents no webhook HMAC. A callback without ipn_token cannot be authenticated.
 * A present token is still untrusted until verifyPayment succeeds.
 *
 * @param {import("express").Request} req
 * @param {Buffer|string} [rawBody]
 * @returns {boolean}
 */
function verifyWebhookSignature(req, rawBody) {
  void rawBody;
  const token = req?.query?.ipn_token || req?.query?.ipnToken;
  return typeof token === "string" && token.trim().length > 0;
}

module.exports = {
  providerId: PROVIDER_ID,
  initializePayment,
  verifyPayment,
  normalizeWebhook,
  verifyWebhookSignature,
  mapPaymentStatus,
  callbackUrlForOrder,
  PAYMENT_STATUSES,
  FORWARD_STATUSES,
  PaylioApiError,
};
