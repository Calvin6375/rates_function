/**
 * @fileoverview Transak diagnostics, validation, and HTTP logging helpers.
 * No payment business logic — used by transakProvider only.
 */

const axios = require("axios");
const config = require("../../../config");
const { createLogger } = require("../../../utils/paymentOpsLogger");

const logger = createLogger({ service: "transakDiagnostics" });

const PARTNER_LIMITATION_PATTERNS = [
  /limitation in your partner account/i,
  /partner not enabled/i,
  /unauthorized partner/i,
  /not enabled for your account/i,
  /contact us at support@transak\.com/i,
];

const PARTNER_CONFIGURATION_MESSAGE = [
  "Your Transak partner account is not enabled for the Whitelabel API.",
  "This is not a code issue.",
  "",
  "Verify:",
  "- Whitelabel API access",
  "- Headless Cards access",
  "- Partner API Key type",
  "- Backend IP whitelist",
].join("\n");

/** @type {Object|null} */
let lastDiagnosticSnapshot = null;

class PartnerConfigurationError extends Error {
  /**
   * @param {string} [message]
   * @param {Object} [details]
   */
  constructor(message = PARTNER_CONFIGURATION_MESSAGE, details = {}) {
    super(message);
    this.name = "PartnerConfigurationError";
    this.details = details;
  }
}

/**
 * @returns {boolean}
 */
function isDebugEnabled() {
  const raw = process.env.TRANSAK_DEBUG || config.transak?.debug || "false";
  return String(raw).toLowerCase() === "true";
}

/**
 * @param {string|null} apiKey
 * @returns {string|null}
 */
function maskApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== "string") {
    return null;
  }
  if (apiKey.length <= 6) {
    return `${apiKey}...`;
  }
  return `${apiKey.slice(0, 6)}...`;
}

/**
 * @param {Object} headers
 * @returns {Object}
 */
function maskHeaders(headers = {}) {
  const masked = { ...headers };
  const sensitiveKeys = [
    "authorization",
    "access-token",
    "x-access-token",
    "x-api-key",
  ];
  for (const key of Object.keys(masked)) {
    const lower = key.toLowerCase();
    if (sensitiveKeys.includes(lower)) {
      masked[key] = masked[key] ? "***" : null;
    }
  }
  return masked;
}

/**
 * Mask secrets in query params / JSON bodies before logging.
 * @param {Object|null|undefined} value
 * @returns {Object|null|undefined}
 */
function maskRequestPayload(value) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskRequestPayload(item));
  }

  const masked = { ...value };
  const sensitiveKeys = new Set([
    "partnerapikey",
    "apikey",
    "authorization",
    "accesstoken",
    "access-token",
    "secret",
    "secretkey",
    "webhooksecret",
  ]);

  for (const key of Object.keys(masked)) {
    const lower = key.toLowerCase().replace(/[_-]/g, "");
    if (sensitiveKeys.has(lower) || sensitiveKeys.has(key.toLowerCase())) {
      const raw = masked[key];
      masked[key] = typeof raw === "string" ? maskApiKey(raw) : "***";
      continue;
    }
    if (rawIsObject(masked[key])) {
      masked[key] = maskRequestPayload(masked[key]);
    }
  }
  return masked;
}

/**
 * @param {*} value
 * @returns {boolean}
 */
function rawIsObject(value) {
  return value !== null && typeof value === "object";
}

/**
 * @param {import("axios").AxiosRequestConfig|Object} requestConfig
 * @returns {{ method: string|null, url: string|null, params: Object|null, data: Object|null, headers: Object }}
 */
function extractRequestForLog(requestConfig = {}) {
  return {
    method: requestConfig.method ? String(requestConfig.method).toUpperCase() : null,
    url: requestConfig.url || null,
    params: maskRequestPayload(requestConfig.params || null),
    data: maskRequestPayload(requestConfig.data || null),
    headers: maskHeaders(requestConfig.headers || {}),
  };
}

/**
 * @param {Object} getters
 * @returns {Object}
 */
