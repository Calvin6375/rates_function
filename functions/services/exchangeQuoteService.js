/**
 * @fileoverview Locked Exchange quotes — settlement must use quoteId, not live re-price.
 *
 * Quotes are server-created and immutable. Settlement requires:
 *   authenticated userId === quote.userId
 *   status === open, not expired, settleable
 *   single-use (atomic status flip in swap transaction)
 *
 * Financial fields locked on the quote (client cannot override):
 *   sendAmount, exchangeRate, grossGetAmount, netGetAmount,
 *   feeRate, feeAmount, feeCurrency, totalDebit, rateVersion
 */

const admin = require("../admin");
const config = require("../config");
const {
  resolveCustomerPair,
  BASE_CURRENCY,
  RATE_MEANING,
} = require("../utils/customerRatesResolve");
const {getPairCapabilities} = require("./settlementCapabilityService");
const {computeSwapFeeBreakdown} = require("./swapFeeService");

const firestore = admin.firestore();

const DEFAULT_TTL_MS = Number(process.env.EXCHANGE_QUOTE_TTL_MS || 5 * 60 * 1000);

/**
 * @returns {FirebaseFirestore.CollectionReference}
 */
function quotesCol() {
  const name = (config.collections && config.collections.exchangeQuotes) || "exchangeQuotes";
  return firestore.collection(name);
}

/**
 * Create a locked quote for Send→Get.
 * userId is required when the pair is settleable.
 *
 * @param {Object} params
 * @returns {Promise<Object>}
 */
async function createQuote(params) {
  const sendCurrency = String(params.sendCurrency || "").toUpperCase();
  const getCurrency = String(params.getCurrency || "").toUpperCase();
  const sendAmountIn = params.sendAmount;
  const userId = params.userId ? String(params.userId) : null;

  if (!sendCurrency || !getCurrency) {
    const err = new Error("INVALID_CURRENCY: send and get are required");
    err.code = "INVALID_CURRENCY";
    throw err;
  }
  if (sendCurrency === getCurrency) {
    const err = new Error("INVALID_CURRENCY: send and get must differ");
    err.code = "INVALID_CURRENCY";
    throw err;
  }

  const resolved = resolveCustomerPair(params.rates || {}, `${sendCurrency}/${getCurrency}`);
  if (!resolved) {
    const err = new Error(
        `MISSING_RATE: No KES price for ${sendCurrency} and/or ${getCurrency}`,
    );
    err.code = "MISSING_RATE";
    throw err;
  }

  const caps = getPairCapabilities(sendCurrency, getCurrency);
  if (caps.settleable && !userId) {
    const err = new Error(
        "UNAUTHORIZED_QUOTE: authenticated user required to create a settleable quote",
    );
    err.code = "UNAUTHORIZED_QUOTE";
    throw err;
  }

  const exchangeRate = resolved.sellRate;
  let breakdown;
  try {
    breakdown = await computeSwapFeeBreakdown({
      sendAmount: sendAmountIn,
      sendCurrency,
      getCurrency,
      exchangeRate,
    });
  } catch (e) {
    const err = new Error(`INVALID_AMOUNT: ${e.message}`);
    err.code = e.message && e.message.includes("INVALID_FEE") ? "INVALID_FEE_CONFIG" : "INVALID_AMOUNT";
    throw err;
  }

  const now = Date.now();
  const ttlMs = Number.isFinite(Number(params.ttlMs)) ? Number(params.ttlMs) : DEFAULT_TTL_MS;
  const quoteRef = quotesCol().doc();
  const quoteId = quoteRef.id;

  const quote = {
    quoteId,
    userId,
    sendCurrency,
    getCurrency,
    currencyPair: `${sendCurrency}/${getCurrency}`,
    sendAmount: breakdown.sendAmount,
    /** @deprecated alias of grossGetAmount — kept for older clients */
    getAmount: breakdown.grossGetAmount,
    grossGetAmount: breakdown.grossGetAmount,
    netGetAmount: breakdown.netGetAmount,
    exchangeRate: breakdown.exchangeRate,
    feeRate: breakdown.feeRate,
    feeAmount: breakdown.feeAmount,
    feeCurrency: breakdown.feeCurrency,
    totalDebit: breakdown.totalDebit,
    feeSource: breakdown.feeSource,
    feeConvention: breakdown.feeConvention,
    buyRate: resolved.buyRate,
    sellRate: resolved.sellRate,
    rateSide: "sell",
    source: resolved.source,
    numeraire: BASE_CURRENCY,
    rateMeaning: RATE_MEANING,
    rateUnit: `${getCurrency}_PER_${sendCurrency}`,
    quotable: caps.quotable,
    settleable: caps.settleable,
    rateVersion: Number(params.rateVersion) || 0,
    ratesUpdatedAt: params.ratesUpdatedAt || null,
    status: "open",
    createdAt: admin.firestore.Timestamp.fromMillis(now),
    expiresAt: admin.firestore.Timestamp.fromMillis(now + ttlMs),
    usedAt: null,
    orderId: null,
    immutable: true,
  };

  await quoteRef.set(quote);

  return {
    ...quote,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
}

/**
 * @param {Object} q
 * @param {string} userId
 */
function assertQuoteUsableByUser(q, userId) {
  if (!userId) {
    const err = new Error("UNAUTHORIZED_QUOTE: authentication required");
    err.code = "UNAUTHORIZED_QUOTE";
    throw err;
  }
  if (!q.userId || q.userId !== userId) {
    const err = new Error("UNAUTHORIZED_QUOTE: quote does not belong to this user");
    err.code = "UNAUTHORIZED_QUOTE";
    throw err;
  }
  if (q.status === "used" || (q.status && q.status !== "open")) {
    const err = new Error("QUOTE_ALREADY_USED");
    err.code = "QUOTE_ALREADY_USED";
    throw err;
  }
  const expiresMs = q.expiresAt?.toMillis?.() || 0;
  if (expiresMs && Date.now() > expiresMs) {
    const err = new Error("QUOTE_EXPIRED");
    err.code = "QUOTE_EXPIRED";
    throw err;
  }
  if (!q.settleable) {
    const err = new Error("PAIR_NOT_SETTLEABLE");
    err.code = "PAIR_NOT_SETTLEABLE";
    throw err;
  }
}

/**
 * @param {string} quoteId
 * @param {string} userId
 */
async function getOpenQuoteForSettlement(quoteId, userId) {
  if (!quoteId) {
    const err = new Error("INVALID_ARGUMENT: quoteId is required");
    err.code = "INVALID_ARGUMENT";
    throw err;
  }
  const snap = await quotesCol().doc(quoteId).get();
  if (!snap.exists) {
    const err = new Error("QUOTE_NOT_FOUND");
    err.code = "QUOTE_NOT_FOUND";
    throw err;
  }
  const q = snap.data();
  assertQuoteUsableByUser(q, userId);
  return {ref: snap.ref, data: q};
}

/**
 * @param {FirebaseFirestore.Transaction} transaction
 * @param {FirebaseFirestore.DocumentReference} quoteRef
 * @param {string} orderId
 */
function markQuoteUsedInTransaction(transaction, quoteRef, orderId) {
  transaction.update(quoteRef, {
    status: "used",
    usedAt: admin.firestore.FieldValue.serverTimestamp(),
    orderId,
  });
}

module.exports = {
  DEFAULT_TTL_MS,
  createQuote,
  getOpenQuoteForSettlement,
  assertQuoteUsableByUser,
  markQuoteUsedInTransaction,
  quotesCol,
};
