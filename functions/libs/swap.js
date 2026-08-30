/**
 * @fileoverview Swap (convert) currency and update balance books.
 *
 * Financial integrity:
 * - With quoteId: ONLY locked quote fields settle (client cannot change rate/amounts/currencies).
 * - Without quoteId: legacy USDT/USD/KES only; server resolves rate from KES book
 *   (client exchangeRate / toAmount are IGNORED).
 */

const admin = require("../admin");
const config = require("../config");
const {syncBalanceToRealtimeDatabase} = require("../utils/firestore");
const {assertSettleablePair} = require("../services/settlementCapabilityService");
const {
  quotesCol,
  markQuoteUsedInTransaction,
  assertQuoteUsableByUser,
} = require("../services/exchangeQuoteService");
const {resolveCustomerPair} = require("../utils/customerRatesResolve");
const {Decimal, quoteAmounts, roundAmount, toDecimal} = require("../utils/money");
const {computeSwapFeeBreakdown} = require("../services/swapFeeService");

const firestore = admin.firestore();

const SUPPORTED_CRYPTO = ["USDT"];
const SUPPORTED_FIAT = ["USD", "KES"];

/**
 * @param {Object} userData
 * @param {string} currency
 * @returns {Decimal}
 */
function getBalanceDecimal(userData, currency) {
  const u = userData || {};
  let raw = 0;
  switch (currency) {
    case "USDT":
      raw = u.usdtBalance ?? u.USDT ?? u.cryptoBalance ?? 0;
      break;
    case "USD":
      raw = u.usdBalance ?? u.USD ?? u.fiatBalance ?? 0;
      break;
    case "KES":
      raw = u.kesBalance ?? u.KES ?? 0;
      break;
    default:
      raw = 0;
  }
  const d = new Decimal(raw || 0);
  return d.isFinite() ? d : new Decimal(0);
}

/**
 * Load customer rates doc for server-side rate resolution.
 * @returns {Promise<{ rates: Object, rateVersion: number }>}
 */
async function loadCustomerRatesConfig() {
  const snap = await firestore.collection(config.collections.config).doc("customerRates").get();
  if (!snap.exists) {
    const err = new Error("MISSING_RATE: Customer rates not configured");
    err.code = "MISSING_RATE";
    throw err;
  }
  const data = snap.data() || {};
  return {
    rates: data.rates || {},
    rateVersion: Number(data.rateVersion) || 0,
  };
}

/**
 * Server-authoritative rate for legacy (no quoteId) settleable pairs.
 * Ignores any client-supplied exchangeRate.
 *
 * @param {string} fromCurrency
 * @param {string} toCurrency
 * @param {string|number} fromAmount
 * @returns {Promise<{ exchangeRate: string, toAmount: string, fromAmount: string, rateVersion: number, source: string }>}
 */
async function resolveAuthoritativeLegacyQuote(fromCurrency, toCurrency, fromAmount) {
  const {rates, rateVersion} = await loadCustomerRatesConfig();
  const resolved = resolveCustomerPair(rates, `${fromCurrency}/${toCurrency}`);
  if (!resolved) {
    const err = new Error(`MISSING_RATE: No rate for ${fromCurrency}→${toCurrency}`);
    err.code = "MISSING_RATE";
    throw err;
  }
  const amounts = quoteAmounts(fromAmount, fromCurrency, resolved.sellRate, toCurrency);
  return {
    exchangeRate: amounts.exchangeRate,
    toAmount: amounts.getAmount,
    fromAmount: amounts.sendAmount,
    rateVersion,
    source: resolved.source,
  };
}

/**
 * Create swap order and update user balances atomically.
 *
 * @param {string} userId
 * @param {Object} params
 * @param {string} [params.quoteId] preferred — locked quote
 * @param {string} [params.fromCurrency] legacy only
 * @param {string} [params.toCurrency] legacy only
 * @param {number} [params.fromAmount] legacy only
 * @param {number} [params.fee] IGNORED — never trusted
 * @param {number} [params.feeRate] IGNORED — never trusted
 * @param {number} [params.exchangeRate] IGNORED — never trusted
 * @param {number} [params.toAmount] IGNORED — never trusted
 */
