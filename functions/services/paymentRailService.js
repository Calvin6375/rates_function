/**
 * @fileoverview Payment rail abstraction for B2B checkout (IntaSend first; swappable rails).
 */

const axios = require("axios");
const config = require("../config");

/** @type {Readonly<Record<string, string>>} */
const circleRailAdapter = require("./circle/circleRailAdapter");
const settlementRailService = require("./settlement/settlementRailService");

const SUPPORTED_RAILS = Object.freeze({
  paystack: "paystack",
  intasend: "intasend",
  manual: "manual",
  circle: "circle",
});

/** Fiat currencies IntaSend checkout supports today. */
const INTASEND_CHECKOUT_CURRENCIES = new Set(["KES", "USD", "GBP", "EUR", "NGN", "GHS"]);

/** Default ISO country codes when payer country is not supplied. */
const CURRENCY_DEFAULT_COUNTRY = Object.freeze({
  KES: "KE",
  USD: "US",
  GBP: "GB",
  EUR: "DE",
  NGN: "NG",
  GHS: "GH",
});

/**
 * Error thrown when IntaSend checkout API rejects the request.
 */
class IntaSendCheckoutError extends Error {
  /**
   * @param {string} message
   * @param {number} httpStatus
   * @param {unknown} body
   */
  constructor(message, httpStatus, body) {
    super(message);
    this.name = "IntaSendCheckoutError";
    this.httpStatus = httpStatus;
    this.intaSendBody = body;
  }
}

/**
 * Flatten IntaSend error response body into a readable string.
 * @param {unknown} data
 * @returns {string}
 */
function flattenIntaSendErrorBody(data) {
  if (data == null) {
    return "";
  }
  if (typeof data === "string") {
    return data.trim();
  }
  if (typeof data !== "object") {
    return String(data);
  }

  /** @type {string[]} */
  const parts = [];
  const obj = /** @type {Record<string, unknown>} */ (data);

  for (const key of ["detail", "message", "error"]) {
    const val = obj[key];
    if (!val) {
      continue;
    }
    if (typeof val === "string") {
      parts.push(val);
    } else if (typeof val === "object") {
      parts.push(JSON.stringify(val));
    } else {
      parts.push(String(val));
    }
  }

  if (Array.isArray(obj.errors)) {
    for (const item of obj.errors) {
      if (typeof item === "string") {
        parts.push(item);
        continue;
      }
      if (item && typeof item === "object") {
        const row = /** @type {Record<string, unknown>} */ (item);
        const attr = row.attr ? String(row.attr) : "";
        const detail = row.detail ? String(row.detail) : "";
        const code = row.code ? String(row.code) : "";
        if (attr && detail) {
          parts.push(`${attr}: ${detail}`);
        } else if (detail) {
          parts.push(detail);
        } else if (code) {
          parts.push(code);
        } else {
          parts.push(JSON.stringify(item));
        }
      }
    }
  }

  for (const [key, val] of Object.entries(obj)) {
    if (["detail", "message", "error", "errors", "type"].includes(key)) {
      continue;
    }
    if (val == null || val === "") {
      continue;
    }
    if (Array.isArray(val)) {
      parts.push(`${key}: ${val.map(String).join(", ")}`);
    } else if (typeof val === "object") {
      parts.push(`${key}: ${JSON.stringify(val)}`);
    } else {
      parts.push(`${key}: ${String(val)}`);
    }
  }

  return parts.filter(Boolean).join("; ");
}

/**
 * @param {unknown} err
 * @returns {{ message: string, httpStatus: number|null, body: unknown }|null}
 */
function getIntaSendErrorDetails(err) {
  if (!err || typeof err !== "object") {
    return null;
  }
  if (err instanceof IntaSendCheckoutError) {
    return {
      message: err.message,
      httpStatus: err.httpStatus,
      body: err.intaSendBody,
    };
  }
  const axiosErr = /** @type {{ response?: { status?: number, data?: unknown }, message?: string }} */ (err);
  if (!axiosErr.response) {
    return null;
  }
  const httpStatus = axiosErr.response.status ?? null;
  const body = axiosErr.response.data;
  const detail = flattenIntaSendErrorBody(body);
  const message = detail ?
    `IntaSend checkout failed (${httpStatus}): ${detail}` :
    (axiosErr.message || "IntaSend checkout failed");
  return { message, httpStatus, body };
}

/**
 * @param {unknown} err
 * @returns {never}
 */
function throwIntaSendCheckoutError(err) {
  const existing = getIntaSendErrorDetails(err);
  if (existing) {
    throw new IntaSendCheckoutError(
        existing.message,
        existing.httpStatus || 502,
        existing.body,
    );
  }
  throw err;
}

