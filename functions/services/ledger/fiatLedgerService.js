/**
 * @fileoverview Append-only fiat ledger — mirror of crypto ledger architecture.
 *
 * TRUTH MODEL:
 * - fiatLedger           = source of truth for settled fiat balances
 * - pendingFiatReservations = pending liabilities (merchant settlement holds)
 * - walletAggregatesFiat = read cache derived from fiatLedger only
 * - users.{currency}Balance = dual-write projection for Flutter backward compat
 * - RTDB wallet/{uid}/fiat/{currency} = UI projection only
 */

const admin = require("../../admin");
const config = require("../../config");
const { collection, serverTimestamp } = require("../../libs/firestore");
const rtdbSyncService = require("../sync/rtdbSyncService");

const LEDGER_COL = config.collections.fiatLedger;
const AGGREGATE_COL = config.collections.walletAggregatesFiat;

/**
 * @param {string} referenceId
 * @returns {string}
 */
function ledgerDocId(referenceId) {
  return `fl_${referenceId}`;
}

/**
 * @param {string} referenceId
 * @returns {Promise<boolean>}
 */
async function hasLedgerEntry(referenceId) {
  const doc = await collection(LEDGER_COL).doc(ledgerDocId(referenceId)).get();
  return doc.exists;
}

/**
 * @param {string} userId
 * @param {string} asset
 * @returns {Promise<number>}
 */
async function getLedgerBalance(userId, asset) {
  const aggDoc = await collection(AGGREGATE_COL).doc(userId).get();
  if (aggDoc.exists && aggDoc.data()[asset] != null) {
    return Number(aggDoc.data()[asset] || 0);
  }
  return rebuildBalanceFromLedger(userId, asset);
}

/**
 * @param {string} userId
 * @param {string} asset
 * @returns {Promise<number>}
 */
async function getAvailableBalance(userId, asset) {
  const fiatReservationService = require("./fiatReservationService");
  const ledgerBalance = await getLedgerBalance(userId, asset);
  const reserved = await fiatReservationService.getReservedTotal(userId, asset);
  return Math.max(0, ledgerBalance - reserved);
}

/**
 * @param {Object} params
 * @returns {Promise<{ entryId: string, newBalance: number, duplicate?: boolean }>}
 */
async function appendTransaction(params) {
  const {
    userId,
    type,
    asset,
    amount,
    direction,
    source,
    referenceId,
    fundingOrderId = null,
    transactionRecordId = null,
    metadata = {},
  } = params;

  const numericAmount = Number(amount);
  if (!userId || !referenceId || !Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error("Invalid fiat ledger append parameters");
  }
  if (direction !== "credit" && direction !== "debit") {
    throw new Error("Invalid fiat ledger direction");
  }

  if (await hasLedgerEntry(referenceId)) {
    const agg = await collection(AGGREGATE_COL).doc(userId).get();
    return {
      entryId: ledgerDocId(referenceId),
      newBalance: agg.exists ? Number(agg.data()[asset] || 0) : 0,
      duplicate: true,
    };
  }

  const db = admin.firestore();
  const entryRef = collection(LEDGER_COL).doc(ledgerDocId(referenceId));
  const aggregateRef = collection(AGGREGATE_COL).doc(userId);

  let newBalance = 0;

  await db.runTransaction(async (tx) => {
    const entryDoc = await tx.get(entryRef);
    if (entryDoc.exists) {
      const aggDoc = await tx.get(aggregateRef);
      newBalance = aggDoc.exists ? Number(aggDoc.data()[asset] || 0) : 0;
      return;
    }

    const aggDoc = await tx.get(aggregateRef);
    const currentBalance = aggDoc.exists ? Number(aggDoc.data()[asset] || 0) : 0;
    const delta = direction === "credit" ? numericAmount : -numericAmount;
    newBalance = currentBalance + delta;

    if (newBalance < 0) {
      throw new Error(`Insufficient ${asset} balance for fiat ledger debit`);
    }

    tx.set(entryRef, {
      id: entryRef.id,
      userId,
      type,
      asset,
      amount: numericAmount,
      direction,
      source,
      referenceId,
      fundingOrderId,
      transactionRecordId,
      metadata: typeof metadata === "object" ? metadata : {},
      createdAt: serverTimestamp(),
    });

    tx.set(aggregateRef, {
      userId,
      [asset]: newBalance,
      updatedAt: serverTimestamp(),
    }, { merge: true });
  });

  const verify = await entryRef.get();
  if (!verify.exists) {
    const agg = await aggregateRef.get();
    return {
      entryId: entryRef.id,
      newBalance: agg.exists ? Number(agg.data()[asset] || 0) : 0,
      duplicate: true,
    };
  }

  await rtdbSyncService.syncFiatToRTDB(userId, asset, newBalance);
  return { entryId: entryRef.id, newBalance };
}

/**
 * @param {string} userId
 * @param {string} asset
 * @returns {Promise<number>}
 */
async function rebuildBalanceFromLedger(userId, asset) {
  const snap = await collection(LEDGER_COL)
      .where("userId", "==", userId)
      .where("asset", "==", asset)
      .get();

  let balance = 0;
  for (const doc of snap.docs) {
    const row = doc.data();
    const amt = Number(row.amount) || 0;
    if (row.direction === "credit") {
      balance += amt;
    } else if (row.direction === "debit") {
      balance -= amt;
    }
  }

  balance = Math.max(0, balance);

  await collection(AGGREGATE_COL).doc(userId).set({
    userId,
    [asset]: balance,
    updatedAt: serverTimestamp(),
  }, { merge: true });

  await rtdbSyncService.syncFiatToRTDB(userId, asset, balance);
  return balance;
}

module.exports = {
  ledgerDocId,
  hasLedgerEntry,
  getLedgerBalance,
  getAvailableBalance,
  appendTransaction,
  rebuildBalanceFromLedger,
};