async function createSwapOrder(userId, params) {
  const quoteId = params.quoteId || null;
  // Client fee / feeRate / exchangeRate / toAmount are NEVER used

  let fromCurrency;
  let toCurrency;
  let fromAmountStr;
  let toAmountStr;
  let exchangeRateStr;
  let feeAmountStr;
  let feeRateNum;
  let totalDebitStr;
  let feeConvention;
  let feeSource;
  let rateVersion = null;
  let rateSource = null;
  let lockedQuote = false;

  if (quoteId) {
    const pre = await quotesCol().doc(quoteId).get();
    if (!pre.exists) {
      const err = new Error("QUOTE_NOT_FOUND");
      err.code = "QUOTE_NOT_FOUND";
      throw err;
    }
    assertQuoteUsableByUser(pre.data(), userId);
    const q = pre.data();
    fromCurrency = String(q.sendCurrency).toUpperCase();
    toCurrency = String(q.getCurrency).toUpperCase();
    fromAmountStr = String(q.sendAmount);
    // Prefer net/gross Get locked on quote; fall back to getAmount alias
    toAmountStr = String(q.netGetAmount || q.grossGetAmount || q.getAmount);
    exchangeRateStr = String(q.exchangeRate);
    feeAmountStr = String(q.feeAmount != null ? q.feeAmount : "0");
    feeRateNum = Number(q.feeRate) || 0;
    totalDebitStr = String(q.totalDebit || q.sendAmount);
    feeConvention = q.feeConvention || "FEE_ON_SEND";
    feeSource = q.feeSource || "quote";
    rateVersion = q.rateVersion;
    rateSource = q.source;
    lockedQuote = true;
  } else {
    fromCurrency = String(params.fromCurrency || "").toUpperCase();
    toCurrency = String(params.toCurrency || "").toUpperCase();
    if (!fromCurrency || !toCurrency) {
      throw new Error("fromCurrency and toCurrency are required (or provide quoteId)");
    }
    if (params.fromAmount == null) {
      throw new Error("fromAmount must be a positive number");
    }
    assertSettleablePair(fromCurrency, toCurrency);
    const authQuote = await resolveAuthoritativeLegacyQuote(
        fromCurrency,
        toCurrency,
        params.fromAmount,
    );
    const breakdown = await computeSwapFeeBreakdown({
      sendAmount: authQuote.fromAmount,
      sendCurrency: fromCurrency,
      getCurrency: toCurrency,
      exchangeRate: authQuote.exchangeRate,
    });
    fromAmountStr = breakdown.sendAmount;
    toAmountStr = breakdown.netGetAmount;
    exchangeRateStr = breakdown.exchangeRate;
    feeAmountStr = breakdown.feeAmount;
    feeRateNum = breakdown.feeRate;
    totalDebitStr = breakdown.totalDebit;
    feeConvention = breakdown.feeConvention;
    feeSource = breakdown.feeSource;
    rateVersion = authQuote.rateVersion;
    rateSource = authQuote.source;
  }

  assertSettleablePair(fromCurrency, toCurrency);

  if (!SUPPORTED_CRYPTO.includes(fromCurrency) && !SUPPORTED_FIAT.includes(fromCurrency)) {
    throw new Error(`Unsupported fromCurrency: ${fromCurrency}`);
  }
  if (!SUPPORTED_CRYPTO.includes(toCurrency) && !SUPPORTED_FIAT.includes(toCurrency)) {
    throw new Error(`Unsupported toCurrency: ${toCurrency}`);
  }
  if (fromCurrency === toCurrency) {
    throw new Error("fromCurrency and toCurrency must be different");
  }

  const fromAmountDec = toDecimal(fromAmountStr);
  const toAmountDec = toDecimal(toAmountStr);
  const rateDec = toDecimal(exchangeRateStr);
  const feeAmountDec = new Decimal(feeAmountStr || 0);
  const totalDebitDec = totalDebitStr ?
    toDecimal(totalDebitStr) :
    fromAmountDec.plus(feeAmountDec);

  const fromAmountNum = Number(roundAmount(fromAmountDec, fromCurrency));
  const toAmountNum = Number(roundAmount(toAmountDec, toCurrency));
  const feeAmountNum = Number(roundAmount(feeAmountDec, fromCurrency));
  const rateNum = Number(rateDec.toFixed());

  const userRef = firestore.collection(config.collections.users).doc(userId);
  const ordersCol = firestore.collection(config.collections.orders);

  const result = await firestore.runTransaction(async (transaction) => {
    let quoteRef = null;
    if (quoteId) {
      quoteRef = quotesCol().doc(quoteId);
      const qSnap = await transaction.get(quoteRef);
      if (!qSnap.exists) {
        const err = new Error("QUOTE_NOT_FOUND");
        err.code = "QUOTE_NOT_FOUND";
        throw err;
      }
      // Re-validate inside txn (race / ownership / expiry)
      assertQuoteUsableByUser(qSnap.data(), userId);
      const q = qSnap.data();
      // Re-bind locked financials from txn read (immutable quote doc)
      if (String(q.sendCurrency).toUpperCase() !== fromCurrency ||
          String(q.getCurrency).toUpperCase() !== toCurrency) {
        const err = new Error("UNAUTHORIZED_QUOTE: quote currencies mismatch");
        err.code = "UNAUTHORIZED_QUOTE";
        throw err;
      }
    }

    const userDoc = await transaction.get(userRef);
    if (!userDoc.exists) {
      throw new Error(`User ${userId} not found`);
    }
    const userData = userDoc.data();

    const fromBalance = getBalanceDecimal(userData, fromCurrency);
    if (fromBalance.lt(totalDebitDec)) {
      throw new Error(
          `Insufficient ${fromCurrency} balance. Current: ${fromBalance.toFixed()}, ` +
          `required: ${roundAmount(totalDebitDec, fromCurrency)}`,
      );
    }

    let currentUsd = getBalanceDecimal(userData, "USD");
    let currentKes = getBalanceDecimal(userData, "KES");
    let currentUsdt = getBalanceDecimal(userData, "USDT");
    let currentFiat = new Decimal(userData.fiatBalance || 0);
    let currentCrypto = new Decimal(userData.cryptoBalance || 0);
    let currentMaster = new Decimal(userData.balance || 0);
    if (!currentFiat.isFinite()) currentFiat = new Decimal(0);
    if (!currentCrypto.isFinite()) currentCrypto = new Decimal(0);
    if (!currentMaster.isFinite()) currentMaster = new Decimal(0);

    let newUsd = currentUsd;
    let newKes = currentKes;
    let newUsdt = currentUsdt;
    let newFiat = currentFiat;
    let newCrypto = currentCrypto;
    let newMaster = currentMaster;

    if (fromCurrency === "USDT") {
      newUsdt = currentUsdt.minus(totalDebitDec);
      newCrypto = currentCrypto.minus(totalDebitDec);
      newMaster = currentMaster.minus(totalDebitDec);
    } else if (fromCurrency === "USD") {
      newUsd = currentUsd.minus(totalDebitDec);
      newFiat = currentFiat.minus(totalDebitDec);
      newMaster = currentMaster.minus(totalDebitDec);
    } else if (fromCurrency === "KES") {
      newKes = currentKes.minus(totalDebitDec);
      newMaster = currentMaster.minus(totalDebitDec);
    }

    if (toCurrency === "USDT") {
      newUsdt = newUsdt.plus(toAmountDec);
      newCrypto = newCrypto.plus(toAmountDec);
      newMaster = newMaster.plus(toAmountDec);
    } else if (toCurrency === "USD") {
      newUsd = newUsd.plus(toAmountDec);
      newFiat = newFiat.plus(toAmountDec);
      newMaster = newMaster.plus(toAmountDec);
    } else if (toCurrency === "KES") {
      newKes = newKes.plus(toAmountDec);
      newMaster = newMaster.plus(toAmountDec);
    }

    const newUsdN = Number(roundAmount(newUsd, "USD"));
    const newKesN = Number(roundAmount(newKes, "KES"));
    const newUsdtN = Number(roundAmount(newUsdt, "USDT"));
    const newFiatN = Number(roundAmount(newFiat, "USD"));
    const newCryptoN = Number(roundAmount(newCrypto, "USDT"));
    const newMasterN = Number(roundAmount(newMaster, fromCurrency));

    transaction.update(userRef, {
      balance: newMasterN,
      fiatBalance: newFiatN,
      cryptoBalance: newCryptoN,
      usdBalance: newUsdN,
      USD: newUsdN,
      kesBalance: newKesN,
      KES: newKesN,
      usdtBalance: newUsdtN,
      USDT: newUsdtN,
      wallets: {USD: newUsdN, KES: newKesN, USDT: newUsdtN},
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const orderId = ordersCol.doc().id;
    const orderRef = ordersCol.doc(orderId);
    transaction.set(orderRef, {
      userId,
      orderType: "swap",
      status: "completed",
      fromCurrency,
      toCurrency,
      fromAmount: fromAmountNum,
      toAmount: toAmountNum,
      grossGetAmount: toAmountNum,
      netGetAmount: toAmountNum,
      fee: feeAmountNum,
      feeRate: feeRateNum,
      feeCurrency: fromCurrency,
      feeConvention: feeConvention || "FEE_ON_SEND",
      feeSource: feeSource || "server",
      totalDebit: Number(roundAmount(totalDebitDec, fromCurrency)),
      exchangeRate: rateNum,
      quoteId: quoteId || null,
      rateVersion,
      rateSource,
      metadata: {
        createdAt: new Date().toISOString(),
        lockedQuote,
        clientFinancialsIgnored: true,
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (quoteRef) {
      markQuoteUsedInTransaction(transaction, quoteRef, orderId);
    }

    const transactionsCol = config.collections.transactions || "transactions";
    const userTxRef = firestore.collection(transactionsCol).doc(userId);
    const txId = "tx_" + orderId;
    const txRef = userTxRef.collection("transactions").doc(txId);
    transaction.set(userTxRef, {updatedAt: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
    transaction.set(txRef, {
      type: "swap",
      amount: fromAmountNum,
      status: "completed",
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      previousBalance: Number(roundAmount(currentMaster, fromCurrency)),
      newBalance: newMasterN,
      currency: fromCurrency,
      metadata: {
        orderId,
        fromCurrency,
        toCurrency,
        toAmount: toAmountNum,
        fee: feeAmountNum,
        exchangeRate: rateNum,
        quoteId: quoteId || null,
        rateVersion,
        lockedQuote,
      },
      userId,
    });

    return {
      orderId,
      fromAmount: fromAmountNum,
      toAmount: toAmountNum,
      fee: feeAmountNum,
      exchangeRate: rateNum,
      quoteId: quoteId || null,
      rateVersion,
      newBalances: {
        USD: newUsdN,
        KES: newKesN,
        USDT: newUsdtN,
        balance: newMasterN,
      },
    };
  });

  try {
    await syncBalanceToRealtimeDatabase(userId, toCurrency);
  } catch (syncErr) {
    console.warn("⚠️ Failed to sync balance to Realtime DB after swap:", syncErr.message);
  }

  // Align fiatLedger with users.*Balance so Safari Card / settlements can spend swapped KES/USD.
  try {
    const walletService = require("../services/walletService");
    for (const ccy of [fromCurrency, toCurrency]) {
      if (walletService.FIAT_LEDGER_ASSETS.has(String(ccy || "").toUpperCase())) {
        await walletService.syncFiatLedgerFromUserProjection(userId, ccy);
      }
    }
  } catch (ledgerSyncErr) {
    console.warn("⚠️ Failed to sync fiat ledger after swap:", ledgerSyncErr.message);
  }

  return {
    success: true,
    orderId: result.orderId,
    fromAmount: result.fromAmount,
    toAmount: result.toAmount,
    grossGetAmount: result.toAmount,
    netGetAmount: result.toAmount,
    fee: result.fee,
    feeRate: feeRateNum,
    feeCurrency: fromCurrency,
    feeConvention: feeConvention || "FEE_ON_SEND",
    exchangeRate: result.exchangeRate,
    quoteId: result.quoteId,
    rateVersion: result.rateVersion,
    newBalances: result.newBalances,
  };
}

module.exports = {
  createSwapOrder,
  resolveAuthoritativeLegacyQuote,
  loadCustomerRatesConfig,
};
