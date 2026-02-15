/**
 * @fileoverview Swap (convert) currency and update balance books
 * Creates order in Firestore and updates user balances in a single transaction
 */

const admin = require("../admin");
const config = require("../config");
const {syncBalanceToRealtimeDatabase} = require("../utils/firestore");
const {logTransaction} = require("../utils/transactions");

const firestore = admin.firestore();

const SUPPORTED_CRYPTO = ["USDT"];
const SUPPORTED_FIAT = ["USD", "KES"];

/**
 * Get current balance for a currency from user data
 * @param {Object} userData - User document data
 * @param {string} currency - Currency code
 * @returns {number}
 */
function getBalanceForCurrency(userData, currency) {
  const u = userData || {};
  switch (currency) {
    case "USDT":
      return Number(u.usdtBalance ?? u.USDT ?? u.cryptoBalance ?? 0);
    case "USD":
      return Number(u.usdBalance ?? u.USD ?? u.fiatBalance ?? 0);
    case "KES":
      return Number(u.kesBalance ?? u.KES ?? 0);
    default:
      return 0;
  }
}

/**
 * Create swap order and update user balances atomically
 * Debits fromCurrency (e.g. USDT) and credits toCurrency (e.g. USD) at the given rate
 *
 * @param {string} userId - Authenticated user ID
 * @param {Object} params - Swap parameters
 * @param {string} params.fromCurrency - e.g. "USDT"
 * @param {string} params.toCurrency - e.g. "USD"
 * @param {number} params.fromAmount - Amount in fromCurrency (e.g. 6.0 USDT)
 * @param {number} [params.fee] - Fee in fromCurrency (e.g. 0.03). If omitted, feeAmount is 0
 * @param {number} [params.feeRate] - Fee rate (e.g. 0.005 for 0.5%). Ignored if fee is provided
 * @param {number} params.exchangeRate - Rate from fromCurrency to toCurrency (e.g. 1.01297)
 * @param {number} [params.toAmount] - Optional: exact toAmount. If provided, exchangeRate is only for record
 * @returns {Promise<{success: boolean, orderId: string, fromAmount: number, toAmount: number, fee: number, newBalances?: Object}>}
 */
