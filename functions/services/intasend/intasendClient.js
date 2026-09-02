/**
 * @fileoverview Shared IntaSend HTTP client (auth, host resolution, errors).
 * Used by disbursement/payout APIs. Collection checkout remains in paymentRailService.js.
 */

const axios = require("axios");

/**
 * @returns {boolean}
 */
function isIntaSendSandbox() {
  if (process.env.INTASEND_ENV === "sandbox") {
    return true;
  }
  if (process.env.INTASEND_ENV === "production" || process.env.INTASEND_ENV === "live") {
    return false;
  }
  const publishableKey = String(process.env.INTASEND_PUBLISHABLE_KEY || "").toLowerCase();
  const secretKey = String(process.env.INTASEND_SECRET_KEY || "").toLowerCase();
  if (secretKey.includes("live") || publishableKey.includes("live")) {
    return false;
  }
  return publishableKey.includes("sandbox") || publishableKey.includes("test") ||
    secretKey.includes("sandbox") || secretKey.includes("test");
}

/**
 * @returns {{ secretKey: string|null, apiHost: string, isSandbox: boolean }}
 */
function getIntaSendApiConfig() {
  const secretKey =
    process.env.INTASEND_SECRET_KEY ||
    process.env.INTASEND_API_SECRET ||
    null;
  const isSandbox = isIntaSendSandbox();
  // Optional override (e.g. https://api.intasend.com) — default hosts match IntaSend docs.
  const overrideHost = String(process.env.INTASEND_API_HOST || "").trim().replace(/\/$/, "");
  const apiHost = overrideHost || (isSandbox ?
    "https://sandbox.intasend.com" :
    "https://payment.intasend.com");
  return { secretKey, apiHost, isSandbox };
}

/**
 * @returns {boolean}
 */
function isDisbursementStubMode() {
  return process.env.INTASEND_DISBURSEMENT_STUB_MODE === "true";
}

/**
 * @returns {Record<string, string>}
 */
function authHeaders() {
  const { secretKey } = getIntaSendApiConfig();
  if (!secretKey) {
    throw new Error("INTASEND_SECRET_KEY is not configured");
  }
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${secretKey}`,
  };
  const publishableKey = process.env.INTASEND_PUBLISHABLE_KEY;
  if (publishableKey) {
    headers["X-Publishable-Key"] = publishableKey;
  }
  return headers;
}

/**
 * @param {unknown} data
 * @returns {string}
 */
function flattenErrorBody(data) {
  if (data == null) {
    return "";
  }
  if (typeof data === "string") {
    return data.trim();
  }
  if (typeof data !== "object") {
    return String(data);
  }
  const obj = /** @type {Record<string, unknown>} */ (data);
  const parts = [];
  for (const key of ["detail", "message", "error"]) {
    const val = obj[key];
    if (typeof val === "string" && val.trim()) {
      parts.push(val);
    }
  }
  if (Array.isArray(obj.errors)) {
    for (const item of obj.errors) {
      if (typeof item === "string") {
        parts.push(item);
      } else if (item && typeof item === "object") {
        const row = /** @type {Record<string, unknown>} */ (item);
        if (row.detail) {
          parts.push(String(row.detail));
        }
      }
    }
  }
  return parts.filter(Boolean).join("; ");
}

class IntaSendApiError extends Error {
  /**
   * @param {string} message
   * @param {number|null} httpStatus
   * @param {unknown} body
   */
  constructor(message, httpStatus, body) {
    super(message);
    this.name = "IntaSendApiError";
    this.httpStatus = httpStatus;
    this.body = body;
  }
}

/**
 * @param {unknown} err
 * @returns {{ message: string, httpStatus: number|null, body: unknown }|null}
 */
function getIntaSendApiErrorDetails(err) {
  if (err instanceof IntaSendApiError) {
    return { message: err.message, httpStatus: err.httpStatus, body: err.body };
  }
  const axiosErr = /** @type {{ response?: { status?: number, data?: unknown }, message?: string }} */ (err);
  if (!axiosErr.response) {
    return null;
  }
  const httpStatus = axiosErr.response.status ?? null;
  const body = axiosErr.response.data;
  const detail = flattenErrorBody(body);
  const message = detail ?
    `IntaSend API error (${httpStatus}): ${detail}` :
    (axiosErr.message || "IntaSend API request failed");
  return { message, httpStatus, body };
}

/**
 * @param {string} method
 * @param {string} path
 * @param {Object} [options]
 * @param {Object|null} [options.body]
 * @param {number} [options.timeoutMs]
 * @param {boolean} [options.skipAuth] - bank-codes list is documented with empty security
 * @returns {Promise<Object>}
 */
async function intaSendRequest(method, path, options = {}) {
  if (isDisbursementStubMode()) {
    throw new IntaSendApiError("IntaSend disbursement stub mode active", null, null);
  }

  const { apiHost } = getIntaSendApiConfig();
  const url = `${apiHost}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = options.skipAuth ?
    {"Content-Type": "application/json"} :
    authHeaders();
  const timeout = options.timeoutMs || 20000;

  try {
    const response = await axios({
      method,
      url,
      headers,
      data: options.body || undefined,
      timeout,
      validateStatus: (status) => status >= 200 && status < 300,
    });
    return response.data || {};
  } catch (err) {
    const details = getIntaSendApiErrorDetails(err);
    if (details) {
      const { secretKey, apiHost: host, isSandbox } = getIntaSendApiConfig();
      const isAuth = details.httpStatus === 401 || details.httpStatus === 403;
      console.error(JSON.stringify({
        event: isAuth ? "intasend.apiAuthFailed" : "intasend.apiRequestFailed",
        method,
        path,
        apiHost: host,
        isSandbox,
        skipAuth: Boolean(options.skipAuth),
        intaSendEnv: process.env.INTASEND_ENV || null,
        secretKeyConfigured: Boolean(secretKey),
        secretKeyPrefix: isAuth ? maskSensitive(secretKey) : undefined,
        publishableKeyPresent: Boolean(process.env.INTASEND_PUBLISHABLE_KEY),
        upstreamStatus: details.httpStatus,
        upstreamDetail: flattenErrorBody(details.body).slice(0, 400),
      }));
      throw new IntaSendApiError(details.message, details.httpStatus, details.body);
    }
    console.error(JSON.stringify({
      event: "intasend.apiRequestFailed",
      method,
      path,
      error: err instanceof Error ? err.message : String(err),
    }));
    throw err;
  }
}

/**
 * Mask sensitive values for logs.
 * @param {string|null|undefined} value
 * @returns {string}
 */
function maskSensitive(value) {
  if (!value) {
    return "";
  }
  const s = String(value);
  if (s.length <= 4) {
    return "****";
  }
  return `${s.slice(0, 2)}****${s.slice(-2)}`;
}

module.exports = {
  IntaSendApiError,
  isIntaSendSandbox,
  isDisbursementStubMode,
  getIntaSendApiConfig,
  authHeaders,
  flattenErrorBody,
  getIntaSendApiErrorDetails,
  intaSendRequest,
  maskSensitive,
};
