/**
 * @fileoverview Crossmint Onramp adapter. Credits after GET Order verification.
 */

const crypto = require("crypto");
const { FUNDING_PROVIDERS, FUNDING_CURRENCY } = require("../../../utils/fundingTypes");
const { FALLBACK_PAYSTACK_EMAIL } = require("../../../utils/paystackEmail");
const { createLogger } = require("../../../utils/paymentOpsLogger");
const crossmintApi = require("./crossmintApi");

const PROVIDER_ID = FUNDING_PROVIDERS.crossmint;
const logger = createLogger({ service: "crossmintProvider", provider: PROVIDER_ID });

let linkedWalletKey = null;

/**
 * @param {string} amount
 * @returns {string}
 */
function fiatAmountString(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    throw new crossmintApi.CrossmintApiError("Crossmint amount must be a positive number");
  }
  return value.toFixed(2);
}

/**
 * @param {string} [email]
 * @returns {string}
 */
function requireReceiptEmail(email) {
  const value = email && String(email).trim();
  if (!value || value === FALLBACK_PAYSTACK_EMAIL) {
    throw new crossmintApi.CrossmintApiError("Crossmint requires a customer receipt email");
  }
  return value;
}

/**
 * @returns {Promise<void>}
 */
async function ensureCollectionWalletLinked(ctx = {}) {
  const address = crossmintApi.collectionWallet();
  const chain = crossmintApi.chain();
  const userLocator = crossmintApi.userLocator();
  const key = `${userLocator}|${chain}|${address}`.toLowerCase();
  if (linkedWalletKey === key) return;
  await crossmintApi.linkWallet({ userLocator, address, chain }, ctx);
  linkedWalletKey = key;
}

/**
 * @param {Object} order
 * @returns {{ amount: number, currency: string, walletAddress: string|null, txId: string|null }}
 */
function extractSettlement(order) {
  const line = Array.isArray(order?.lineItems) ? order.lineItems[0] : null;
  const executionAmount = line?.executionParams?.amount;
  const quoteAmount = line?.quote?.totalPrice?.amount || order?.quote?.totalPrice?.amount;
  const received = order?.payment?.received;
  const amount = Number(executionAmount || quoteAmount || received?.amount || 0);
  const currency = String(
      line?.quote?.totalPrice?.currency ||
      order?.quote?.totalPrice?.currency ||
      received?.currency ||
      "usd",
  ).toUpperCase();
  const walletAddress = line?.delivery?.recipient?.walletAddress || null;
  const txId = line?.delivery?.txId || received?.txId || null;
  return { amount, currency, walletAddress, txId, deliveryStatus: line?.delivery?.status || null };
}

/**
 * @param {Object} params
 * @returns {Promise<Object>}
 */
async function initializePayment(params) {
  const currency = String(params.currency || "").toUpperCase();
  if (currency !== FUNDING_CURRENCY) {
    throw new crossmintApi.CrossmintApiError("Crossmint funding supports USD only");
  }
  const receiptEmail = requireReceiptEmail(params.email);
  const amount = fiatAmountString(params.amount);
  const walletAddress = crossmintApi.collectionWallet();
  const tokenLocator = crossmintApi.tokenLocator();
  const chain = crossmintApi.chain();
  const ctx = {
    correlationId: params.correlationId || null,
    fundingOrderId: params.fundingOrderId || null,
    userId: params.userId || null,
  };

  await ensureCollectionWalletLinked(ctx);

  const created = await crossmintApi.createOrder({
    lineItems: [{
      tokenLocator,
      executionParameters: {
        mode: "exact-in",
        amount,
      },
    }],
    payment: {
      method: "card",
      receiptEmail,
    },
    recipient: {
      walletAddress,
    },
  }, ctx);

  const orderId = created?.order?.orderId || null;
  const clientSecret = created?.clientSecret || null;
  if (!orderId || !clientSecret) {
    throw new crossmintApi.CrossmintApiError("Crossmint order creation did not return orderId and clientSecret");
  }

  const checkoutUrl = crossmintApi.buildEmbeddedCheckoutUrl({
    orderId,
    clientSecret,
    receiptEmail,
  });

  logger.info("crossmint.initialize.success", {
    ...ctx,
    provider: PROVIDER_ID,
    crossmintOrderId: orderId,
    status: created?.order?.phase || "pending",
  });

  return {
    checkoutUrl,
    providerReference: String(orderId),
    providerTransactionId: String(orderId),
    raw: {
      orderId: String(orderId),
      clientSecret: String(clientSecret),
      collectionWallet: walletAddress,
      tokenLocator,
      chain,
      phase: created.order?.phase || null,
    },
  };
}

/**
 * GET Order is authoritative. Delivery completed is required before success.
 *
 * @param {string} providerReference
 * @param {Object} [ctx]
 * @returns {Promise<Object>}
 */
