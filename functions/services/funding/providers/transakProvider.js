/**
 * @fileoverview Transak Funding Provider adapter.
 * Transak API communication only — no wallet or ledger logic.
 */

const jwt = require("jsonwebtoken");
const axios = require("axios");
const config = require("../../../config");
const { createLogger } = require("../../../utils/paymentOpsLogger");
const { FUNDING_PROVIDERS, FUNDING_CURRENCY } = require("../../../utils/fundingTypes");

const PROVIDER_ID = FUNDING_PROVIDERS.transak;
const DEFAULT_PAYMENT_METHOD = "credit_debit_card";
const DEFAULT_PRODUCTS = "BUY";
const logger = createLogger({ service: "transakProvider", provider: PROVIDER_ID });

const COMPLETED_STATUSES = new Set(["COMPLETED"]);
const FAILED_STATUSES = new Set([
  "FAILED",
  "CANCELLED",
  "CANCELED",
  "EXPIRED",
  "DECLINED",
  "REFUNDED",
]);

/**
 * @returns {string|null}
 */
function getApiKey() {
  return process.env.TRANSAK_API_KEY || config.transak?.apiKey || null;
}

/**
 * @returns {string|null}
 */
function getSecretKey() {
  return process.env.TRANSAK_SECRET_KEY || config.transak?.secretKey || null;
}

/**
 * @returns {string|null}
 */
function getWebhookSecret() {
  return process.env.TRANSAK_WEBHOOK_SECRET ||
    config.transak?.webhookSecret ||
    getSecretKey();
}

/**
 * @returns {string}
 */
function getEnvironment() {
  const env = String(
      process.env.TRANSAK_ENVIRONMENT || config.transak?.environment || "staging",
  ).toLowerCase();
  return env === "production" ? "production" : "staging";
}

/**
 * @returns {string}
 */
function getGatewayBaseUrl() {
  const explicit = process.env.TRANSAK_API_BASE_URL || config.transak?.baseUrl || null;
  if (explicit && String(explicit).trim()) {
    return String(explicit).trim().replace(/\/+$/, "");
  }
  return getEnvironment() === "production" ?
    "https://api-gateway.transak.com" :
    "https://api-gateway-stg.transak.com";
}

/**
 * @returns {string}
 */
function getPartnersBaseUrl() {
  const explicit = process.env.TRANSAK_PARTNERS_API_BASE_URL || config.transak?.partnersBaseUrl || null;
  if (explicit && String(explicit).trim()) {
    return String(explicit).trim().replace(/\/+$/, "");
  }
  return getEnvironment() === "production" ?
    "https://api.transak.com/partners/api/v2" :
    "https://api-stg.transak.com/partners/api/v2";
}

/**
 * @returns {string}
 */
function getDefaultFiat() {
  return String(process.env.TRANSAK_DEFAULT_FIAT || config.transak?.defaultFiat || FUNDING_CURRENCY).toUpperCase();
}

/**
 * @returns {string}
 */
function getDefaultCrypto() {
  return String(process.env.TRANSAK_DEFAULT_CRYPTO || config.transak?.defaultCrypto || "USDT").toUpperCase();
}

/**
 * @returns {string}
 */
function getDefaultNetwork() {
  return String(process.env.TRANSAK_DEFAULT_NETWORK || config.transak?.defaultNetwork || "ethereum").toLowerCase();
}

/**
 * @returns {string|null}
 */
function getTreasuryWallet() {
  return process.env.TRANSAK_TREASURY_WALLET || config.transak?.treasuryWallet || null;
}

/**
 * @returns {string}
 */
function getReferrerDomain() {
  return process.env.TRANSAK_REFERRER_DOMAIN || config.transak?.referrerDomain || "truepay.africa";
}

/**
 * @returns {boolean}
 */
function isConfigured() {
  return !!(getApiKey() && getSecretKey() && getTreasuryWallet());
}

/**
 * @param {import("axios").AxiosError} err
 * @returns {string}
 */
function formatTransakError(err) {
  const status = err.response?.status;
  const body = err.response?.data;
  const message = body?.error?.message || body?.message || err.message;
  if (status && message) {
    return `Transak ${status}: ${message}`;
  }
  return message;
}

/**
 * @param {Object} [ctx]
 * @returns {Object}
 */
function buildPartnerHeaders(ctx = {}) {
  const apiKey = getApiKey();
  const secretKey = getSecretKey();
  if (!apiKey || !secretKey) {
    throw new Error("Transak is not configured (TRANSAK_API_KEY / TRANSAK_SECRET_KEY)");
  }

  return {
    "x-api-key": apiKey,
    "access-token": secretKey,
    "x-access-token": secretKey,
    "x-user-ip": ctx.userIp || "127.0.0.1",
    "Content-Type": "application/json",
    accept: "application/json",
  };
}

