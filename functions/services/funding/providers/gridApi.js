/**
 * @fileoverview Lightspark Grid HTTP client.
 * API calls only. No wallet, ledger, or funding-order logic.
 *
 * Base URL (sandbox and production): https://api.lightspark.com/grid/2025-10-13
 * Auth: HTTP Basic with GRID_CLIENT_ID / GRID_CLIENT_SECRET.
 * The token selects sandbox vs production. GRID_ENVIRONMENT is TruePay's gate.
 */

const axios = require("axios");
const config = require("../../../config");
const { createLogger } = require("../../../utils/paymentOpsLogger");

const logger = createLogger({ service: "gridApi", provider: "grid" });

class GridApiError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number|null, code?: string|null, timeout?: boolean }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = "GridApiError";
    this.statusCode = details.status || null;
    this.gridCode = details.code || null;
    this.timeout = details.timeout === true;
  }
}

/**
 * @returns {string}
 */
function gridEnvironment() {
  return String(process.env.GRID_ENVIRONMENT || config.grid.environment || "").toLowerCase();
}

/**
 * Sandbox helpers are allowed only when this is explicitly sandbox.
 * @returns {boolean}
 */
function isSandbox() {
  return gridEnvironment() === "sandbox";
}

/**
 * @returns {{ clientId: string, clientSecret: string }}
 */
function requireCredentials() {
  const clientId = process.env.GRID_CLIENT_ID || config.grid.clientId || null;
  const clientSecret = process.env.GRID_CLIENT_SECRET || config.grid.clientSecret || null;
  if (!clientId || !clientSecret) {
    throw new GridApiError("Grid is not configured (GRID_CLIENT_ID, GRID_CLIENT_SECRET)");
  }
  return { clientId, clientSecret };
}

/**
 * @param {string} id
 * @returns {string}
 */
function encodeId(id) {
  return encodeURIComponent(String(id));
}

/**
 * @param {import("axios").AxiosError} err
 * @returns {GridApiError}
 */
function toGridError(err) {
  if (err instanceof GridApiError) {
    return err;
  }
  const timedOut = err.code === "ECONNABORTED" || err.code === "ETIMEDOUT" ||
    /timeout/i.test(String(err.message || ""));
  if (timedOut || !err.response) {
    return new GridApiError("Grid API timeout", { timeout: true });
  }
  const status = err.response.status || null;
  const body = err.response.data && typeof err.response.data === "object" ? err.response.data : {};
  const code = body.code ? String(body.code) : null;
  const reason = body.reason || body.message || null;
  const detail = reason || code || "request failed";
  return new GridApiError(`Grid ${status}: ${detail}`, { status, code });
}

/**
 * @param {"get"|"post"|"patch"|"delete"} method
 * @param {string} path Path beginning with `/`, ids already encoded.
 * @param {{ body?: Object|null, query?: Object|null, idempotencyKey?: string|null, correlationId?: string|null, fundingOrderId?: string|null, userId?: string|null }} [options]
 * @returns {Promise<Object>}
 */
async function request(method, path, options = {}) {
  const { clientId, clientSecret } = requireCredentials();
  const baseUrl = String(process.env.GRID_API_BASE_URL || config.grid.baseUrl).replace(/\/$/, "");
  const timeout = Number(config.grid.timeoutMs) || 20000;
  const headers = { "Content-Type": "application/json" };
  if (options.idempotencyKey) {
    headers["Idempotency-Key"] = String(options.idempotencyKey).slice(0, 255);
  }

  try {
    const response = await axios({
      method,
      url: `${baseUrl}${path}`,
      params: options.query || undefined,
      data: options.body === undefined ? undefined : options.body,
      auth: { username: clientId, password: clientSecret },
      headers,
      timeout,
      validateStatus: (status) => status >= 200 && status < 300,
    });
    return response.data && typeof response.data === "object" ? response.data : {};
  } catch (err) {
    const gridErr = toGridError(err);
    logger.error("grid.api.failed", {
      correlationId: options.correlationId || null,
      fundingOrderId: options.fundingOrderId || null,
      userId: options.userId || null,
      method: String(method).toUpperCase(),
      path,
      status: gridErr.statusCode,
      gridCode: gridErr.gridCode,
      timeout: gridErr.timeout,
      error: gridErr.message,
    });
    throw gridErr;
  }
}