async function createSwapOrder(userId, params) {
  const {
    fromCurrency,
    toCurrency,
    fromAmount,
    fee: feeParam,
    feeRate,
    exchangeRate,
    toAmount: toAmountParam,
  } = params;

  if (!fromCurrency || !toCurrency) {
    throw new Error("fromCurrency and toCurrency are required");
  }
  const fromAmountNum = Number(fromAmount);
  if (!Number.isFinite(fromAmountNum) || fromAmountNum <= 0) {
    throw new Error("fromAmount must be a positive number");
  }
  const rate = Number(exchangeRate);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error("exchangeRate must be a positive number");
  }

  const isFromCrypto = SUPPORTED_CRYPTO.includes(fromCurrency);
  const isToCrypto = SUPPORTED_CRYPTO.includes(toCurrency);
  if (!SUPPORTED_CRYPTO.includes(fromCurrency) && !SUPPORTED_FIAT.includes(fromCurrency)) {
    throw new Error(`Unsupported fromCurrency: ${fromCurrency}`);
  }
  if (!SUPPORTED_CRYPTO.includes(toCurrency) && !SUPPORTED_FIAT.includes(toCurrency)) {
    throw new Error(`Unsupported toCurrency: ${toCurrency}`);
  }
  if (fromCurrency === toCurrency) {
    throw new Error("fromCurrency and toCurrency must be different");
  }

  const feeAmount = Number.isFinite(Number(feeParam)) && feeParam >= 0
    ? Number(feeParam)
    : (Number.isFinite(Number(feeRate)) && feeRate >= 0 ? fromAmountNum * Number(feeRate) : 0);
  const totalDebit = fromAmountNum + feeAmount;
  const toAmount = Number.isFinite(Number(toAmountParam)) && toAmountParam >= 0
    ? Number(toAmountParam)
    : fromAmountNum * rate;

  const userRef = firestore.collection(config.collections.users).doc(userId);
  const ordersCol = firestore.collection(config.collections.orders);

  const result = await firestore.runTransaction(async (transaction) => {
    const userDoc = await transaction.get(userRef);
    if (!userDoc.exists) {
      throw new Error(`User ${userId} not found`);
    }
    const userData = userDoc.data();

    const fromBalance = getBalanceForCurrency(userData, fromCurrency);
    if (fromBalance < totalDebit) {
      throw new Error(
        `Insufficient ${fromCurrency} balance. Current: ${fromBalance}, required: ${totalDebit}`,
      );
    }

    const toBalance = getBalanceForCurrency(userData, toCurrency);
    const currentUsd = Number(userData.usdBalance ?? userData.USD ?? userData.fiatBalance ?? 0);
    const currentKes = Number(userData.kesBalance ?? userData.KES ?? 0);
    const currentUsdt = Number(userData.usdtBalance ?? userData.USDT ?? userData.cryptoBalance ?? 0);
    const currentFiat = Number(userData.fiatBalance ?? 0);
    const currentCrypto = Number(userData.cryptoBalance ?? 0);
    const currentMaster = Number(userData.balance ?? 0);

    let newUsd = currentUsd;
    let newKes = currentKes;
    let newUsdt = currentUsdt;
    let newFiat = currentFiat;
    let newCrypto = currentCrypto;
    let newMaster = currentMaster;

    if (fromCurrency === "USDT") {
      newUsdt = currentUsdt - totalDebit;
      newCrypto = currentCrypto - totalDebit;
      newMaster = currentMaster - totalDebit;
    } else if (fromCurrency === "USD") {
      newUsd = currentUsd - totalDebit;
      newFiat = currentFiat - totalDebit;
      newMaster = currentMaster - totalDebit;
    } else if (fromCurrency === "KES") {
      newKes = currentKes - totalDebit;
      newMaster = currentMaster - totalDebit;
    }

    if (toCurrency === "USDT") {
      newUsdt = newUsdt + toAmount;
      newCrypto = newCrypto + toAmount;
      newMaster = newMaster + toAmount;
    } else if (toCurrency === "USD") {
      newUsd = newUsd + toAmount;
      newFiat = newFiat + toAmount;
      newMaster = newMaster + toAmount;
    } else if (toCurrency === "KES") {
      newKes = newKes + toAmount;
      newMaster = newMaster + toAmount;
    }

    const updateData = {
      balance: newMaster,
      fiatBalance: newFiat,
      cryptoBalance: newCrypto,
      usdBalance: newUsd,
      USD: newUsd,
      kesBalance: newKes,
      KES: newKes,
      usdtBalance: newUsdt,
      USDT: newUsdt,
      wallets: {
        USD: newUsd,
        KES: newKes,
        USDT: newUsdt,
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    transaction.update(userRef, updateData);

    const orderId = ordersCol.doc().id;
    const orderRef = ordersCol.doc(orderId);
    const orderData = {
      userId,
      orderType: "swap",
      status: "completed",
      fromCurrency,
      toCurrency,
      fromAmount: fromAmountNum,
      toAmount,
      fee: feeAmount,
      exchangeRate: rate,
      metadata: {
        createdAt: new Date().toISOString(),
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    transaction.set(orderRef, orderData);

    return {
      orderId,
      fromAmount: fromAmountNum,
      toAmount,
      fee: feeAmount,
      newBalances: {
        USD: newUsd,
        KES: newKes,
        USDT: newUsdt,
        balance: newMaster,
      },
    };
  });

  try {
    await syncBalanceToRealtimeDatabase(userId, toCurrency);
  } catch (syncErr) {
    console.warn("⚠️ Failed to sync balance to Realtime DB after swap:", syncErr.message);
  }

  const previousMasterBalance = result.newBalances.balance + totalDebit - toAmount;
  try {
    await logTransaction(
      userId,
      "swap",
      fromAmountNum,
      "completed",
      previousMasterBalance,
      result.newBalances.balance,
      {
        orderId: result.orderId,
        fromCurrency,
        toCurrency,
        toAmount: result.toAmount,
        fee: result.fee,
        exchangeRate: rate,
      },
    );
  } catch (logErr) {
    console.warn("⚠️ Failed to log swap transaction:", logErr.message);
  }

  console.log(`✅ Swap order created: ${result.orderId}`, {
    userId,
    from: `${result.fromAmount} ${fromCurrency}`,
    to: `${result.toAmount} ${toCurrency}`,
    fee: result.fee,
  });

  return {
    success: true,
    orderId: result.orderId,
    fromAmount: result.fromAmount,
    toAmount: result.toAmount,
    fee: result.fee,
    newBalances: result.newBalances,
  };
}

module.exports = {
  createSwapOrder,
};