async function verifyPayment(providerReference, ctx = {}) {
  const orderId = String(ctx.providerTransactionId || providerReference || "");
  if (!orderId) {
    return {
      providerReference: "",
      providerTransactionId: "",
      amount: 0,
      currency: FUNDING_CURRENCY,
      status: "pending",
    };
  }

  const order = await crossmintApi.getOrder(orderId, {
    correlationId: ctx.correlationId || null,
    fundingOrderId: ctx.fundingOrderId || null,
    userId: ctx.userId || null,
  });
  const settlement = extractSettlement(order);
  const paymentStatus = String(order?.payment?.status || "").toLowerCase();
  const phase = String(order?.phase || "").toLowerCase();
  const deliveryStatus = String(settlement.deliveryStatus || "").toLowerCase();
  const expectedWallet = crossmintApi.collectionWallet().toLowerCase();
  const actualWallet = String(settlement.walletAddress || "").toLowerCase();

  if (paymentStatus === "failed-kyc" || deliveryStatus === "failed") {
    return {
      providerReference: orderId,
      providerTransactionId: orderId,
      amount: settlement.amount,
      currency: settlement.currency || FUNDING_CURRENCY,
      status: "failed",
      failureReason: order?.lineItems?.[0]?.delivery?.failureReason?.code || paymentStatus,
    };
  }

  const delivered = phase === "completed" &&
    paymentStatus === "completed" &&
    deliveryStatus === "completed";
  if (!delivered) {
    return {
      providerReference: orderId,
      providerTransactionId: orderId,
      amount: settlement.amount,
      currency: settlement.currency || FUNDING_CURRENCY,
      status: "pending",
    };
  }

  if (actualWallet && actualWallet !== expectedWallet) {
    logger.error("crossmint.verify.wallet_mismatch", {
      correlationId: ctx.correlationId || null,
      fundingOrderId: ctx.fundingOrderId || null,
      crossmintOrderId: orderId,
    });
    return {
      providerReference: orderId,
      providerTransactionId: orderId,
      amount: settlement.amount,
      currency: settlement.currency || FUNDING_CURRENCY,
      status: "pending",
      failureReason: "Payment destination mismatch",
    };
  }

  logger.info("crossmint.verify.success", {
    correlationId: ctx.correlationId || null,
    fundingOrderId: ctx.fundingOrderId || null,
    provider: PROVIDER_ID,
    crossmintOrderId: orderId,
    settlementTxId: settlement.txId,
    status: "success",
  });

  return {
    providerReference: orderId,
    providerTransactionId: orderId,
    amount: settlement.amount,
    currency: settlement.currency || FUNDING_CURRENCY,
    status: "success",
  };
}

/**
 * Checkout V3: { actionId, type, data }. Credit only on delivery.completed.
 *
 * @param {Object} payload
 * @returns {Object|null}
 */
function normalizeWebhook(payload) {
  const type = String(payload?.type || "");
  const actionId = payload?.actionId || payload?.data?.orderId;
  if (!actionId) return null;
  if (type === "orders.delivery.completed") {
    const settlement = extractSettlement(payload.data || {});
    return {
      providerReference: String(actionId),
      providerTransactionId: String(actionId),
      amount: settlement.amount,
      currency: settlement.currency || FUNDING_CURRENCY,
      status: "success",
    };
  }
  if (type === "orders.payment.failed" || type === "orders.delivery.failed") {
    const settlement = extractSettlement(payload.data || {});
    return {
      providerReference: String(actionId),
      providerTransactionId: String(actionId),
      amount: settlement.amount,
      currency: settlement.currency || FUNDING_CURRENCY,
      status: "failed",
      failureReason: payload?.data?.lineItems?.[0]?.delivery?.failureReason?.code || type,
    };
  }
  return null;
}

/**
 * Svix HMAC as documented by Crossmint (raw body, whsec_ secret).
 *
 * @param {import("express").Request} req
 * @param {Buffer|string} rawBody
 * @returns {boolean}
 */
function verifyWebhookSignature(req, rawBody) {
  const secret = crossmintApi.webhookSecret();
  if (!secret) return false;
  const svixId = req.get("svix-id");
  const svixTimestamp = req.get("svix-timestamp");
  const svixSignature = req.get("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  const ts = Number(svixTimestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
    return false;
  }

  const body = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || "");
  const signedContent = `${svixId}.${svixTimestamp}.${body}`;
  const secretPart = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let secretBytes;
  try {
    secretBytes = Buffer.from(secretPart, "base64");
  } catch (err) {
    void err;
    return false;
  }
  const expected = crypto.createHmac("sha256", secretBytes).update(signedContent).digest("base64");
  const candidates = String(svixSignature).split(" ").map((entry) => {
    const comma = entry.indexOf(",");
    return comma >= 0 ? entry.slice(comma + 1) : entry;
  });
  return candidates.some((candidate) => {
    const left = Buffer.from(candidate);
    const right = Buffer.from(expected);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  });
}

function resetLinkCacheForTests() {
  linkedWalletKey = null;
}

module.exports = {
  providerId: PROVIDER_ID,
  initializePayment,
  verifyPayment,
  normalizeWebhook,
  verifyWebhookSignature,
  extractSettlement,
  resetLinkCacheForTests,
};