/**
 * @param {Object} order
 * @returns {import("../../../utils/fundingTypes").NormalizedFundingEvent}
 */
function normalizeTransakOrder(order) {
  const statusRaw = String(order.status || "").toUpperCase();
  let status = "pending";
  if (COMPLETED_STATUSES.has(statusRaw)) {
    status = "success";
  } else if (FAILED_STATUSES.has(statusRaw)) {
    status = "failed";
  }

  const providerReference = String(
      order.partnerOrderId || order.partnerCustomerId || order.id || "",
  );
  const providerTransactionId = String(order.id || order.orderId || providerReference);

  return {
    providerReference,
    providerTransactionId,
    amount: Number(order.fiatAmount || order.amountPaid || order.fiatAmountInUsd || 0),
    currency: String(order.fiatCurrency || getDefaultFiat()).toUpperCase(),
    status,
    failureReason: order.statusReason || order.failureReason || order.statusMessage || null,
  };
}

/**
 * @param {Object} params
 * @returns {Promise<{ checkoutUrl: string, providerReference: string, providerTransactionId?: string, raw?: Object }>}
 */
async function initializePayment(params) {
  const started = Date.now();
  if (!isConfigured()) {
    throw new Error(
        "Transak is not configured (TRANSAK_API_KEY, TRANSAK_SECRET_KEY, TRANSAK_TREASURY_WALLET)",
    );
  }

  const {
    amount,
    currency = getDefaultFiat(),
    email = null,
    metadata = {},
    providerReference,
    correlationId = null,
    fundingOrderId = null,
    userId = null,
    transakAccessToken = null,
    callbackUrl = null,
    userIp = null,
  } = params;

  const fiatCurrency = String(currency).toUpperCase();
  const partnerOrderId = providerReference || fundingOrderId || `tp_${Date.now()}`;
  const treasuryWallet = getTreasuryWallet();
  const userAccessToken = transakAccessToken || metadata.transakAccessToken || null;

  const quoteParams = {
    partnerApiKey: getApiKey(),
    fiatCurrency,
    cryptoCurrency: getDefaultCrypto(),
    isBuyOrSell: "BUY",
    fiatAmount: Number(amount),
    paymentMethod: DEFAULT_PAYMENT_METHOD,
    network: getDefaultNetwork(),
    partnerOrderId,
    partnerCustomerId: userId || metadata.userId || partnerOrderId,
  };

  let quoteResponse;
  try {
    quoteResponse = await axios.get(`${getGatewayBaseUrl()}/api/v2/lookup/quote`, {
      params: quoteParams,
      timeout: 15000,
    });
  } catch (err) {
    const errorMessage = formatTransakError(err);
    logger.error("transak.quote.failed", {
      correlationId,
      fundingOrderId,
      providerReference: partnerOrderId,
      provider: PROVIDER_ID,
      executionTimeMs: Date.now() - started,
      error: errorMessage,
    });
    const wrapped = new Error(errorMessage);
    wrapped.cause = err;
    throw wrapped;
  }

  const quote = quoteResponse.data?.data || quoteResponse.data;
  if (!quote?.quoteId) {
    const message = quoteResponse.data?.message || "Transak quote failed";
    throw new Error(message);
  }

  const widgetParams = {
    apiKey: getApiKey(),
    referrerDomain: getReferrerDomain(),
    productsAvailed: DEFAULT_PRODUCTS,
    fiatAmount: Number(amount),
    fiatCurrency,
    cryptoCurrencyCode: getDefaultCrypto(),
    network: getDefaultNetwork(),
    paymentMethod: DEFAULT_PAYMENT_METHOD,
    walletAddress: treasuryWallet,
    disableWalletAddressForm: true,
    hideExchangeScreen: true,
    partnerOrderId,
    partnerCustomerId: userId || metadata.userId || partnerOrderId,
    email: email || metadata.email || "tourist@truepay.africa",
    redirectURL: callbackUrl || metadata.redirectURL || null,
  };

  const sessionHeaders = {
    ...buildPartnerHeaders({ userIp }),
    ...(userAccessToken ? { "access-token": userAccessToken } : {}),
  };

  let sessionResponse;
  try {
    sessionResponse = await axios.post(
        `${getGatewayBaseUrl()}/api/v2/auth/session`,
        { widgetParams },
        { headers: sessionHeaders, timeout: 15000 },
    );
  } catch (err) {
    const errorMessage = formatTransakError(err);
    logger.error("transak.initialize.failed", {
      correlationId,
      fundingOrderId,
      providerReference: partnerOrderId,
      provider: PROVIDER_ID,
      executionTimeMs: Date.now() - started,
      error: errorMessage,
    });
    const wrapped = new Error(errorMessage);
    wrapped.cause = err;
    throw wrapped;
  }

  const session = sessionResponse.data?.data || sessionResponse.data;
  const checkoutUrl = session?.widgetUrl;
  if (!checkoutUrl) {
    const message = sessionResponse.data?.message || "Transak widget session failed";
    throw new Error(message);
  }

  logger.info("transak.initialize.success", {
    correlationId,
    fundingOrderId,
    providerReference: partnerOrderId,
    provider: PROVIDER_ID,
    executionTimeMs: Date.now() - started,
    quoteId: quote.quoteId,
    treasuryWallet,
  });

  return {
    checkoutUrl,
    providerReference: partnerOrderId,
    providerTransactionId: String(quote.quoteId),
    raw: {
      quote,
      session,
      treasuryWallet,
      cryptoCurrency: getDefaultCrypto(),
      cryptoAmount: quote.cryptoAmount || null,
    },
  };
}