function getConfigSnapshot(getters) {
  const apiKey = getters.getApiKey();
  return {
    environment: getters.getEnvironment(),
    publicApiBaseUrl: getters.getPublicApiBaseUrl(),
    gatewayApiBaseUrl: getters.getGatewayApiBaseUrl(),
    apiKeyPrefix: maskApiKey(apiKey),
    apiKeyPresent: !!apiKey,
    secretPresent: !!getters.getSecretKey(),
    treasuryWalletPresent: !!getters.getTreasuryWallet(),
    webhookSecretPresent: !!getters.getWebhookSecret(),
    mode: getters.getIntegrationMode(),
    headlessEnabled: getters.isHeadlessEnabled(),
    debugEnabled: isDebugEnabled(),
    defaultFiat: getters.getDefaultFiat(),
    defaultCrypto: getters.getDefaultCrypto(),
    defaultNetwork: getters.getDefaultNetwork(),
    quoteEndpoint: getters.API_PATHS.GET_PRICE,
    widgetSessionEndpoint: getters.API_PATHS.CREATE_WIDGET_SESSION,
    configured: getters.isConfigured(),
  };
}

/**
 * @param {Object} getters
 */
function logStartupConfiguration(getters) {
  const snapshot = getConfigSnapshot(getters);
  logger.info("transak.configuration", {
    event: "transak.configuration",
    environment: snapshot.environment,
    publicApiBaseUrl: snapshot.publicApiBaseUrl,
    gatewayApiBaseUrl: snapshot.gatewayApiBaseUrl,
    apiKeyPrefix: snapshot.apiKeyPrefix,
    secretPresent: snapshot.secretPresent,
    treasuryWalletPresent: snapshot.treasuryWalletPresent ?
      "configured" :
      "missing",
    mode: snapshot.mode,
    headlessEnabled: snapshot.headlessEnabled,
    debugEnabled: snapshot.debugEnabled,
    quoteEndpoint: snapshot.quoteEndpoint,
    configured: snapshot.configured,
  });
}

/**
 * @param {Object} quoteParams
 * @returns {void}
 */
function validateQuoteRequest(quoteParams) {
  const required = {
    partnerApiKey: quoteParams.partnerApiKey,
    fiatCurrency: quoteParams.fiatCurrency,
    cryptoCurrency: quoteParams.cryptoCurrency,
    network: quoteParams.network,
    fiatAmount: quoteParams.fiatAmount,
  };

  const missing = Object.entries(required)
      .filter(([, value]) => value === undefined || value === null || value === "")
      .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(`Transak quote validation failed — missing: ${missing.join(", ")}`);
  }

  const amount = Number(quoteParams.fiatAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Transak quote validation failed — fiatAmount must be a positive number");
  }
}

/**
 * @param {string} message
 * @returns {boolean}
 */
