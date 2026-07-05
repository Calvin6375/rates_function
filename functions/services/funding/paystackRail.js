/**
 * @fileoverview Paystack Funding Provider adapter.
 * Implements the Funding Provider interface — all Paystack-specific logic stays here.
 */

const crypto = require("crypto");
const axios = require("axios");
const config = require("../../config");
const { FUNDING_PROVIDERS, FUNDING_CURRENCY } = require("../../utils/fundingTypes");

const PROVIDER_ID = FUNDING_PROVIDERS.paystack;

/**
 * @returns {string|null}
 */
function getSecretKey() {
  return process.env.PAYSTACK_SECRET_KEY || config.paystack.secretKey || null;
}

/**
 * @returns {boolean}
 */
function isConfigured() {
  return !!getSecretKey();
}

/**
 * @param {number} amountUsd Major units (e.g. 100 USD)
 * @returns {number} Paystack amount in cents/kobo (USD × 100)
 */
function toPaystackAmount(amountUsd) {
  return Math.round(Number(amountUsd) * 100);
}

/**
 * @param {number} paystackAmount
 * @returns {number}
 */
function fromPaystackAmount(paystackAmount) {
  return Number(paystackAmount) / 100;
}

/**
 * @param {Object} params
 * @returns {Promise<{ checkoutUrl: string, providerReference: string, providerTransactionId?: string, raw?: Object }>}
 */
async function initializePayment(params) {
  const secretKey = getSecretKey();
  if (!secretKey) {
    throw new Error("Paystack is not configured (PAYSTACK_SECRET_KEY)");
  }

  const {
    amount,
    currency = FUNDING_CURRENCY,
    email,
    metadata = {},
    providerReference,
    callbackUrl,
  } = params;

  const cur = String(currency).toUpperCase();
  if (cur !== FUNDING_CURRENCY) {
    throw new Error(`Paystack funding supports ${FUNDING_CURRENCY} only`);
  }

  const reference = providerReference || `tp_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;

  const payload = {
    email: email || "tourist@truepay.africa",
    amount: toPaystackAmount(amount),
    currency: FUNDING_CURRENCY,
    reference,
    metadata: {
      ...metadata,
      product: metadata.product || "tourist_payments",
    },
  };
  if (callbackUrl) {
    payload.callback_url = callbackUrl;
  }

  const response = await axios.post(
      `${config.paystack.baseUrl}/transaction/initialize`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      },
  );

  const body = response.data || {};
  if (!body.status || !body.data) {
    throw new Error(body.message || "Paystack initialize failed");
  }

  return {
    checkoutUrl: body.data.authorization_url,
    providerReference: body.data.reference || reference,
    providerTransactionId: body.data.access_code || null,
    raw: body.data,
  };
}

/**
 * @param {Object} transaction Paystack transaction object
 * @returns {import("../../utils/fundingTypes").NormalizedFundingEvent}
 */
function normalizePaystackTransaction(transaction) {
  const statusRaw = String(transaction.status || "").toLowerCase();
  let status = "pending";
  if (statusRaw === "success") {
    status = "success";
  } else if (statusRaw === "failed" || statusRaw === "abandoned" || statusRaw === "reversed") {
    status = "failed";
  }

  return {
    providerReference: String(transaction.reference || ""),
    providerTransactionId: String(transaction.id || transaction.reference || ""),
    amount: fromPaystackAmount(transaction.amount),
    currency: FUNDING_CURRENCY,
    status,
    failureReason: transaction.gateway_response || transaction.message || null,
  };
}

/**
 * @param {string} providerReference
 * @returns {Promise<import("../../utils/fundingTypes").NormalizedFundingEvent>}
 */
async function verifyPayment(providerReference) {
  const secretKey = getSecretKey();
  if (!secretKey) {
    throw new Error("Paystack is not configured (PAYSTACK_SECRET_KEY)");
  }

  const response = await axios.get(
      `${config.paystack.baseUrl}/transaction/verify/${encodeURIComponent(providerReference)}`,
      {
        headers: { Authorization: `Bearer ${secretKey}` },
        timeout: 15000,
      },
  );

  const body = response.data || {};
  if (!body.status || !body.data) {
    throw new Error(body.message || "Paystack verify failed");
  }

  return normalizePaystackTransaction(body.data);
}

/**
 * @param {Object} payload
 * @returns {import("../../utils/fundingTypes").NormalizedFundingEvent|null}
 */
function normalizeWebhook(payload) {
  const event = String(payload.event || "").toLowerCase();
  if (!event.startsWith("charge.")) {
    return null;
  }

  const data = payload.data || {};
  if (!data.reference) {
    return null;
  }

  return normalizePaystackTransaction(data);
}

/**
 * @param {import("express").Request} req
 * @param {Buffer|string} rawBody
 * @returns {boolean}
 */
function verifyWebhookSignature(req, rawBody) {
  const secretKey = getSecretKey();
  if (!secretKey) {
    return false;
  }

  const signature = req.get("x-paystack-signature") || req.get("X-Paystack-Signature") || "";
  if (!signature) {
    return false;
  }

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ""));
  const hash = crypto.createHmac("sha512", secretKey).update(body).digest("hex");

  try {
    const received = Buffer.from(signature, "hex");
    const computed = Buffer.from(hash, "hex");
    if (received.length !== computed.length) {
      return false;
    }
    return crypto.timingSafeEqual(received, computed);
  } catch (e) {
    return hash === signature;
  }
}

const paystackRail = {
  providerId: PROVIDER_ID,
  initializePayment,
  verifyPayment,
  normalizeWebhook,
  verifyWebhookSignature,
  isConfigured,
};

module.exports = paystackRail;