/**
 * @param {string} providerReference
 * @param {Object} [ctx]
 * @returns {Promise<import("../../../utils/fundingTypes").NormalizedFundingEvent>}
 */
async function verifyPayment(providerReference, ctx = {}) {
  const started = Date.now();
  const order = await fetchOrderByPartnerReference(providerReference, ctx);
  const event = normalizeTransakOrder(order);

  logger.info("transak.verify.success", {
    correlationId: ctx.correlationId || null,
    fundingOrderId: ctx.fundingOrderId || null,
    providerReference,
    provider: PROVIDER_ID,
    executionTimeMs: Date.now() - started,
    status: order.status,
    providerTransactionId: event.providerTransactionId,
  });

  return event;
}

/**
 * @param {string} providerReference
 * @param {Object} [ctx]
 * @returns {Promise<Object>}
 */
async function fetchOrderByPartnerReference(providerReference, ctx = {}) {
  const headers = buildPartnerHeaders(ctx);

  let response;
  try {
    response = await axios.get(`${getPartnersBaseUrl()}/orders`, {
      headers,
      params: {
        "filter[partnerOrderId]": providerReference,
      },
      timeout: 15000,
    });
  } catch (err) {
    logger.error("transak.verify.failed", {
      correlationId: ctx.correlationId || null,
      fundingOrderId: ctx.fundingOrderId || null,
      providerReference,
      provider: PROVIDER_ID,
      error: err.message,
    });
    throw err;
  }

  const items = response.data?.data || response.data?.response || [];
  const list = Array.isArray(items) ? items : [items].filter(Boolean);
  const order = list.find((item) =>
    String(item.partnerOrderId || "") === String(providerReference),
  ) || list[0];

  if (!order) {
    throw new Error(`Transak order not found for partnerOrderId ${providerReference}`);
  }

  return order;
}

/**
 * Alias for verifyPayment — provider-specific status lookup.
 * @param {string} providerReference
 * @param {Object} [ctx]
 * @returns {Promise<import("../../../utils/fundingTypes").NormalizedFundingEvent>}
 */
async function getFundingStatus(providerReference, ctx = {}) {
  return verifyPayment(providerReference, ctx);
}

/**
 * @param {Object} payload
 * @returns {import("../../../utils/fundingTypes").NormalizedFundingEvent|null}
 */
function normalizeWebhook(payload) {
  const decoded = decodeWebhookPayload(payload);
  if (!decoded) {
    return null;
  }

  const order = decoded.webhookData || decoded.order || decoded.data || decoded;
  if (!order || (!order.partnerOrderId && !order.id && !order.orderId)) {
    return null;
  }

  return normalizeTransakOrder(order);
}

/**
 * @param {Object} payload
 * @returns {Object|null}
 */
function decodeWebhookPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if (payload.webhookData || payload.order) {
    return payload;
  }

  const token = payload.data;
  if (!token || typeof token !== "string") {
    return null;
  }

  const secret = getWebhookSecret();
  if (!secret) {
    return null;
  }

  try {
    return jwt.verify(token, secret);
  } catch (err) {
    void err;
    return null;
  }
}

/**
 * @param {import("express").Request} req
 * @param {Buffer|string} rawBody
 * @returns {boolean}
 */
function verifyWebhookSignature(req, rawBody) {
  const secret = getWebhookSecret();
  if (!secret) {
    return false;
  }

  let payload;
  try {
    const body = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || "");
    payload = JSON.parse(body);
  } catch (err) {
    void err;
    return false;
  }

  const token = payload?.data;
  if (!token || typeof token !== "string") {
    return false;
  }

  try {
    jwt.verify(token, secret);
    return true;
  } catch (err) {
    void err;
    return false;
  }
}

const transakProvider = {
  providerId: PROVIDER_ID,
  initializePayment,
  verifyPayment,
  getFundingStatus,
  normalizeWebhook,
  verifyWebhookSignature,
  decodeWebhookPayload,
  normalizeTransakOrder,
  isConfigured,
};

module.exports = transakProvider;
