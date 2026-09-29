/**
 * @fileoverview Lightspark Grid funding provider adapter.
 * Normalizes Grid customers, internal accounts, and incoming payments into
 * the TruePay funding model. No ledger writes.
 */

const crypto = require("crypto");
const config = require("../../../config");
const gridApi = require("./gridApi");
const gridAccountService = require("../gridAccountService");
const { FALLBACK_PAYSTACK_EMAIL } = require("../../../utils/paystackEmail");
const { FUNDING_PROVIDERS, FUNDING_CURRENCY } = require("../../../utils/fundingTypes");
const { createLogger } = require("../../../utils/paymentOpsLogger");

const PROVIDER_ID = FUNDING_PROVIDERS.grid;
const logger = createLogger({ service: "gridProvider", provider: PROVIDER_ID });

const SUCCESS_STATUSES = new Set(["COMPLETED"]);
const FAILED_STATUSES = new Set(["FAILED", "REJECTED", "EXPIRED", "REFUNDED"]);

/**
 * @param {number} amountMinor
 * @param {number} [decimals]
 * @returns {number}
 */
function minorToMajor(amountMinor, decimals = 2) {
  const places = Number.isInteger(decimals) ? decimals : 2;
  return Number(amountMinor) / (10 ** places);
}

/**
 * @param {number} amountMajor
 * @param {number} [decimals]
 * @returns {number}
 */
function majorToMinor(amountMajor, decimals = 2) {
  const places = Number.isInteger(decimals) ? decimals : 2;
  return Math.round(Number(amountMajor) * (10 ** places));
}

/**
 * @param {Object|null|undefined} amount
 * @returns {{ amount: number, currency: string }}
 */
function readCurrencyAmount(amount) {
  const currency = amount?.currency?.code ? String(amount.currency.code).toUpperCase() : "";
  const decimals = Number.isInteger(amount?.currency?.decimals) ? amount.currency.decimals : 2;
  return {
    amount: minorToMajor(amount?.amount, decimals),
    currency,
  };
}

/**
 * @param {string} gridStatus
 * @returns {"success"|"failed"|"pending"}
 */
function mapStatus(gridStatus) {
  const status = String(gridStatus || "").toUpperCase();
  if (SUCCESS_STATUSES.has(status)) return "success";
  if (FAILED_STATUSES.has(status)) return "failed";
  return "pending";
}

/**
 * @returns {string|null}
 */
function webhookPublicKey() {
  const raw = process.env.GRID_WEBHOOK_PUBLIC_KEY || config.grid.webhookPublicKey || "";
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  return trimmed.replace(/\\n/g, "\n");
}

/**
 * @param {string} header
 * @returns {Buffer|null}
 */
function decodeSignatureHeader(header) {
  const value = String(header || "").trim();
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed && parsed.s) {
      return Buffer.from(String(parsed.s), "base64");
    }
  } catch (err) {
    void err;
  }
  try {
    return Buffer.from(value, "base64");
  } catch (err) {
    void err;
    return null;
  }
}

/**
 * @param {Object} transaction Grid transaction
 * @param {string} [providerReference]
 * @returns {Object}
 */
function normalizeTransaction(transaction, providerReference = "") {
  const money = readCurrencyAmount(transaction.receivedAmount || transaction.sentAmount);
  const destination = transaction.destination && typeof transaction.destination === "object" ?
    transaction.destination :
    {};
  return {
    provider: PROVIDER_ID,
    providerReference: providerReference || "",
    providerTransactionId: String(transaction.id || ""),
    amount: money.amount,
    currency: money.currency || FUNDING_CURRENCY,
    status: mapStatus(transaction.status),
    failureReason: transaction.failureReason ? String(transaction.failureReason) : null,
    customerId: transaction.customerId ? String(transaction.customerId) : null,
    platformCustomerId: transaction.platformCustomerId ? String(transaction.platformCustomerId) : null,
    destinationAccountId: destination.accountId ? String(destination.accountId) : null,
  };
}

