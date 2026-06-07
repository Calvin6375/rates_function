/**
 * @fileoverview Append-only crypto ledger for Circle USDC balances.
 *
 * TRUTH MODEL (strict):
 * - Ledger (cryptoLedger)     = source of truth for settled balances
 * - Reservations              = pending liabilities (not yet in ledger)
 * - walletAggregates          = read cache derived from ledger only
 * - RTDB (via rtdbSyncService)= UI projection only — never read for math
 * - cryptoTransactions        = audit / UI log only — never used for balance math
 * - cryptoWallets             = wallet metadata only — no balance field
 *
 * RULES:
 * - Never compute balances from cryptoTransactions
 * - Never read RTDB for balances
 * - Never use cryptoWallets.balance
 * - appendTransaction is idempotent by referenceId (Circle transaction id)
 */

const admin = require("../../admin");
const { collection, serverTimestamp } = require("../../libs/firestore");
const rtdbSyncService = require("../sync/rtdbSyncService");

const WEBHOOK_REPLAY_MAX_MS = 72 * 60 * 60 * 1000;

/**
 * @param {string} referenceId
 * @returns {string}
 */
function ledgerDocId(referenceId) {
  return `cl_${referenceId}`;
}

/**
 * @param {string} referenceId
 * @returns {Promise<boolean>}
 */
async function hasLedgerEntry(referenceId) {
  const doc = await collection("cryptoLedger").doc(ledgerDocId(referenceId)).get();
  return doc.exists;
}

/**
 * Settled balance from ledger aggregate cache, rebuilt from ledger if missing.
 * Does NOT subtract reservations — use getAvailableBalance for spendable funds.
 * @param {string} userId
 * @param {string} asset
 * @returns {Promise<number>}
 */
async function getLedgerBalance(userId, asset) {
  const aggDoc = await collection("walletAggregates").doc(userId).get();
  if (aggDoc.exists && aggDoc.data()[asset] != null) {
    return Number(aggDoc.data()[asset] || 0);
  }
  return rebuildBalanceFromLedger(userId, asset);
}

/**
 * Spendable balance = ledger balance minus active reservations.
 * @param {string} userId
 * @param {string} asset
 * @returns {Promise<number>}
 */
async function getAvailableBalance(userId, asset) {
  const reservationService = require("./reservationService");
  if (asset !== "USDC") {
    return getLedgerBalance(userId, asset);
  }
  return reservationService.getAvailableBalance(userId);
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
  } = params;

  const numericAmount = Number(amount);
  if (!userId || !referenceId || !Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error("Invalid ledger append parameters");
  }
  if (direction !== "credit" && direction !== "debit") {
    throw new Error("Invalid ledger direction");
  }

  if (await hasLedgerEntry(referenceId)) {
    const agg = await collection("walletAggregates").doc(userId).get();
    return {
      entryId: ledgerDocId(referenceId),
      newBalance: agg.exists ? Number(agg.data()[asset] || 0) : 0,
      duplicate: true,
    };
  }

  const db = admin.firestore();
  const ledgerCol = collection("cryptoLedger");
  const entryRef = ledgerCol.doc(ledgerDocId(referenceId));
  const aggregateRef = collection("walletAggregates").doc(userId);

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
      throw new Error(`Insufficient ${asset} balance for ledger debit`);
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

  await syncAssetToRtdb(userId, asset, newBalance);
  return { entryId: entryRef.id, newBalance };
}

/**
 * Idempotent reconciliation adjustment when Circle on-chain balance drifts from ledger.
 * @param {Object} params
 * @returns {Promise<{ entryId: string, newBalance: number, duplicate?: boolean }>}
 */
async function appendReconciliationAdjustment(params) {
  const {
    userId,
    asset,
    amount,
    direction,
    referenceId,
  } = params;

  return appendTransaction({
    userId,
    type: "reconciliation_adjustment",
    asset,
    amount,
    direction,
    source: "reconciliation",
    referenceId,
  });
}

/**
 * @param {string} userId
 * @param {string} asset
 * @returns {Promise<number>}
 */
async function rebuildBalanceFromLedger(userId, asset) {
  const snap = await collection("cryptoLedger")
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

  await collection("walletAggregates").doc(userId).set({
    userId,
    [asset]: balance,
    updatedAt: serverTimestamp(),
  }, { merge: true });

  await syncAssetToRtdb(userId, asset, balance);
  return balance;
}

/**
 * @param {string} userId
 * @param {string} asset
 * @param {number} balance
 */
async function syncAssetToRtdb(userId, asset, balance) {
  await rtdbSyncService.syncToRTDB(userId, asset, balance);
}

/**
 * Reject stale webhook events outside the replay protection window.
 * @param {string|Date} eventTimestamp
 * @returns {boolean} true if event is too old
 */
function isWebhookEventStale(eventTimestamp) {
  if (!eventTimestamp) return false;
  const ts = new Date(eventTimestamp).getTime();
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts > WEBHOOK_REPLAY_MAX_MS;
}

/** @deprecated Use getLedgerBalance */
async function getBalance(userId, asset) {
  return getLedgerBalance(userId, asset);
}

module.exports = {
  WEBHOOK_REPLAY_MAX_MS,
  ledgerDocId,
  hasLedgerEntry,
  getLedgerBalance,
  getAvailableBalance,
  getBalance,
  appendTransaction,
  appendReconciliationAdjustment,
  rebuildBalanceFromLedger,
  syncAssetToRtdb,
  isWebhookEventStale,
};
