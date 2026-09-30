/**
 * @fileoverview Crossmint Onramp HTTP client (staging or production).
 * API calls only. No wallet, ledger, or funding-order logic.
 *
 * Docs: POST/GET /2022-06-09/orders, PUT /2025-06-09/users/{locator}/linked-wallets/{address}
 * Staging: https://staging.crossmint.com/api
 * Production: https://www.crossmint.com/api
 */

const axios = require("axios");
const config = require("../../../config");
const { createLogger } = require("../../../utils/paymentOpsLogger");

const logger = createLogger({ service: "crossmintApi", provider: "crossmint" });

const STAGING = {
  environment: "staging",
  host: "https://staging.crossmint.com",
  baseUrl: "https://staging.crossmint.com/api",
  chain: "base-sepolia",
  tokenLocator: "base-sepolia:0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  locatorPrefixes: ["solana:", "base-sepolia:", "polygon-amoy:", "stellar:"],
  serverKeyPrefix: "sk_staging_",
  clientKeyPrefix: "ck_staging_",
};

const PRODUCTION = {
  environment: "production",
  host: "https://www.crossmint.com",
  baseUrl: "https://www.crossmint.com/api",
  chain: "base",
  tokenLocator: "base:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  locatorPrefixes: ["ethereum:", "polygon:", "solana:", "stellar:"],
  serverKeyPrefix: "sk_production_",
  clientKeyPrefix: "ck_production_",
};

class CrossmintApiError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number|null, code?: string|null, timeout?: boolean }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = "CrossmintApiError";
    this.statusCode = details.status || null;
    this.crossmintCode = details.code || null;
    this.timeout = details.timeout === true;
  }
}

/**
 * @returns {"staging"|"production"}
 */
function environment() {
  const raw = String(
      process.env.CROSSMINT_ENVIRONMENT || config.crossmint?.environment || "staging",
  ).toLowerCase();
  return raw === "production" ? "production" : "staging";
}

/**
 * @returns {typeof STAGING}
 */
function profile() {
  return environment() === "production" ? PRODUCTION : STAGING;
}

/**
 * @param {string} stagingKey
 * @param {string} prodKey
 * @param {*} stagingFallback
 * @param {*} prodFallback
 * @returns {*|null}
 */
function pick(stagingKey, prodKey, stagingFallback, prodFallback) {
  if (environment() === "production") {
    const value = process.env[prodKey];
    if (value) return value;
    return prodFallback === undefined ? null : prodFallback;
  }
  const value = process.env[stagingKey];
  if (value) return value;
  return stagingFallback === undefined ? null : stagingFallback;
}

/**
 * @param {string} raw
 * @param {string} expectedHost
 * @returns {string}
 */
