/**
 * @fileoverview Paystack callback URL helpers for C2B external-browser checkout.
 * Default: Paystack redirects to hosted page on `api`, which deep-links back to the Flutter app.
 */

const config = require("../../config");

const DEFAULT_DEEP_LINK = "truepay://payment/callback";
const PAYMENT_RETURN_PATH = "/funding/payment-return";

/**
 * @returns {string}
 */
function apiBaseUrl() {
  const explicit =
    process.env.C2B_API_BASE_URL ||
    process.env.API_BASE_URL ||
    config.c2b?.apiBaseUrl ||
    null;
  if (explicit && String(explicit).trim()) {
    return String(explicit).trim().replace(/\/+$/, "");
  }

  const region = config.region || "us-central1";
  const project =
    process.env.GCLOUD_PROJECT ||
    process.env.GCP_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    "truepay-72060";

  return `https://${region}-${project}.cloudfunctions.net/api`;
}

/**
 * Hosted page Paystack redirects to after checkout (no Flutter WebView required).
 *
 * @returns {string}
 */
function buildDefaultPaystackCallbackUrl() {
  return `${apiBaseUrl()}${PAYMENT_RETURN_PATH}`;
}

/**
 * @param {string} [explicit]
 * @returns {string|null}
 */
function resolvePaystackCallbackUrl(explicit = null) {
  if (explicit && String(explicit).trim()) {
    return String(explicit).trim();
  }
  if (process.env.PAYSTACK_CALLBACK_URL) {
    return process.env.PAYSTACK_CALLBACK_URL;
  }
  if (config.paystack.callbackUrl) {
    return config.paystack.callbackUrl;
  }
  return buildDefaultPaystackCallbackUrl();
}

/**
 * Deep link that opens the Flutter app after payment (external browser flow).
 *
 * @param {string} reference Paystack / funding order reference
 * @param {Object} [extra]
 * @param {string} [extra.status]
 * @returns {string}
 */
function buildAppReturnDeepLink(reference, extra = {}) {
  const base =
    process.env.C2B_APP_DEEP_LINK ||
    config.c2b?.appDeepLink ||
    DEFAULT_DEEP_LINK;

  const params = new URLSearchParams();
  if (reference) {
    params.set("reference", String(reference));
  }
  if (extra.status) {
    params.set("status", String(extra.status));
  }

  const query = params.toString();
  if (!query) {
    return base;
  }

  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}${query}`;
}

module.exports = {
  PAYMENT_RETURN_PATH,
  DEFAULT_DEEP_LINK,
  apiBaseUrl,
  buildDefaultPaystackCallbackUrl,
  resolvePaystackCallbackUrl,
  buildAppReturnDeepLink,
};