/**
 * @param {string} currency
 * @param {string|null|undefined} country
 * @returns {string|null}
 */
function defaultCountryForCurrency(currency, country) {
  if (country && String(country).trim()) {
    return String(country).trim().toUpperCase();
  }
  const cur = String(currency || "").toUpperCase();
  return CURRENCY_DEFAULT_COUNTRY[cur] || null;
}

/**
 * @returns {string}
 */
function defaultRail() {
  return String(process.env.B2B_DEFAULT_PAYMENT_RAIL || SUPPORTED_RAILS.paystack).toLowerCase();
}

/**
 * TruePay-hosted checkout theme for IntaSend express checkout (colors/fonts — not layout/CSS).
 * Matches paymentLinkCheckoutPage.js tokens.
 *
 * @returns {Record<string, string>}
 */
function truePayIntaSendCheckoutStyles() {
  return {
    borderRadius: "12px",
    componentBackgroundColor: "#ebf0f0",
    ctaBgColor: "#0d9488",
    ctaFontColor: "#ffffff",
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
    fontWeight: "normal",
    inputBackgroundColor: "#ffffff",
    inputBorderColor: "#d8e4e4",
    inputBorderRadius: "12px",
    inputLabelColor: "#5a6b6b",
    inputTextColor: "#1a2e2e",
    selectedBorderColor: "2px solid #0d9488",
    selectedCardBackgroundColor: "#ffffff",
    selectedCardShadow: "0 4px 24px rgba(13, 148, 136, 0.12)",
    selectedFontColor: "#0f766e",
    unselectedBorderColor: "2px solid #d8e4e4",
    unselectedCardBackgroundColor: "#ffffff",
    unselectedCardShadow: "none",
    unselectedFontColor: "#1a2e2e",
  };
}

/**
 * IntaSend api_ref allows limited charset; keep short and alphanumeric.
 *
 * @param {string|null|undefined} preferred
 * @param {string} fallback
 * @returns {string}
 */
function sanitizeIntaSendApiRef(preferred, fallback) {
  const raw = String(preferred || fallback || "b2bpay");
  const cleaned = raw.replace(/[^a-zA-Z0-9-_]/g, "").slice(0, 48);
  return cleaned || "b2bpay";
}

/**
 * Optional merchant origin hostname (IntaSend dashboard / branding).
 *
 * @returns {string|null}
 */
function intaSendMerchantOrigin() {
  const explicit = process.env.B2B_INTASEND_MERCHANT_ORIGIN ||
    process.env.INTASEND_MERCHANT_ORIGIN;
  if (explicit && String(explicit).trim()) {
    return String(explicit).trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  }
  const base = process.env.PAYMENT_LINK_BASE_URL;
  if (base && String(base).trim()) {
    try {
      return new URL(String(base).trim()).hostname;
    } catch (e) {
      // ignore
    }
  }
  return null;
}

/**
 * @param {string} publishableKey
 * @returns {boolean}
 */
function isIntaSendSandbox(publishableKey) {
  const key = String(publishableKey || "").toLowerCase();
  if (process.env.INTASEND_ENV === "sandbox") {
    return true;
  }
  return key.includes("sandbox") || key.includes("test");
}

/**
 * @param {string|null} publishableKeyOverride
 * @returns {{ publishableKey: string, baseUrl: string, isSandbox: boolean }}
 */
function getIntaSendCheckoutConfig(publishableKeyOverride = null) {
  const publishableKey =
    publishableKeyOverride ||
    process.env.INTASEND_PUBLISHABLE_KEY ||
    null;
  if (!publishableKey) {
    throw new Error(
        "IntaSend publishable key is not configured (INTASEND_PUBLISHABLE_KEY).",
    );
  }
  const sandbox = isIntaSendSandbox(publishableKey);
  const host = sandbox ? "https://sandbox.intasend.com" : "https://payment.intasend.com";
  return {
    publishableKey,
    baseUrl: `${host}/api/v1/checkout/`,
    isSandbox: sandbox,
  };
}

/**
 * @param {string} checkoutUrl
 * @returns {string|null}
 */