/**
 * @param {Object} params
 * @returns {Promise<Object>}
 */
async function initializePayment(params) {
  const currency = String(params.currency || "").toUpperCase();
  if (currency !== FUNDING_CURRENCY) {
    throw new gridApi.GridApiError("Grid funding supports USD only");
  }
  const email = params.email && params.email !== FALLBACK_PAYSTACK_EMAIL ? params.email : null;
  const fullName = gridAccountService.joinGridFullName({
    fullName: params.fullName,
    firstName: params.firstName,
    lastName: params.lastName,
  });
  const prepared = await gridAccountService.prepareUsdFunding({
    userId: params.userId,
    email,
    fullName,
    clientIp: params.clientIp || null,
    fundingOrderId: params.fundingOrderId || null,
    correlationId: params.correlationId || null,
  });
  logger.info("grid.initialize.success", {
    correlationId: params.correlationId || null,
    fundingOrderId: params.fundingOrderId || null,
    userId: params.userId || null,
    provider: PROVIDER_ID,
    gridCustomerId: prepared.customerId,
    gridInternalAccountId: prepared.internalAccountId,
    status: "pending",
  });
  return {
    checkoutUrl: null,
    providerReference: params.providerReference || params.fundingOrderId,
    providerTransactionId: null,
    raw: prepared,
  };
}

/**
 * Authoritative read of a Grid transaction. Does not credit a wallet.
 * @param {string} providerReference
 * @param {Object} [ctx]
 * @returns {Promise<Object>}
 */
async function verifyPayment(providerReference, ctx = {}) {
  const transactionId = ctx.providerTransactionId ||
    (String(providerReference || "").startsWith("Transaction:") ? providerReference : "");
  if (!transactionId) {
    return {
      provider: PROVIDER_ID,
      providerReference: providerReference || "",
      providerTransactionId: "",
      amount: 0,
      currency: FUNDING_CURRENCY,
      status: "pending",
      failureReason: null,
    };
  }

  const transaction = await gridApi.getTransaction(transactionId, {
    correlationId: ctx.correlationId || null,
    fundingOrderId: ctx.fundingOrderId || null,
  });
  const normalized = normalizeTransaction(transaction, providerReference);
  if (normalized.currency && normalized.currency !== FUNDING_CURRENCY && normalized.status === "success") {
    logger.error("grid.verify.currency_mismatch", {
      correlationId: ctx.correlationId || null,
      fundingOrderId: ctx.fundingOrderId || null,
      gridPaymentId: transactionId,
      currency: normalized.currency,
      status: normalized.status,
    });
    return {
      ...normalized,
      status: "pending",
      failureReason: "Payment currency mismatch",
    };
  }
  logger.info("grid.verify.success", {
    correlationId: ctx.correlationId || null,
    fundingOrderId: ctx.fundingOrderId || null,
    provider: PROVIDER_ID,
    gridPaymentId: transactionId,
    status: normalized.status,
  });
  return normalized;
}

/**
 * @param {Object} payload
 * @returns {Object|null}
 */
function normalizeWebhook(payload) {
  const type = String(payload?.type || "");
  if (!type.startsWith("INCOMING_PAYMENT.")) {
    return null;
  }
  const data = payload.data && typeof payload.data === "object" ? payload.data : null;
  if (!data || !data.id) {
    return null;
  }
  const normalized = normalizeTransaction(data, "");
  normalized.webhookEventId = payload.id ? String(payload.id) : "";
  normalized.webhookType = type;
  return normalized;
}

/**
 * Verify X-Grid-Signature against the Grid webhook public key.
 * Header is base64, or JSON {"v":"1","s":"<base64>"} per Grid docs.
 *
 * @param {import("express").Request} req
 * @param {Buffer|string} rawBody
 * @returns {boolean}
 */
