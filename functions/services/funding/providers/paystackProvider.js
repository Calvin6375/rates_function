/**
 * @fileoverview Paystack Funding Provider adapter.
 * Paystack API communication only — no wallet or ledger logic.
 */

const crypto = require("crypto");
const axios = require("axios");
const config = require("../../../config");
const { createLogger } = require("../../../utils/paymentOpsLogger");
const { resolvePaystackCallbackUrl } = require("../fundingCallbackService");
const {
  FALLBACK_PAYSTACK_EMAIL,
  resolvePaystackCustomerEmail,
  isPaystackInvalidEmailError,
} = require("../../../utils/paystackEmail");
const {
  FUNDING_PROVIDERS,
  FUNDING_CURRENCY,
  C2B_PAYSTACK_CURRENCY,
  B2B_SELF_TOPUP_PRODUCT,
} = require("../../../utils/fundingTypes");

const PROVIDER_ID = FUNDING_PROVIDERS.paystack;
const PAYSTACK_CHARGE_CURRENCIES = Object.freeze([FUNDING_CURRENCY, C2B_PAYSTACK_CURRENCY]);
const logger = createLogger({ service: "paystackProvider", provider: PROVIDER_ID });

/**
 * @returns {string|null}
 */
function getSecretKey() {
  return process.env.PAYSTACK_SECRET_KEY || config.paystack.secretKey || null;
}

/**
 * @returns {string|null}
 */
function getWebhookSecret() {
  return process.env.PAYSTACK_WEBHOOK_SECRET ||
    config.paystack.webhookSecret ||
    getSecretKey();
}

/**
 * @returns {string|null}
 */
function getSplitCode() {
  return process.env.PAYSTACK_SPLIT_CODE || config.paystack.splitCode || null;
}

/**
 * @returns {string|null}
 */
function getB2bSplitCode() {
  return process.env.PAYSTACK_B2B_SPLIT_CODE ||
    config.paystack.b2bSplitCode ||
    getSplitCode();
}

/**
 * Resolve split code for a product. Tourist requires a split; B2B prefers B2B split
 * then tourist split; omits split when none configured for B2B.
 *
 * @param {string} [product]
 * @returns {{ splitCode: string|null, required: boolean }}
 */
function resolveSplitForProduct(product) {
  const normalized = String(product || "tourist").toLowerCase();
  if (normalized === B2B_SELF_TOPUP_PRODUCT || normalized === "b2b") {
    return { splitCode: getB2bSplitCode(), required: false };
  }
  return { splitCode: getSplitCode(), required: true };
}

/**
 * @returns {boolean}
 */
function isConfigured() {
  return !!getSecretKey();
}

/**
 * @param {import("axios").AxiosError} err
 * @returns {string}
 */
function formatPaystackError(err) {
  const status = err.response?.status;
  const body = err.response?.data;
  const message = body?.message || err.message;
  if (status && message) {
    return `Paystack ${status}: ${message}`;
  }
  return message;
}

/**
 * @param {number} amount Major units (e.g. 100 USD or 200 KES)
 * @returns {number} Paystack amount in subunits (major × 100)
 */
