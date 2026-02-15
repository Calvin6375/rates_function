/**
 * @fileoverview Send money (P2P transfer) – create order and update both users' balances atomically
 */

const admin = require("../admin");
const config = require("../config");
const {syncBalanceToRealtimeDatabase} = require("../utils/firestore");
const {logTransaction} = require("../utils/transactions");

const firestore = admin.firestore();

const SUPPORTED_CURRENCIES = ["USD", "KES", "USDT"];

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
 * Build Firestore update object for a user after a balance change (single currency delta)
 * @param {Object} userData - Current user document data
 * @param {string} currency - Currency code
 * @param {number} amountDelta - Positive to add, negative to subtract
 * @returns {Object} Update data for transaction.update()
 */
function buildBalanceUpdate(userData, currency, amountDelta) {
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

  if (currency === "USDT") {
    newUsdt = currentUsdt + amountDelta;
    newCrypto = currentCrypto + amountDelta;
    newMaster = currentMaster + amountDelta;
  } else if (currency === "USD") {
    newUsd = currentUsd + amountDelta;
    newFiat = currentFiat + amountDelta;
    newMaster = currentMaster + amountDelta;
  } else if (currency === "KES") {
    newKes = currentKes + amountDelta;
    newMaster = currentMaster + amountDelta;
  }

  return {
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
}

/**
 * Resolve recipient user ID from recipientUserId or recipientPhoneNumber
 * @param {string} [recipientUserId] - Firebase UID of recipient
 * @param {string} [recipientPhoneNumber] - Phone number (with or without +)
 * @returns {Promise<string|null>} Resolved userId or null
 */
async function resolveRecipientUserId(recipientUserId, recipientPhoneNumber) {
  if (recipientUserId) {
    const doc = await firestore.collection(config.collections.users).doc(recipientUserId).get();
    return doc.exists ? recipientUserId : null;
  }
  if (!recipientPhoneNumber) return null;
  const normalized = String(recipientPhoneNumber).replace(/^\+/, "").trim();
  const snap = await firestore
      .collection(config.collections.users)
      .where("phoneNumber", "==", normalized)
      .limit(1)
      .get();
  if (!snap.empty) return snap.docs[0].id;
  const snapWithPlus = await firestore
      .collection(config.collections.users)
      .where("phoneNumber", "==", `+${normalized}`)
      .limit(1)
      .get();
  return snapWithPlus.empty ? null : snapWithPlus.docs[0].id;
}

/**
 * Create send-money order: debit sender, credit recipient, create order document (single transaction)
 *
 * @param {string} senderId - Authenticated user ID (sender)
 * @param {Object} params - Send money parameters
 * @param {string} [params.recipientUserId] - Firebase UID of recipient
 * @param {string} [params.recipientPhoneNumber] - Recipient phone (used if recipientUserId not set)
 * @param {number} params.amount - Amount to send (e.g. 1.0)
 * @param {string} params.currency - Currency code (USD, KES, USDT)
 * @param {string} [params.note] - Optional note/memo
 * @returns {Promise<{success: boolean, orderId: string, amount: number, currency: string, recipientUserId: string, senderNewBalances?: Object, recipientNewBalances?: Object}>}
 */
async function createSendMoneyOrder(senderId, params) {
  const {
    recipientUserId: recipientUserIdParam,
    recipientPhoneNumber,
    amount,
    currency,
    note,
  } = params;

  const amountNum = Number(amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    throw new Error("amount must be a positive number");
  }
  if (!currency || !SUPPORTED_CURRENCIES.includes(currency)) {
    throw new Error(`currency must be one of: ${SUPPORTED_CURRENCIES.join(", ")}`);
  }

  const recipientUserId = await resolveRecipientUserId(recipientUserIdParam, recipientPhoneNumber);
  if (!recipientUserId) {
    throw new Error("Recipient not found. Provide a valid recipientUserId or recipientPhoneNumber.");
  }
  if (recipientUserId === senderId) {
    throw new Error("Cannot send money to yourself");
  }

  const senderRef = firestore.collection(config.collections.users).doc(senderId);
  const recipientRef = firestore.collection(config.collections.users).doc(recipientUserId);
  const ordersCol = firestore.collection(config.collections.orders);

  const result = await firestore.runTransaction(async (transaction) => {
    const [senderDoc, recipientDoc] = await Promise.all([
      transaction.get(senderRef),
      transaction.get(recipientRef),
    ]);
    if (!senderDoc.exists) {
      throw new Error(`Sender ${senderId} not found`);
    }
    if (!recipientDoc.exists) {
      throw new Error(`Recipient ${recipientUserId} not found`);
    }

    const senderData = senderDoc.data();
    const recipientData = recipientDoc.data();
    const senderBalance = getBalanceForCurrency(senderData, currency);
    if (senderBalance < amountNum) {
      throw new Error(
        `Insufficient ${currency} balance. Current: ${senderBalance}, required: ${amountNum}`,
      );
    }

    const senderUpdate = buildBalanceUpdate(senderData, currency, -amountNum);
    const recipientUpdate = buildBalanceUpdate(recipientData, currency, amountNum);

    transaction.update(senderRef, senderUpdate);
    transaction.update(recipientRef, recipientUpdate);

    const orderId = ordersCol.doc().id;
    const orderRef = ordersCol.doc(orderId);
    transaction.set(orderRef, {
      userId: senderId,
      orderType: "send",
      status: "completed",
      recipientUserId,
      amount: amountNum,
      currency,
      note: note || null,
      metadata: {
        createdAt: new Date().toISOString(),
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      orderId,
      senderNewBalances: {
        USD: senderUpdate.usdBalance,
        KES: senderUpdate.kesBalance,
        USDT: senderUpdate.usdtBalance,
        balance: senderUpdate.balance,
      },
      recipientNewBalances: {
        USD: recipientUpdate.usdBalance,
        KES: recipientUpdate.kesBalance,
        USDT: recipientUpdate.usdtBalance,
        balance: recipientUpdate.balance,
      },
    };
  });

  try {
    await Promise.all([
      syncBalanceToRealtimeDatabase(senderId, currency),
      syncBalanceToRealtimeDatabase(recipientUserId, currency),
    ]);
  } catch (syncErr) {
    console.warn("⚠️ Failed to sync balances to Realtime DB after send money:", syncErr.message);
  }

  const senderPrevBalance = result.senderNewBalances.balance + amountNum;
  try {
    await logTransaction(
      senderId,
      "debit",
      amountNum,
      "completed",
      senderPrevBalance,
      result.senderNewBalances.balance,
      { currency, type: "send", recipientUserId, orderId: result.orderId },
    );
  } catch (logErr) {
    console.warn("⚠️ Failed to log sender transaction:", logErr.message);
  }
  try {
    await logTransaction(
      recipientUserId,
      "credit",
      amountNum,
      "completed",
      result.recipientNewBalances.balance - amountNum,
      result.recipientNewBalances.balance,
      { currency, type: "receive", senderUserId: senderId, orderId: result.orderId },
    );
  } catch (logErr) {
    console.warn("⚠️ Failed to log recipient transaction:", logErr.message);
  }

  console.log(`✅ Send money order created: ${result.orderId}`, {
    senderId,
    recipientUserId,
    amount: amountNum,
    currency,
  });

  return {
    success: true,
    orderId: result.orderId,
    amount: amountNum,
    currency,
    recipientUserId,
    senderNewBalances: result.senderNewBalances,
    recipientNewBalances: result.recipientNewBalances,
  };
}

module.exports = {
  createSendMoneyOrder,
  resolveRecipientUserId,
};
