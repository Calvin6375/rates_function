/**
 * @fileoverview Crossmint Onramp HTTP client (staging).
 * API calls only. No wallet, ledger, or funding-order logic.
 *
 * Docs: POST/GET /2022-06-09/orders, PUT /2025-06-09/users/{locator}/linked-wallets/{address}
 * Staging: https://staging.crossmint.com/api
 */

const axios = require("axios");
const config = require("../../../config");
const { createLogger } = require("../../../utils/paymentOpsLogger");

const logger = createLogger({ service: "crossmintApi", provider: "crossmint" });

const DEFAULT_STAGING_BASE = "https://staging.crossmint.com/api";
const STAGING_LOCATOR_PREFIXES = ["solana:", "base-sepolia:", "polygon-amoy:", "stellar:"];

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
 * @returns {string}
 */
function stagingBaseUrl() {
  const raw = String(process.env.CROSSMINT_BASE_URL || config.crossmint?.baseUrl || DEFAULT_STAGING_BASE)
      .replace(/\/$/, "");
  if (!raw.startsWith("https://staging.crossmint.com")) {
    throw new CrossmintApiError("Crossmint sandbox requires https://staging.crossmint.com");
  }
  return raw.endsWith("/api") ? raw : `${raw}/api`;
}

/**
 * @returns {string}
 */
function requireServerApiKey() {
  const key = process.env.CROSSMINT_SERVER_API_KEY || config.crossmint?.serverApiKey || null;
  if (!key) {
    throw new CrossmintApiError("Crossmint is not configured (CROSSMINT_SERVER_API_KEY)");
  }
  return key;
}

/**
 * @returns {string}
 */
function collectionWallet() {
  const address = process.env.CROSSMINT_COLLECTION_WALLET || config.crossmint?.collectionWallet || null;
  if (!address) {
    throw new CrossmintApiError("Crossmint is not configured (CROSSMINT_COLLECTION_WALLET)");
  }
  return String(address);
}

/**
 * @returns {string}
 */
function tokenLocator() {
  const locator = process.env.CROSSMINT_TOKEN_LOCATOR ||
    config.crossmint?.tokenLocator ||
    "base-sepolia:0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const value = String(locator);
  if (!STAGING_LOCATOR_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    throw new CrossmintApiError("Crossmint sandbox tokenLocator must be a documented staging locator");
  }
  return value;
}

/**
 * @returns {string}
 */
function chain() {
  return String(process.env.CROSSMINT_CHAIN || config.crossmint?.chain || "base-sepolia");
}

/**
 * @returns {string}
 */
function userLocator() {
  const locator = process.env.CROSSMINT_USER_LOCATOR || config.crossmint?.userLocator || null;
  if (!locator) {
    throw new CrossmintApiError("Crossmint is not configured (CROSSMINT_USER_LOCATOR)");
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
  const clientApiKey = process.env.CROSSMINT_CLIENT_API_KEY || config.crossmint?.clientApiKey || null;
  if (!clientApiKey || !params.orderId || !params.clientSecret) return null;
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
  return `https://staging.crossmint.com/sdk/2024-03-05/embedded-checkout?${query.toString()}`;
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
      url: `${stagingBaseUrl()}${path}`,
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
 * for sandbox amounts under the documented $1,000 ownership threshold.
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
  stagingBaseUrl,
  collectionWallet,
  tokenLocator,
  chain,
  userLocator,
  createOrder,
  getOrder,
  linkWallet,
  buildEmbeddedCheckoutUrl,
};