function isPartnerConfigurationMessage(message) {
  const text = String(message || "");
  return PARTNER_LIMITATION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * @param {import("axios").AxiosError|Error} err
 * @returns {{ message: string, status: number|null, errorCode: string|number|null, body: Object|null, responseHeaders: Object|null }}
 */
function extractTransakError(err) {
  const status = err.response?.status || null;
  const body = err.response?.data || null;
  const responseHeaders = err.response?.headers || null;
  const errorCode = body?.error?.errorCode || body?.errorCode || null;
  const message = body?.error?.message ||
    body?.message ||
    body?.response?.message ||
    err.message;
  return { message, status, errorCode, body, responseHeaders };
}

/**
 * @param {import("axios").AxiosError} err
 * @param {Object} ctx
 * @returns {Error}
 */
function wrapTransakHttpError(err, ctx = {}) {
  const parsed = extractTransakError(err);
  const request = extractRequestForLog(err.config || {});
  const diagnostic = {
    correlationId: ctx.correlationId || null,
    fundingOrderId: ctx.fundingOrderId || null,
    providerReference: ctx.providerReference || null,
    httpMethod: request.method,
    url: request.url,
    requestParams: request.params,
    requestBody: request.data,
    requestHeaders: request.headers,
    statusCode: parsed.status,
    responseHeaders: parsed.responseHeaders,
    responseBody: parsed.body,
    transakErrorCode: parsed.errorCode,
    executionTimeMs: ctx.executionTimeMs || null,
    timestamp: new Date().toISOString(),
  };

  lastDiagnosticSnapshot = {
    ...diagnostic,
    supportReport: buildSupportReport(ctx, diagnostic),
  };

  if (isPartnerConfigurationMessage(parsed.message) ||
      (parsed.body && isPartnerConfigurationMessage(JSON.stringify(parsed.body)))) {
    return new PartnerConfigurationError(PARTNER_CONFIGURATION_MESSAGE, {
      ...diagnostic,
      supportReport: lastDiagnosticSnapshot.supportReport,
    });
  }

  const wrapped = new Error(
      parsed.status ? `Transak ${parsed.status}: ${parsed.message}` : parsed.message,
  );
  wrapped.cause = err;
  wrapped.transakDiagnostic = {
    ...diagnostic,
    supportReport: lastDiagnosticSnapshot.supportReport,
  };
  wrapped.details = wrapped.transakDiagnostic;
  return wrapped;
}

/**
 * @param {string} event
 * @param {import("axios").AxiosError} err
 * @param {Object} ctx
 */
function logTransakHttpError(event, err, ctx = {}) {
  const parsed = extractTransakError(err);
  const request = extractRequestForLog(err.config || {});
  logger.error(event, {
    correlationId: ctx.correlationId || null,
    fundingOrderId: ctx.fundingOrderId || null,
    providerReference: ctx.providerReference || null,
    httpMethod: request.method,
    url: request.url,
    requestParams: request.params,
    requestBody: request.data,
    requestHeaders: request.headers,
    statusCode: parsed.status,
    responseHeaders: parsed.responseHeaders,
    responseBody: parsed.body,
    transakErrorCode: parsed.errorCode,
    error: parsed.message,
    executionTimeMs: ctx.executionTimeMs || null,
    supportReport: buildSupportReport(ctx, {
      httpMethod: request.method,
      url: request.url,
      requestParams: request.params,
      requestBody: request.data,
      statusCode: parsed.status,
      responseBody: parsed.body,
      executionTimeMs: ctx.executionTimeMs,
      correlationId: ctx.correlationId,
    }),
  });
}

/**
 * @param {Object} requestConfig
 */
function logOutgoingRequest(requestConfig) {
  if (!isDebugEnabled()) {
    return;
  }

  const request = extractRequestForLog(requestConfig);
  logger.info("transak.http.request", {
    httpMethod: request.method,
    url: request.url,
    params: request.params,
    data: request.data,
    headers: request.headers,
  });
}

/**
 * @param {Object} ctx
 * @param {Object} [diagnostic]
 * @returns {string}
 */
function buildSupportReport(ctx = {}, diagnostic = {}) {
  const snapshot = ctx.configSnapshot || {};
  const lines = [
    "=== Transak Diagnostics ===",
    "",
    `Environment: ${snapshot.environment || ctx.environment || "unknown"}`,
    `API endpoint: ${diagnostic.url || snapshot.publicApiBaseUrl || "unknown"}`,
    `Partner API key present: ${snapshot.apiKeyPresent ?? "unknown"}`,
    `Secret present: ${snapshot.secretPresent ?? "unknown"}`,
    `Treasury wallet: ${snapshot.treasuryWalletPresent ? "configured" : "missing"}`,
    `Headless enabled: ${snapshot.headlessEnabled ?? "unknown"}`,
    `Integration mode: ${snapshot.mode || "widget"}`,
    `Quote endpoint: ${snapshot.quoteEndpoint || "/api/v1/pricing/public/quotes"}`,
    `HTTP status: ${diagnostic.statusCode || "n/a"}`,
    `HTTP method: ${diagnostic.httpMethod || "n/a"}`,
    `Request params: ${diagnostic.requestParams ? JSON.stringify(diagnostic.requestParams) : "n/a"}`,
    `Request body: ${diagnostic.requestBody ? JSON.stringify(diagnostic.requestBody) : "n/a"}`,
    `Response body: ${diagnostic.responseBody ? JSON.stringify(diagnostic.responseBody) : "n/a"}`,
    `Execution time (ms): ${diagnostic.executionTimeMs ?? "n/a"}`,
    `Timestamp: ${diagnostic.timestamp || new Date().toISOString()}`,
    `Correlation ID: ${diagnostic.correlationId || ctx.correlationId || "n/a"}`,
    `Funding Order ID: ${ctx.fundingOrderId || "n/a"}`,
    `Provider reference: ${ctx.providerReference || "n/a"}`,
  ];
  return lines.join("\n");
}

/**
 * @param {Object} requestConfig
 * @param {Object} [ctx]
 * @returns {Promise<import("axios").AxiosResponse>}
 */
async function transakHttpRequest(requestConfig, ctx = {}) {
  const started = Date.now();
  logOutgoingRequest(requestConfig);

  try {
    const response = await axios(requestConfig);
    if (isDebugEnabled()) {
      logger.info("transak.http.response", {
        httpMethod: requestConfig.method ? String(requestConfig.method).toUpperCase() : null,
        url: requestConfig.url || null,
        statusCode: response.status,
        executionTimeMs: Date.now() - started,
        correlationId: ctx.correlationId || null,
      });
    }
    return response;
  } catch (err) {
    const executionTimeMs = Date.now() - started;
    // Ensure original request payload is available even if axios omitted fields.
    if (!err.config) {
      err.config = requestConfig;
    } else {
      err.config = {
        ...requestConfig,
        ...err.config,
        params: err.config.params ?? requestConfig.params,
        data: err.config.data ?? requestConfig.data,
        headers: err.config.headers ?? requestConfig.headers,
        url: err.config.url || requestConfig.url,
        method: err.config.method || requestConfig.method,
      };
    }
    logTransakHttpError(ctx.errorEvent || "transak.http.failed", err, {
      ...ctx,
      executionTimeMs,
    });
    throw wrapTransakHttpError(err, { ...ctx, executionTimeMs });
  }
}

/**
 * @param {Object} getters
 * @returns {Object}
 */
function getHealthStatus(getters) {
  const snapshot = getConfigSnapshot(getters);
  return {
    configured: snapshot.configured,
    environment: snapshot.environment,
    baseUrl: snapshot.publicApiBaseUrl,
    gatewayBaseUrl: snapshot.gatewayApiBaseUrl,
    apiKeyPresent: snapshot.apiKeyPresent,
    secretPresent: snapshot.secretPresent,
    treasuryWalletPresent: snapshot.treasuryWalletPresent,
    webhookSecretPresent: snapshot.webhookSecretPresent,
    mode: snapshot.mode,
    headlessEnabled: snapshot.headlessEnabled,
    debugEnabled: snapshot.debugEnabled,
    quoteEndpoint: snapshot.quoteEndpoint,
    widgetSessionEndpoint: snapshot.widgetSessionEndpoint,
    defaultFiat: snapshot.defaultFiat,
    defaultCrypto: snapshot.defaultCrypto,
    defaultNetwork: snapshot.defaultNetwork,
    lastDiagnostic: lastDiagnosticSnapshot ?
      {
        statusCode: lastDiagnosticSnapshot.statusCode || null,
        url: lastDiagnosticSnapshot.url || null,
        timestamp: lastDiagnosticSnapshot.timestamp || null,
        correlationId: lastDiagnosticSnapshot.correlationId || null,
      } :
      null,
  };
}

/**
 * @returns {Object|null}
 */
function getLastDiagnosticSnapshot() {
  return lastDiagnosticSnapshot;
}

module.exports = {
  PartnerConfigurationError,
  PARTNER_CONFIGURATION_MESSAGE,
  isDebugEnabled,
  maskApiKey,
  maskHeaders,
  maskRequestPayload,
  extractRequestForLog,
  getConfigSnapshot,
  logStartupConfiguration,
  validateQuoteRequest,
  isPartnerConfigurationMessage,
  extractTransakError,
  wrapTransakHttpError,
  logTransakHttpError,
  logOutgoingRequest,
  buildSupportReport,
  transakHttpRequest,
  getHealthStatus,
  getLastDiagnosticSnapshot,
};
