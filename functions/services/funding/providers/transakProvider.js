/**
 * @fileoverview Transak Funding Provider adapter.
 * Uses official Transak Public + Partner APIs only — no wallet or ledger logic.
 *
 * @see https://docs.transak.com/api/public/end-points
 * @see https://docs.transak.com/api/public/get-price
 * @see https://docs.transak.com/api/public/create-widget-url
 * @see https://docs.transak.com/api/public/get-orders
 * @see https://docs.transak.com/api/public/get-order-by-order-id
 */

const jwt = require("jsonwebtoken");
const config = require("../../../config");
const { createLogger } = require("../../../utils/paymentOpsLogger");
const { FUNDING_PROVIDERS, FUNDING_CURRENCY } = require("../../../utils/fundingTypes");
const {
  PartnerConfigurationError,
  getConfigSnapshot,
  getHealthStatus: buildHealthStatus,
  logStartupConfiguration,
  transakHttpRequest,
  validateQuoteRequest,
} = require("./transakDiagnostics");

const PROVIDER_ID = FUNDING_PROVIDERS.transak;
const DEFAULT_PAYMENT_METHOD = "credit_debit_card";
const DEFAULT_PRODUCTS = "BUY";
const REQUEST_TIMEOUT_MS = 15000;

/** Official API path constants — not hostnames. */
const API_PATHS = Object.freeze({
  GET_PRICE: "/api/v1/pricing/public/quotes",
  CREATE_WIDGET_SESSION: "/api/v2/auth/session",
  GET_ORDERS: "/partners/api/v2/orders",
  GET_ORDER_BY_ID: (orderId) => `/partners/api/v2/order/${encodeURIComponent(orderId)}`,
});

const COMPLETED_STATUSES = new Set(["COMPLETED"]);
const FAILED_STATUSES = new Set([
  "FAILED",
  "CANCELLED",
  "CANCELED",
  "EXPIRED",
  "DECLINED",
  "REFUNDED",
]);

const WEBHOOK_EVENT_IDS = new Set([
  "ORDER_COMPLETED",
  "ORDER_FAILED",
  "ORDER_PROCESSING",
  "ORDER_CREATED",
  "ORDER_PAYMENT_VERIFYING",
  "ORDER_AWAITING_PAYMENT_FROM_USER",
]);

const logger = createLogger({ service: "transakProvider", provider: PROVIDER_ID });

/**
 * @returns {string|null}
 */
function getApiKey() {
  return process.env.TRANSAK_API_KEY || config.transak?.apiKey || null;
}

/**
 * Partner Access Token — used for partner APIs and webhook JWT verification.
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
 * @returns {"staging"|"production"}
 */
function getEnvironment() {
  const env = String(
      process.env.TRANSAK_ENVIRONMENT || config.transak?.environment || "staging",
  ).toLowerCase();
  return env === "production" ? "production" : "staging";
}

/**
 * Public + Partner API host (Get Price, Get Orders, Get Order By ID).
 * @returns {string}
 */
function getPublicApiBaseUrl() {
  const explicit = process.env.TRANSAK_API_BASE_URL || config.transak?.baseUrl || null;
  if (explicit && String(explicit).trim()) {
    return String(explicit).trim().replace(/\/+$/, "");
  }
  return getEnvironment() === "production" ?
    "https://api.transak.com" :
    "https://api-stg.transak.com";
}

/**
 * Gateway host for Create Widget URL session API only.
 * @returns {string}
 */