function verifyWebhookSignature(req, rawBody) {
  const publicKey = webhookPublicKey();
  if (!publicKey) {
    return false;
  }
  const header = req.get("X-Grid-Signature") || req.get("x-grid-signature") || "";
  const signature = decodeSignatureHeader(header);
  if (!signature || signature.length === 0) {
    return false;
  }
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ""));
  try {
    const verifier = crypto.createVerify("SHA256");
    verifier.update(body);
    verifier.end();
    return verifier.verify(
        { key: publicKey, format: "pem", type: "spki" },
        signature,
    );
  } catch (err) {
    logger.error("grid.webhook.signature_error", { error: err.message });
    return false;
  }
}

/**
 * @param {Object} params
 * @returns {Promise<Object>}
 */
function createCustomer(params, ctx = {}) {
  const body = {
    customerType: "INDIVIDUAL",
    platformCustomerId: String(params.platformCustomerId || params.userId),
    currencies: ["USD"],
  };
  if (params.email) body.email = params.email;
  if (params.fullName) body.fullName = params.fullName;
  if (params.region) body.region = params.region;
  return gridApi.createCustomer(body, ctx);
}

/**
 * @param {string} customerId
 * @returns {Promise<Object>}
 */
function getCustomer(customerId, ctx = {}) {
  return gridApi.getCustomer(customerId, ctx);
}

/**
 * RULE_BASED account create. Not used by the C2B USD reuse path.
 * @param {Object} body
 * @param {string} [idempotencyKey]
 * @returns {Promise<Object>}
 */
function createInternalAccount(body, idempotencyKey, ctx = {}) {
  return gridApi.createInternalAccount(body, idempotencyKey, ctx);
}

/**
 * @param {{ customerId: string, currency?: string, type?: string }} query
 * @returns {Promise<Object>}
 */
function getCustomerInternalAccounts(query, ctx = {}) {
  return gridApi.listCustomerInternalAccounts(query, ctx);
}

/**
 * @param {Object} account
 * @returns {Object}
 */
function getFundingInstructions(account) {
  const instructions = gridAccountService.pickUsdFundingInstructions(account);
  if (!instructions) {
    throw new gridApi.GridApiError("Grid USD internal account is missing funding instructions");
  }
  return instructions;
}

/**
 * @param {Object} body
 * @param {string} [idempotencyKey]
 * @returns {Promise<Object>}
 */
function createTransferIn(body, idempotencyKey, ctx = {}) {
  return gridApi.createTransferIn(body, idempotencyKey, ctx);
}

/**
 * @param {string} transactionId
 * @returns {Promise<Object>}
 */
async function getTransferStatus(transactionId, ctx = {}) {
  const transaction = await gridApi.getTransaction(transactionId, ctx);
  return normalizeTransaction(transaction, "");
}

/**
 * Sandbox-only. Does not credit the TruePay ledger.
 * @param {string} accountId
 * @param {number} amountMajor USD major units
 * @param {Object} [ctx]
 * @returns {Promise<Object>}
 */
async function sandboxFundInternalAccount(accountId, amountMajor, ctx = {}) {
  if (!gridApi.isSandbox()) {
    throw new gridApi.GridApiError("Grid sandbox funding is disabled (GRID_ENVIRONMENT must be sandbox)");
  }
  const amountMinor = majorToMinor(amountMajor, 2);
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
    throw new gridApi.GridApiError("Grid sandbox fund amount must be positive");
  }
  logger.info("grid.sandbox.fund", {
    correlationId: ctx.correlationId || null,
    fundingOrderId: ctx.fundingOrderId || null,
    userId: ctx.userId || null,
    gridInternalAccountId: accountId,
    provider: PROVIDER_ID,
    status: "pending",
  });
  return gridApi.sandboxFundInternalAccount(accountId, amountMinor, ctx);
}

const gridProvider = {
  providerId: PROVIDER_ID,
  initializePayment,
  verifyPayment,
  normalizeWebhook,
  verifyWebhookSignature,
  createCustomer,
  getCustomer,
  createInternalAccount,
  getCustomerInternalAccounts,
  getFundingInstructions,
  createTransferIn,
  getTransferStatus,
  sandboxFundInternalAccount,
  minorToMajor,
  majorToMinor,
};

module.exports = gridProvider;