function extractCheckoutIdFromUrl(checkoutUrl) {
  if (!checkoutUrl || typeof checkoutUrl !== "string") {
    return null;
  }
  const match = checkoutUrl.match(/checkout\/([^/?#]+)/i);
  if (!match || !match[1]) {
    return null;
  }
  const segment = match[1].toLowerCase();
  if (segment === "payment-link") {
    return null;
  }
  return match[1];
}

/**
 * Collect all IntaSend identifiers from a checkout create response.
 *
 * @param {Object} data
 * @param {string|null} checkoutUrl
 * @returns {string[]}
 */
function collectCheckoutIdentifierIds(data, checkoutUrl) {
  const ids = new Set();
  const d = data && typeof data === "object" ? data : {};
  for (const key of ["id", "invoice_id", "checkout_id", "reference", "api_ref"]) {
    if (d[key]) {
      ids.add(String(d[key]));
    }
  }
  const fromUrl = extractCheckoutIdFromUrl(checkoutUrl);
  if (fromUrl) {
    ids.add(fromUrl);
  }
  return [...ids];
}

/**
 * @param {boolean} [sandboxOverride]
 * @returns {{ secretKey: string|null, apiHost: string, isSandbox: boolean }}
 */
function getIntaSendSecretConfig(sandboxOverride = null) {
  const secretKey =
    process.env.INTASEND_SECRET_KEY ||
    process.env.INTASEND_API_SECRET ||
    null;
  const publishableKey = process.env.INTASEND_PUBLISHABLE_KEY || "";
  const isSandbox = sandboxOverride != null ?
    sandboxOverride :
    isIntaSendSandbox(publishableKey);
  const apiHost = isSandbox ?
    "https://sandbox.intasend.com" :
    "https://payment.intasend.com";
  return { secretKey, apiHost, isSandbox };
}

/**
 * Fetch IntaSend collection/checkout status by invoice or checkout id.
 *
 * @param {string} identifier
 * @returns {Promise<Object|null>}
 */
async function fetchIntaSendPaymentStatus(identifier) {
  if (!identifier) {
    return null;
  }
  const { secretKey, apiHost } = getIntaSendSecretConfig();
  if (!secretKey) {
    console.warn("fetchIntaSendPaymentStatus: INTASEND_SECRET_KEY not configured");
    return null;
  }
  const axios = require("axios");
  const id = String(identifier).trim();
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${secretKey}`,
  };
  const urls = [
    `${apiHost}/api/v1/payment/collections/${encodeURIComponent(id)}/status/`,
    `${apiHost}/api/v1/checkout/${encodeURIComponent(id)}/`,
  ];
  for (const url of urls) {
    try {
      const response = await axios.get(url, {
        headers,
        timeout: 12000,
      });
      const body = response.data || {};
      const merged = body.invoice ? { ...body.invoice, ...body } : body;
      if (merged.state || merged.invoice_id || merged.id) {
        return merged;
      }
    } catch (err) {
      if (err.response?.status !== 404) {
        console.warn("fetchIntaSendPaymentStatus:", url, err.message);
      }
    }
  }
  return null;
}

/**
 * @param {Object} params
 * @param {number} params.amount
 * @param {string} params.currency
 * @param {string} params.apiRef
 * @param {string} [params.redirectUrl]
 * @param {string} [params.email]
 * @param {string} [params.phoneNumber]
 * @param {string} [params.firstName]
 * @param {string} [params.lastName]
 * @param {string} [params.country]
 * @param {string} [params.comment]
 * @returns {Promise<{ rail: string, checkoutUrl: string, checkoutId: string, invoiceId: string|null, raw: Object }>}
 */
async function createIntaSendCheckoutSession(params) {
  const {
    amount,
    currency,
    apiRef,
    redirectUrl,
    email,
    phoneNumber,
    firstName,
    lastName,
    country,
    comment,
  } = params;

  const cur = String(currency || "KES").toUpperCase();
  if (!INTASEND_CHECKOUT_CURRENCIES.has(cur)) {
    throw new Error(
        `Currency ${cur} is not supported on IntaSend checkout. Supported: ` +
        `${Array.from(INTASEND_CHECKOUT_CURRENCIES).join(", ")}.`,
    );
  }

  const { publishableKey, baseUrl } = getIntaSendCheckoutConfig();

  /** @type {Record<string, unknown>} */
  const payload = {
    public_key: publishableKey,
    amount: Number(amount),
    currency: cur,
    api_ref: sanitizeIntaSendApiRef(apiRef, "b2bpay"),
    layout: "tabs",
    channel: "WEBSITE",
    mobile_tarrif: "CUSTOMER-PAYS",
    card_tarrif: "CUSTOMER-PAYS",
    styles: truePayIntaSendCheckoutStyles(),
  };
  const origin = intaSendMerchantOrigin();
  if (origin) {
    payload.merchant_origin = origin;
  }
  if (redirectUrl) {
    payload.redirect_url = redirectUrl;
  }
  if (email) {
    payload.email = email;
  }
  if (phoneNumber) {
    payload.phone_number = phoneNumber;
  }
  if (firstName) {
    payload.first_name = firstName;
  }
  if (lastName) {
    payload.last_name = lastName;
  }
  const countryCode = defaultCountryForCurrency(cur, country);
  if (countryCode) {
    payload.country = countryCode;
  }
  if (comment) {
    payload.comment = comment;
  }

  let response;
  try {
    response = await axios.post(baseUrl, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
      validateStatus: (status) => status >= 200 && status < 300,
    });
  } catch (err) {
    console.error("IntaSend checkout API error", {
      url: baseUrl,
      currency: cur,
      amount: Number(amount),
      response: err.response?.data,
      status: err.response?.status,
    });
    throwIntaSendCheckoutError(err);
  }

  const data = response.data || {};
  const checkoutUrl = data.url || data.checkout_url || null;
  if (!checkoutUrl) {
    throw new Error("IntaSend did not return a checkout URL.");
  }

  const checkoutId =
    data.id ||
    data.checkout_id ||
    extractCheckoutIdFromUrl(checkoutUrl);
  if (!checkoutId) {
    throw new Error("IntaSend did not return a checkout identifier.");
  }

  return {
    rail: SUPPORTED_RAILS.intasend,
    checkoutUrl: String(checkoutUrl),
    checkoutId: String(checkoutId),
    invoiceId: data.invoice_id ? String(data.invoice_id) : null,
    raw: data,
  };
}

/**
 * @param {Object} params
 * @param {string} [params.rail]
 * @param {number} params.amount
 * @param {string} params.currency
 * @param {string} params.apiRef
 * @param {string} [params.redirectUrl]
 * @param {string} [params.email]
 * @param {string} [params.phoneNumber]
 * @param {string} [params.firstName]
 * @param {string} [params.lastName]
 * @param {string} [params.country]
 * @param {string} [params.comment]
 * @returns {Promise<{ rail: string, checkoutUrl: string, checkoutId: string, invoiceId: string|null, raw?: Object, message?: string }>}
 */
async function createSession(params) {
  const rail = String(params.rail || defaultRail()).toLowerCase();
  if (rail === SUPPORTED_RAILS.paystack) {
    throw new Error(
        "Paystack payment-link checkout is started by b2bPaymentLinkCheckoutService, not createSession",
    );
  }
  if (rail === SUPPORTED_RAILS.intasend) {
    return createIntaSendCheckoutSession(params);
  }
  if (rail === SUPPORTED_RAILS.manual) {
    return {
      rail: SUPPORTED_RAILS.manual,
      checkoutUrl: "",
      checkoutId: "",
      invoiceId: null,
      message: "Manual settlement: contact the merchant to complete payment.",
    };
  }
  throw new Error(`Unsupported payment rail: ${rail}`);
}

/**
 * Process a Circle crypto deposit notification (webhook payload or manual replay).
 *
 * @param {Object} params
 * @param {Object} params.payload - Circle webhook notification body
 * @param {string} [params.rawBody] - Original JSON string for dedup hashing
 * @returns {Promise<{ success: boolean, duplicate?: boolean, rail: string, error?: string }>}
 */
async function processDeposit(params) {
  const rail = String(params.rail || "").toLowerCase();
  if (rail === SUPPORTED_RAILS.circle) {
    return processCircleDeposit(params);
  }
  if (rail === SUPPORTED_RAILS.intasend) {
    throw new Error("IntaSend deposits are processed via handleTopUpWebhook, not processDeposit");
  }
  throw new Error(`Unsupported payment rail for deposit: ${rail}`);
}

/**
 * @param {Object} params
 * @returns {Promise<{ success: boolean, duplicate?: boolean, rail: string, error?: string }>}
 */
async function processCircleDeposit(params) {
  const payload = params.payload || params;
  const rawBody = params.rawBody || JSON.stringify(payload);
  const result = await circleRailAdapter.handleWebhookEvent(payload, rawBody);
  return {
    rail: SUPPORTED_RAILS.circle,
    ...result,
  };
}

/**
 * Settlement rails (Daraja B2B) — delegates to settlementRailService.
 * @param {string} [railId]
 * @returns {Object}
 */
function resolveSettlementRail(railId = "daraja_b2b") {
  return settlementRailService.resolveSettlementRail(railId);
}

module.exports = {
  SUPPORTED_RAILS,
  INTASEND_CHECKOUT_CURRENCIES,
  CURRENCY_DEFAULT_COUNTRY,
  IntaSendCheckoutError,
  defaultRail,
  getIntaSendCheckoutConfig,
  getIntaSendErrorDetails,
  flattenIntaSendErrorBody,
  defaultCountryForCurrency,
  truePayIntaSendCheckoutStyles,
  sanitizeIntaSendApiRef,
  intaSendMerchantOrigin,
  extractCheckoutIdFromUrl,
  collectCheckoutIdentifierIds,
  fetchIntaSendPaymentStatus,
  getIntaSendSecretConfig,
  createIntaSendCheckoutSession,
  createSession,
  processDeposit,
  processCircleDeposit,
  resolveSettlementRail,
};