function getGatewayApiBaseUrl() {
  const explicit = process.env.TRANSAK_GATEWAY_API_BASE_URL || config.transak?.gatewayBaseUrl || null;
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
  return String(process.env.TRANSAK_DEFAULT_NETWORK || config.transak?.defaultNetwork || "tron").toLowerCase();
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
function isHeadlessEnabled() {
  const raw = process.env.TRANSAK_HEADLESS || config.transak?.headless || "true";
  return String(raw).toLowerCase() === "true";
}

/**
 * @returns {string}
 */
function getIntegrationMode() {
  const explicit = process.env.TRANSAK_MODE || config.transak?.mode || null;
  if (explicit) {
    const normalized = String(explicit).toLowerCase();
    if (normalized === "headless") {
      return "Headless";
    }
    if (normalized === "widget") {
      return "Widget";
    }
    return String(explicit);
  }
  return isHeadlessEnabled() ? "Headless" : "Widget";
}

/**
 * @returns {boolean}
 */
function isConfigured() {
  return !!(getApiKey() && getSecretKey() && getTreasuryWallet());
}

const diagnosticsGetters = {
  getApiKey,
  getSecretKey,
  getWebhookSecret,
  getEnvironment,
  getPublicApiBaseUrl,
  getGatewayApiBaseUrl,
  getDefaultFiat,
  getDefaultCrypto,
  getDefaultNetwork,
  getTreasuryWallet,
  isHeadlessEnabled,
  getIntegrationMode,
  isConfigured,
  API_PATHS,
};

/**
 * @param {Object} [ctx]
 * @returns {Object}
 */
function buildHttpContext(ctx = {}) {
  return {
    ...ctx,
    configSnapshot: getConfigSnapshot(diagnosticsGetters),
  };
}

/**
 * @param {Object} [ctx]
 * @returns {Object}
 */
function buildPartnerHeaders(ctx = {}) {
  const apiKey = getApiKey();
  const accessToken = getSecretKey();
  if (!apiKey || !accessToken) {
    throw new Error("Transak is not configured (TRANSAK_API_KEY / TRANSAK_SECRET_KEY)");
  }

  return {
    "x-api-key": apiKey,
    "access-token": accessToken,
    "x-user-ip": ctx.userIp || "127.0.0.1",
    "Content-Type": "application/json",
    accept: "application/json",
  };
}

/**
 * @param {Object} order
 * @param {string} [fallbackReference]
 * @returns {import("../../../utils/fundingTypes").NormalizedFundingEvent}
 */
function normalizeTransakOrder(order, fallbackReference = "") {
  const statusRaw = String(order.status || "").toUpperCase();
  let status = "pending";
  if (COMPLETED_STATUSES.has(statusRaw)) {
    status = "success";
  } else if (FAILED_STATUSES.has(statusRaw)) {
    status = "failed";
  }

  const providerReference = String(
      order.partnerOrderId || order.partnerCustomerId || fallbackReference || order.id || "",
  );
  const providerTransactionId = String(order.id || order.orderId || order._id || providerReference);

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
 * Official Get Price API (public quote).
 * GET /api/v1/pricing/public/quotes
 *
 * @param {Object} params
 * @returns {Promise<Object>}
 */
async function fetchPublicQuote(params) {
  const {
    amount,
    fiatCurrency,
    cryptoCurrency,
    network,
    correlationId,
    fundingOrderId,
    providerReference,
    walletAddress = null,
    countryCode = null,
    paymentMethod = DEFAULT_PAYMENT_METHOD,
  } = params;

  const url = `${getPublicApiBaseUrl()}${API_PATHS.GET_PRICE}`;
  const query = {
    partnerApiKey: getApiKey(),
    fiatCurrency,
    cryptoCurrency,
    network,
    isBuyOrSell: "BUY",
    fiatAmount: Number(amount),
    paymentMethod,
  };

  if (walletAddress) {
    query.walletAddress = walletAddress;
  }
  if (countryCode) {
    query.countryCode = countryCode;
  }

  validateQuoteRequest(query);

  const response = await transakHttpRequest({
    method: "get",
    url,
    params: query,
    headers: { "x-api-key": getApiKey() },
    timeout: REQUEST_TIMEOUT_MS,
  }, buildHttpContext({
    errorEvent: "transak.quote.failed",
    correlationId,
    fundingOrderId,
    providerReference,
  }));

  const quote = response.data?.response;
  if (!quote?.quoteId) {
    throw new Error(response.data?.message || "Transak Get Price failed");
  }
  return quote;
}

/**
 * Official Create Widget URL API.
 * POST {gateway}/api/v2/auth/session
 *
 * @param {Object} params
 * @returns {Promise<Object>}
 */
async function createWidgetSession(params) {
  const {
    widgetParams,
    userAccessToken,
    correlationId,
    fundingOrderId,
    providerReference,
    userIp,
  } = params;

  const url = `${getGatewayApiBaseUrl()}${API_PATHS.CREATE_WIDGET_SESSION}`;
  const headers = {
    ...buildPartnerHeaders({ userIp }),
    ...(userAccessToken ? { authorization: userAccessToken } : {}),
  };

  const response = await transakHttpRequest({
    method: "post",
    url,
    data: { widgetParams },
    headers,
    timeout: REQUEST_TIMEOUT_MS,
  }, buildHttpContext({
    errorEvent: "transak.initialize.failed",
    correlationId,
    fundingOrderId,
    providerReference,
  }));

  const session = response.data?.data;
  if (!session?.widgetUrl) {
    throw new Error(response.data?.message || "Transak Create Widget URL failed");
  }
  return session;
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
    countryCode = null,
  } = params;

  const fiatCurrency = String(currency).toUpperCase();
  const partnerOrderId = providerReference || fundingOrderId || `tp_${Date.now()}`;
  const treasuryWallet = getTreasuryWallet();
  const userAccessToken = transakAccessToken || metadata.transakAccessToken || null;

  const quote = await fetchPublicQuote({
    amount,
    fiatCurrency,
    cryptoCurrency: getDefaultCrypto(),
    network: getDefaultNetwork(),
    walletAddress: treasuryWallet,
    countryCode: countryCode || metadata.countryCode || null,
    correlationId,
    fundingOrderId,
    providerReference: partnerOrderId,
  });

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

  const session = await createWidgetSession({
    widgetParams,
    userAccessToken,
    correlationId,
    fundingOrderId,
    providerReference: partnerOrderId,
    userIp,
  });

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
    checkoutUrl: session.widgetUrl,
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
 * Official Get Orders API with partnerOrderId filter.
 * GET /partners/api/v2/orders?filter[partnerOrderId]=...
 *
 * @param {string} providerReference
 * @param {Object} ctx
 * @returns {Promise<Object|null>}
 */
async function fetchOrderByPartnerReference(providerReference, ctx = {}) {
  const url = `${getPublicApiBaseUrl()}${API_PATHS.GET_ORDERS}`;
  const headers = buildPartnerHeaders(ctx);

  const response = await transakHttpRequest({
    method: "get",
    url,
    headers,
    params: {
      "filter[partnerOrderId]": providerReference,
      "filter[productsAvailed]": '["BUY"]',
      limit: 5,
    },
    timeout: REQUEST_TIMEOUT_MS,
  }, buildHttpContext({
    errorEvent: "transak.verify.failed",
    correlationId: ctx.correlationId || null,
    fundingOrderId: ctx.fundingOrderId || null,
    providerReference,
  }));

  const items = response.data?.data || [];
  const list = Array.isArray(items) ? items : [items].filter(Boolean);
  return list.find((item) =>
    String(item.partnerOrderId || "") === String(providerReference),
  ) || list[0] || null;
}

/**
 * Official Get Order By ID API.
 * GET /partners/api/v2/order/{orderId}
 *
 * @param {string} orderId
 * @param {Object} ctx
 * @returns {Promise<Object|null>}
 */
async function fetchOrderById(orderId, ctx = {}) {
  const url = `${getPublicApiBaseUrl()}${API_PATHS.GET_ORDER_BY_ID(orderId)}`;
  const headers = buildPartnerHeaders(ctx);

  const response = await transakHttpRequest({
    method: "get",
    url,
    headers,
    timeout: REQUEST_TIMEOUT_MS,
  }, buildHttpContext({
    errorEvent: "transak.verify.failed",
    correlationId: ctx.correlationId || null,
    fundingOrderId: ctx.fundingOrderId || null,
    providerReference: ctx.providerReference || orderId,
  }));

  return response.data?.data || null;
}

/**
 * @param {string} providerReference
 * @param {Object} [ctx]
 * @returns {Promise<import("../../../utils/fundingTypes").NormalizedFundingEvent>}
 */
async function verifyPayment(providerReference, ctx = {}) {
  const started = Date.now();

  let order = await fetchOrderByPartnerReference(providerReference, ctx);
  if (!order && ctx.transakOrderId) {
    order = await fetchOrderById(ctx.transakOrderId, {
      ...ctx,
      providerReference,
    });
  }

  if (!order) {
    throw new Error(`Transak order not found for partnerOrderId ${providerReference}`);
  }

  const event = normalizeTransakOrder(order, providerReference);

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
 * @returns {Promise<import("../../../utils/fundingTypes").NormalizedFundingEvent>}
 */
async function getFundingStatus(providerReference, ctx = {}) {
  return verifyPayment(providerReference, ctx);
}

/**
 * @returns {Object}
 */
function getHealthStatus() {
  return buildHealthStatus(diagnosticsGetters);
}

/**
 * @param {string} eventId
 * @returns {boolean}
 */
function isSupportedWebhookEvent(eventId) {
  if (!eventId) {
    return true;
  }
  const normalized = String(eventId).toUpperCase();
  if (WEBHOOK_EVENT_IDS.has(normalized)) {
    return true;
  }
  return normalized.startsWith("ORDER_");
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

  const eventId = decoded.eventID || decoded.eventId || payload?.eventID || payload?.eventId || null;
  if (!isSupportedWebhookEvent(eventId)) {
    return null;
  }

  const order = decoded.webhookData || decoded.order || null;
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

logStartupConfiguration(diagnosticsGetters);

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
  getHealthStatus,
  PartnerConfigurationError,
  API_PATHS,
  getPublicApiBaseUrl,
  getGatewayApiBaseUrl,
  diagnosticsGetters,
};

module.exports = transakProvider;