function normalizeBaseUrl(raw, expectedHost) {
  const trimmed = String(raw || "").replace(/\/$/, "");
  if (!trimmed.startsWith(expectedHost)) {
    throw new CrossmintApiError(
        `Crossmint ${environment()} requires ${expectedHost}`,
    );
  }
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

/**
 * @returns {string}
 */
function apiBaseUrl() {
  const envProfile = profile();
  const override = pick(
      "CROSSMINT_BASE_URL",
      "CROSSMINT_BASE_URL_PROD",
      config.crossmint?.baseUrl,
      config.crossmint?.baseUrlProd,
  );
  return normalizeBaseUrl(override || envProfile.baseUrl, envProfile.host);
}

/**
 * @deprecated Use apiBaseUrl()
 * @returns {string}
 */
function stagingBaseUrl() {
  return apiBaseUrl();
}

/**
 * @param {string|null} key
 * @param {"server"|"client"} kind
 */
function assertKeyPrefix(key, kind) {
  if (!key) return;
  const expected = kind === "client" ? profile().clientKeyPrefix : profile().serverKeyPrefix;
  if (!String(key).startsWith(expected)) {
    throw new CrossmintApiError(
        `Crossmint ${environment()} requires a ${expected}* ${kind} key`,
    );
  }
}

/**
 * @returns {string}
 */
function requireServerApiKey() {
  const envProfile = profile();
  const key = pick(
      "CROSSMINT_SERVER_API_KEY",
      "CROSSMINT_SERVER_API_KEY_PROD",
      config.crossmint?.serverApiKey,
      config.crossmint?.serverApiKeyProd,
  );
  if (!key) {
    const name = envProfile.environment === "production" ?
      "CROSSMINT_SERVER_API_KEY_PROD" :
      "CROSSMINT_SERVER_API_KEY";
    throw new CrossmintApiError(`Crossmint is not configured (${name})`);
  }
  assertKeyPrefix(key, "server");
  return key;
}

/**
 * @returns {string}
 */
function webhookSecret() {
  return pick(
      "CROSSMINT_WEBHOOK_SECRET",
      "CROSSMINT_WEBHOOK_SECRET_PROD",
      config.crossmint?.webhookSecret,
      config.crossmint?.webhookSecretProd,
  ) || "";
}

/**
 * @returns {string}
 */
function collectionWallet() {
  const envProfile = profile();
  const address = pick(
      "CROSSMINT_COLLECTION_WALLET",
      "CROSSMINT_COLLECTION_WALLET_PROD",
      config.crossmint?.collectionWallet,
      config.crossmint?.collectionWalletProd,
  );
  if (!address) {
    const name = envProfile.environment === "production" ?
      "CROSSMINT_COLLECTION_WALLET_PROD" :
      "CROSSMINT_COLLECTION_WALLET";
    throw new CrossmintApiError(`Crossmint is not configured (${name})`);
  }
  return String(address);
}

/**
 * Production `base:` must not match `base-sepolia:`.
 * @param {string} value
 * @param {string[]} prefixes
 * @returns {boolean}
 */
function locatorMatches(value, prefixes) {
  if (value.startsWith("base-sepolia:")) {
    return prefixes.includes("base-sepolia:");
  }
  if (value.startsWith("base:")) {
    return prefixes.includes("base:");
  }
  return prefixes.some((prefix) => value.startsWith(prefix));
}

/**
 * @returns {string}
 */
function tokenLocator() {
  const envProfile = profile();
  const locator = pick(
      "CROSSMINT_TOKEN_LOCATOR",
      "CROSSMINT_TOKEN_LOCATOR_PROD",
      config.crossmint?.tokenLocator,
      config.crossmint?.tokenLocatorProd,
  ) || envProfile.tokenLocator;
  const value = String(locator);
  const prefixes = envProfile.environment === "production" ?
    [...envProfile.locatorPrefixes, "base:"] :
    envProfile.locatorPrefixes;
  if (!locatorMatches(value, prefixes)) {
    throw new CrossmintApiError(
        `Crossmint ${environment()} tokenLocator is not valid for this environment`,
    );
  }
  return value;
}

/**
 * @returns {string}
 */
function chain() {
  const envProfile = profile();
  return String(pick(
      "CROSSMINT_CHAIN",
      "CROSSMINT_CHAIN_PROD",
      config.crossmint?.chain,
      config.crossmint?.chainProd,
  ) || envProfile.chain);
}

/**
 * @returns {string}
 */
function userLocator() {
  const envProfile = profile();
  let locator = pick(
      "CROSSMINT_USER_LOCATOR",
      "CROSSMINT_USER_LOCATOR_PROD",
      config.crossmint?.userLocator,
      config.crossmint?.userLocatorProd,
  );
  if (!locator && environment() === "production") {
    locator = process.env.CROSSMINT_USER_LOCATOR || config.crossmint?.userLocator || null;
  }
  if (!locator) {
    const name = envProfile.environment === "production" ?
      "CROSSMINT_USER_LOCATOR_PROD" :
      "CROSSMINT_USER_LOCATOR";
    throw new CrossmintApiError(`Crossmint is not configured (${name})`);
  }
  return String(locator);
}

/**
 * Documented WebView checkout URL. Flutter SDK requires Dart 3.11; SafariTap is on ^3.1.4.
 * https://docs.crossmint.com/payments/embedded/guides/webview-integration
 *
 * @param {{ orderId: string, clientSecret: string, receiptEmail?: string|null }} params
 * @returns {string|null}
 */
function buildEmbeddedCheckoutUrl(params) {
  const clientApiKey = pick(
      "CROSSMINT_CLIENT_API_KEY",
      "CROSSMINT_CLIENT_API_KEY_PROD",
      config.crossmint?.clientApiKey,
      config.crossmint?.clientApiKeyProd,
  );
  if (!clientApiKey || !params.orderId || !params.clientSecret) return null;
  assertKeyPrefix(clientApiKey, "client");
  const query = new URLSearchParams({
    orderId: String(params.orderId),
    clientSecret: String(params.clientSecret),
    apiKey: String(clientApiKey),
    payment: JSON.stringify({
      receiptEmail: params.receiptEmail || undefined,
      crypto: { enabled: false },
      fiat: { enabled: true },
      defaultMethod: "fiat",
    }),
    appearance: JSON.stringify({
      rules: {
        DestinationInput: { display: "hidden" },
        ReceiptEmailInput: { display: "hidden" },
      },
    }),
  });
  return `${profile().host}/sdk/2024-03-05/embedded-checkout?${query.toString()}`;
}

/**
 * @param {import("axios").AxiosError} err
 * @returns {CrossmintApiError}
 */
function toCrossmintError(err) {
  if (err instanceof CrossmintApiError) {
    return err;
  }
  const timedOut = err.code === "ECONNABORTED" || err.code === "ETIMEDOUT" ||
    /timeout/i.test(String(err.message || ""));
  if (timedOut || !err.response) {
    return new CrossmintApiError("Crossmint API timeout", { timeout: true });
  }
  const status = err.response.status || null;
  const body = err.response.data && typeof err.response.data === "object" ? err.response.data : {};
  const code = body.code ? String(body.code) : null;
  const reason = body.message || body.reason || null;
  const detail = reason || code || "request failed";
  return new CrossmintApiError(`Crossmint ${status}: ${detail}`, { status, code });
}

/**
 * @param {"get"|"post"|"put"} method
 * @param {string} path
 * @param {{ body?: Object|null, correlationId?: string|null, fundingOrderId?: string|null, userId?: string|null }} [options]
 * @returns {Promise<Object>}
 */
async function request(method, path, options = {}) {
  const apiKey = requireServerApiKey();
  const timeout = Number(config.crossmint?.timeoutMs) || 20000;
  try {
    const response = await axios({
      method,
      url: `${apiBaseUrl()}${path}`,
      data: options.body === undefined ? undefined : options.body,
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
      },
      timeout,
      validateStatus: (status) => status >= 200 && status < 300,
    });
    return response.data && typeof response.data === "object" ? response.data : {};
  } catch (err) {
    const mapped = toCrossmintError(err);
    logger.error("crossmint.api.failed", {
      correlationId: options.correlationId || null,
      fundingOrderId: options.fundingOrderId || null,
      userId: options.userId || null,
      method: String(method).toUpperCase(),
      path,
      status: mapped.statusCode,
      crossmintCode: mapped.crossmintCode,
      timeout: mapped.timeout,
      error: mapped.message,
    });
    throw mapped;
  }
}