function toPaystackAmount(amount) {
  return Math.round(Number(amount) * 100);
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
  const started = Date.now();
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
    correlationId = null,
    fundingOrderId = null,
    userId = null,
  } = params;

  const cur = String(currency).toUpperCase();
  if (!PAYSTACK_CHARGE_CURRENCIES.includes(cur)) {
    throw new Error(
        `Paystack funding supports ${PAYSTACK_CHARGE_CURRENCIES.join(", ")} only`,
    );
  }

  const reference = providerReference ||
    `tp_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;

  const resolvedCallbackUrl = resolvePaystackCallbackUrl(callbackUrl);
  const product = metadata.product || "tourist";
  const { splitCode, required: splitRequired } = resolveSplitForProduct(product);
  if (splitRequired && !splitCode) {
    throw new Error(
        "Paystack split is not configured (PAYSTACK_SPLIT_CODE). " +
        "Set the Transaction Split code from your Paystack dashboard (e.g. SPL_…).",
    );
  }

  const resolvedEmail = resolvePaystackCustomerEmail(email);
  if (resolvedEmail.corrected || resolvedEmail.usedFallback) {
    logger.warn("paystack.initialize.email_sanitized", {
      correlationId,
      fundingOrderId,
      userId,
      usedFallback: resolvedEmail.usedFallback,
      corrected: resolvedEmail.corrected,
    });
  }

  const payload = {
    email: resolvedEmail.email,
    amount: toPaystackAmount(amount),
    currency: cur,
    reference,
    metadata: {
      ...metadata,
      fundingOrderId: fundingOrderId || metadata.fundingOrderId || null,
      correlationId: correlationId || metadata.correlationId || null,
      userId: userId || metadata.userId || null,
      fundingProvider: PROVIDER_ID,
      product,
      environment: metadata.environment || process.env.GCLOUD_PROJECT || "local",
    },
  };

  if (resolvedCallbackUrl) {
    payload.callback_url = resolvedCallbackUrl;
  }

  if (splitCode) {
    payload.split_code = splitCode;
  }

  const postInitialize = async () => axios.post(
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

  const retryWithFallbackEmail = async (reason) => {
    if (payload.email === FALLBACK_PAYSTACK_EMAIL) {
      return false;
    }
    logger.warn("paystack.initialize.retry_fallback_email", {
      correlationId,
      fundingOrderId,
      userId,
      reason,
    });
    payload.email = FALLBACK_PAYSTACK_EMAIL;
    return true;
  };

  let response;
  try {
    response = await postInitialize();
  } catch (err) {
    const errorMessage = formatPaystackError(err);
    if (isPaystackInvalidEmailError(errorMessage) && await retryWithFallbackEmail(errorMessage)) {
      try {
        response = await postInitialize();
      } catch (retryErr) {
        const retryMessage = formatPaystackError(retryErr);
        logger.error("paystack.initialize.failed", {
          correlationId,
          fundingOrderId,
          providerReference: reference,
          provider: PROVIDER_ID,
          executionTimeMs: Date.now() - started,
          error: retryMessage,
          paystackStatus: retryErr.response?.status || null,
        });
        const wrapped = new Error(retryMessage);
        wrapped.cause = retryErr;
        throw wrapped;
      }
    } else {
      logger.error("paystack.initialize.failed", {
        correlationId,
        fundingOrderId,
        providerReference: reference,
        provider: PROVIDER_ID,
        executionTimeMs: Date.now() - started,
        error: errorMessage,
        paystackStatus: err.response?.status || null,
        paystackCode: err.response?.data?.code || null,
        splitCodeAttached: true,
      });
      const wrapped = new Error(errorMessage);
      wrapped.cause = err;
      throw wrapped;
    }
  }

  let body = response.data || {};
  if ((!body.status || !body.data) &&
      isPaystackInvalidEmailError(body.message) &&
      await retryWithFallbackEmail(body.message)) {
    response = await postInitialize();
    body = response.data || {};
  }
  if (!body.status || !body.data) {
    const message = body.message || "Paystack initialize failed";
    logger.error("paystack.initialize.rejected", {
      correlationId,
      fundingOrderId,
      providerReference: reference,
      provider: PROVIDER_ID,
      executionTimeMs: Date.now() - started,
      error: message,
    });
    throw new Error(message);
  }

  logger.info("paystack.initialize.success", {
    correlationId,
    fundingOrderId,
    providerReference: body.data.reference || reference,
    provider: PROVIDER_ID,
    executionTimeMs: Date.now() - started,
    splitCodeAttached: !!splitCode,
  });

  return {
    checkoutUrl: body.data.authorization_url,
    providerReference: body.data.reference || reference,
    providerTransactionId: body.data.access_code || null,
    raw: body.data,
  };
}

/**
 * @param {Object} transaction Paystack transaction object
 * @returns {import("../../../utils/fundingTypes").NormalizedFundingEvent}
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
    currency: String(transaction.currency || C2B_PAYSTACK_CURRENCY).toUpperCase(),
    status,
    failureReason: transaction.gateway_response || transaction.message || null,
  };
}

/**
 * @param {string} providerReference
 * @param {Object} [ctx]
 * @returns {Promise<import("../../../utils/fundingTypes").NormalizedFundingEvent>}
 */
async function verifyPayment(providerReference, ctx = {}) {
  const started = Date.now();
  const secretKey = getSecretKey();
  if (!secretKey) {
    throw new Error("Paystack is not configured (PAYSTACK_SECRET_KEY)");
  }

  let response;
  try {
    response = await axios.get(
        `${config.paystack.baseUrl}/transaction/verify/${encodeURIComponent(providerReference)}`,
        {
          headers: { Authorization: `Bearer ${secretKey}` },
          timeout: 15000,
        },
    );
  } catch (err) {
    logger.error("paystack.verify.failed", {
      correlationId: ctx.correlationId || null,
      fundingOrderId: ctx.fundingOrderId || null,
      providerReference,
      provider: PROVIDER_ID,
      executionTimeMs: Date.now() - started,
      error: err.message,
    });
    throw err;
  }

  const body = response.data || {};
  if (!body.status || !body.data) {
    const message = body.message || "Paystack verify failed";
    logger.error("paystack.verify.rejected", {
      correlationId: ctx.correlationId || null,
      fundingOrderId: ctx.fundingOrderId || null,
      providerReference,
      provider: PROVIDER_ID,
      executionTimeMs: Date.now() - started,
      error: message,
    });
    throw new Error(message);
  }

  logger.info("paystack.verify.success", {
    correlationId: ctx.correlationId || null,
    fundingOrderId: ctx.fundingOrderId || null,
    providerReference,
    provider: PROVIDER_ID,
    executionTimeMs: Date.now() - started,
    status: body.data.status,
  });

  return normalizePaystackTransaction(body.data);
}

/**
 * @param {Object} payload
 * @returns {import("../../../utils/fundingTypes").NormalizedFundingEvent|null}
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
  const webhookSecret = getWebhookSecret();
  if (!webhookSecret) {
    return false;
  }

  const signature = req.get("x-paystack-signature") || req.get("X-Paystack-Signature") || "";
  if (!signature) {
    return false;
  }

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ""));
  const hash = crypto.createHmac("sha512", webhookSecret).update(body).digest("hex");

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

const paystackProvider = {
  providerId: PROVIDER_ID,
  initializePayment,
  verifyPayment,
  normalizeWebhook,
  verifyWebhookSignature,
  isConfigured,
};

module.exports = paystackProvider;