/**
 * @param {Object} body
 * @returns {Promise<Object>}
 */
function createCustomer(body, ctx = {}) {
  return request("post", "/customers", { body, ...ctx });
}

/**
 * @param {string} customerId
 * @param {Object} body
 * @returns {Promise<Object>}
 */
function updateCustomer(customerId, body, ctx = {}) {
  return request("patch", `/customers/${encodeId(customerId)}`, { body, ...ctx });
}

/**
 * Current agreement versions the customer must accept before Grid provisions accounts.
 * @returns {Promise<Object>}
 */
function listCustomerAgreements(ctx = {}) {
  return request("get", "/customers/agreements", ctx);
}

/**
 * @param {string} customerId
 * @returns {Promise<Object>}
 */
function getCustomer(customerId, ctx = {}) {
  return request("get", `/customers/${encodeId(customerId)}`, ctx);
}

/**
 * @param {string} platformCustomerId
 * @returns {Promise<Object>}
 */
function listCustomersByPlatformId(platformCustomerId, ctx = {}) {
  return request("get", "/customers", {
    query: { platformCustomerId: String(platformCustomerId), limit: 20 },
    ...ctx,
  });
}

/**
 * POST /internal-accounts. Officially creates RULE_BASED accounts only.
 * @param {Object} body
 * @param {string} [idempotencyKey]
 * @returns {Promise<Object>}
 */
function createInternalAccount(body, idempotencyKey, ctx = {}) {
  return request("post", "/internal-accounts", {
    body,
    idempotencyKey: idempotencyKey || null,
    ...ctx,
  });
}

/**
 * GET /customers/internal-accounts (list customer internal accounts).
 * @param {{ customerId: string, currency?: string, type?: string }} query
 * @returns {Promise<Object>}
 */
function listCustomerInternalAccounts(query, ctx = {}) {
  return request("get", "/customers/internal-accounts", { query, ...ctx });
}

/**
 * Deprecated. Same-currency pull. Prefer funding instructions for deposits.
 * @param {Object} body
 * @param {string} [idempotencyKey]
 * @returns {Promise<Object>}
 */
function createTransferIn(body, idempotencyKey, ctx = {}) {
  return request("post", "/transfer-in", {
    body,
    idempotencyKey: idempotencyKey || null,
    ...ctx,
  });
}

/**
 * @param {string} transactionId
 * @returns {Promise<Object>}
 */
function getTransaction(transactionId, ctx = {}) {
  return request("get", `/transactions/${encodeId(transactionId)}`, ctx);
}

/**
 * Sandbox only. POST /sandbox/internal-accounts/{accountId}/fund
 * Amount is minor units (USD cents).
 * @param {string} accountId
 * @param {number} amountMinor
 * @returns {Promise<Object>}
 */
async function sandboxFundInternalAccount(accountId, amountMinor, ctx = {}) {
  if (!isSandbox()) {
    throw new GridApiError("Grid sandbox funding is disabled (GRID_ENVIRONMENT must be sandbox)");
  }
  return request(
      "post",
      `/sandbox/internal-accounts/${encodeId(accountId)}/fund`,
      { body: { amount: amountMinor }, ...ctx },
  );
}

module.exports = {
  GridApiError,
  gridEnvironment,
  isSandbox,
  encodeId,
  request,
  createCustomer,
  updateCustomer,
  listCustomerAgreements,
  getCustomer,
  listCustomersByPlatformId,
  createInternalAccount,
  listCustomerInternalAccounts,
  createTransferIn,
  getTransaction,
  sandboxFundInternalAccount,
};