/**
 * @param {{ lineItems: Array, payment: Object, recipient: Object }} body
 * @returns {Promise<Object>}
 */
function createOrder(body, ctx = {}) {
  return request("post", "/2022-06-09/orders", { body, ...ctx });
}

/**
 * @param {string} orderId
 * @returns {Promise<Object>}
 */
function getOrder(orderId, ctx = {}) {
  return request("get", `/2022-06-09/orders/${encodeURIComponent(String(orderId))}`, ctx);
}

/**
 * Link TruePay collection wallet to the Crossmint user. `proof` is omitted
 * for amounts under the documented $1,000 ownership threshold.
 *
 * @param {{ userLocator: string, address: string, chain: string }} params
 * @returns {Promise<Object>}
 */
function linkWallet(params, ctx = {}) {
  const locator = encodeURIComponent(String(params.userLocator));
  const address = encodeURIComponent(String(params.address));
  return request("put", `/2025-06-09/users/${locator}/linked-wallets/${address}`, {
    body: { chain: String(params.chain) },
    ...ctx,
  });
}

module.exports = {
  CrossmintApiError,
  environment,
  apiBaseUrl,
  stagingBaseUrl,
  webhookSecret,
  collectionWallet,
  tokenLocator,
  chain,
  userLocator,
  createOrder,
  getOrder,
  linkWallet,
  buildEmbeddedCheckoutUrl,
};
