/**
 * @fileoverview Transaction engine: central system for all financial activity.
 * Creates unified transaction records and (optionally) ledger entries.
 * Backwards compatibility: continues to write to existing transactions/{userId}/transactions for consumer app.
 */

const config = require("../config");
const { collection, serverTimestamp } = require("../libs/firestore");
const { logTransaction, generateTransactionId } = require("../utils/transactions");
const ledgerService = require("./ledgerService");

/** Transaction types supported by the engine */
const TRANSACTION_TYPES = Object.freeze({
  topup: "topup",
  withdrawal: "withdrawal",
  crypto_onramp: "crypto_onramp",
  crypto_offramp: "crypto_offramp",
  b2b_payment: "b2b_payment",
  settlement: "settlement",
});

/** Transaction lifecycle statuses */
const STATUSES = Object.freeze({
  created: "created",
  pending: "pending",
  processing: "processing",
  completed: "completed",
  failed: "failed",
});

/**
 * Generate a unique transaction record ID
 * @returns {string}
 */
function generateTransactionRecordId() {
  return `txr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Create a transaction record in the unified transaction log (transactionRecords).
 * Optionally creates ledger entries and/or logs to legacy transactions/{userId}/transactions.
 *
 * @param {Object} params
 * @param {string} params.type - One of TRANSACTION_TYPES
 * @param {string} [params.userId] - Consumer user ID (for topup, swap, etc.)
 * @param {string} [params.partnerId] - Partner ID (for b2b_payment, settlement)
 * @param {number} params.amount - Amount
 * @param {string} params.currency - Currency code (USD, KES, USDT)
 * @param {string} [params.status='created'] - Initial status
 * @param {Object} [params.metadata] - Extra data (invoiceId, orderId, etc.)
 * @param {boolean} [params.createLedgerEntries=false] - If true, creates double-entry (requires debitAccount, creditAccount)
 * @param {string} [params.debitAccount] - For ledger (e.g. liquidity_pool)
 * @param {string} [params.creditAccount] - For ledger (e.g. user_wallet:uid)
 * @param {boolean} [params.logLegacy=true] - If true and userId present, also writes to transactions/{userId}/transactions
 * @returns {Promise<{ transactionId: string, legacyTxId?: string, ledgerEntryIds?: { debitEntryId: string, creditEntryId: string } }>}
 */
async function createTransactionRecord({
  type,
  userId = null,
  partnerId = null,
  amount,
  currency,
  status = STATUSES.created,
  metadata = {},
  createLedgerEntries = false,
  debitAccount = null,
  creditAccount = null,
  logLegacy = true,
}) {
  const transactionId = generateTransactionRecordId();
  const col = collection("transactionRecords");
  const ref = col.doc(transactionId);

  const data = {
    id: transactionId,
    type: String(type),
    userId: userId || null,
    partnerId: partnerId || null,
    amount: Number(amount),
    currency: String(currency),
    status: String(status),
    createdAt: serverTimestamp(),
    metadata: typeof metadata === "object" ? metadata : {},
  };

  await ref.set(data);

  let legacyTxId;
  if (logLegacy && userId && (status === STATUSES.completed || status === STATUSES.processing)) {
    try {
      legacyTxId = await logTransaction(
        userId,
        type,
        amount,
        status,
        metadata.previousBalance ?? 0,
        metadata.newBalance ?? Number(amount),
        { currency, ...metadata }
      );
    } catch (e) {
      console.warn("transactionService: legacy log failed (non-fatal):", e.message);
    }
  }

  let ledgerEntryIds;
  if (createLedgerEntries && debitAccount && creditAccount && Number(amount) > 0) {
    ledgerEntryIds = await ledgerService.createDoubleEntry({
      debitAccount,
      creditAccount,
      amount: Number(amount),
      currency: String(currency),
      transactionId,
      metadata,
    });
  }

  return { transactionId, legacyTxId, ledgerEntryIds };
}

/**
 * Update transaction record status
 *
 * @param {string} transactionId - Transaction record ID
 * @param {string} status - New status (pending, processing, completed, failed)
 * @param {Object} [updates] - Additional fields to merge
 * @returns {Promise<void>}
 */
async function updateTransactionStatus(transactionId, status, updates = {}) {
  const ref = collection("transactionRecords").doc(transactionId);
  await ref.update({
    status: String(status),
    updatedAt: serverTimestamp(),
    ...updates,
  });
}

/**
 * Get a transaction record by ID
 *
 * @param {string} transactionId
 * @returns {Promise<Object|null>}
 */
async function getTransactionRecord(transactionId) {
  const doc = await collection("transactionRecords").doc(transactionId).get();
  if (!doc.exists) return null;
  const d = doc.data();
  return {
    id: doc.id,
    ...d,
    createdAt: d.createdAt?.toDate?.()?.toISOString?.() ?? null,
    updatedAt: d.updatedAt?.toDate?.()?.toISOString?.() ?? null,
  };
}

/**
 * List transaction records (e.g. for a partner or user)
 *
 * @param {Object} options
 * @param {string} [options.userId] - Filter by userId
 * @param {string} [options.partnerId] - Filter by partnerId
 * @param {string} [options.type] - Filter by type
 * @param {string} [options.status] - Filter by status
 * @param {number} [options.limit=50]
 * @param {admin.firestore.DocumentSnapshot} [options.startAfter]
 * @returns {Promise<{ transactions: Array<Object>, lastDoc: admin.firestore.DocumentSnapshot|null }>}
 */
async function listTransactionRecords({ userId, partnerId, type, status, limit = 50, startAfter = null }) {
  let query = collection("transactionRecords").orderBy("createdAt", "desc").limit(limit);
  if (userId) query = query.where("userId", "==", userId);
  if (partnerId) query = query.where("partnerId", "==", partnerId);
  if (type) query = query.where("type", "==", type);
  if (status) query = query.where("status", "==", status);
  if (startAfter) query = query.startAfter(startAfter);

  const snapshot = await query.get();
  const transactions = snapshot.docs.map((doc) => {
    const d = doc.data();
    return {
      id: doc.id,
      ...d,
      createdAt: d.createdAt?.toDate?.()?.toISOString?.() ?? null,
      updatedAt: d.updatedAt?.toDate?.()?.toISOString?.() ?? null,
    };
  });
  const lastDoc = snapshot.docs.length === limit ? snapshot.docs[snapshot.docs.length - 1] : null;
  return { transactions, lastDoc };
}

module.exports = {
  TRANSACTION_TYPES,
  STATUSES,
  createTransactionRecord,
  updateTransactionStatus,
  getTransactionRecord,
  listTransactionRecords,
  generateTransactionRecordId,
};
