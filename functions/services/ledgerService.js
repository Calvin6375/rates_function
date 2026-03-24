/**
 * @fileoverview Double-entry ledger service for TruePay.
 * Every financial transaction creates ledger entries (debit/credit) for audit and accounting.
 *
 * Account types: user_wallet, partner_wallet, platform_revenue, liquidity_pool, settlement_account
 */

const { collection, serverTimestamp } = require("../libs/firestore");

const LEDGER_COLLECTION = "ledgerEntries";

/**
 * Generate a unique ledger entry ID
 * @returns {string}
 */
function generateLedgerEntryId() {
  return `le_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Create a single ledger entry (one side of double entry).
 * Call this twice per transaction: once for debit, once for credit.
 *
 * @param {Object} params
 * @param {string} params.account - Account identifier (e.g. user_wallet:{userId}, partner_wallet:{partnerId})
 * @param {string} params.side - 'debit' | 'credit'
 * @param {number} params.amount - Amount (positive)
 * @param {string} params.currency - Currency code (USD, KES, USDT)
 * @param {string} params.transactionId - Reference to transaction record
 * @param {Object} [params.metadata] - Optional metadata
 * @returns {Promise<string>} Ledger entry ID
 */
async function createLedgerEntry({ account, side, amount, currency, transactionId, metadata = {} }) {
  const id = generateLedgerEntryId();
  const ref = collection(LEDGER_COLLECTION).doc(id);
  const data = {
    id,
    account,
    side: side === "debit" ? "debit" : "credit",
    amount: Number(amount),
    currency: String(currency),
    transaction_id: transactionId,
    metadata: typeof metadata === "object" ? metadata : {},
    createdAt: serverTimestamp(),
  };
  await ref.set(data);
  return id;
}

/**
 * Create double-entry ledger entries for a transfer: one debit, one credit.
 *
 * @param {Object} params
 * @param {string} params.debitAccount - Account to debit (e.g. user_wallet:uid123)
 * @param {string} params.creditAccount - Account to credit
 * @param {number} params.amount - Amount (positive)
 * @param {string} params.currency - Currency code
 * @param {string} params.transactionId - Transaction record ID
 * @param {Object} [params.metadata] - Optional metadata
 * @returns {Promise<{ debitEntryId: string, creditEntryId: string }>}
 */
async function createDoubleEntry({ debitAccount, creditAccount, amount, currency, transactionId, metadata = {} }) {
  const [debitEntryId, creditEntryId] = await Promise.all([
    createLedgerEntry({
      account: debitAccount,
      side: "debit",
      amount,
      currency,
      transactionId,
      metadata,
    }),
    createLedgerEntry({
      account: creditAccount,
      side: "credit",
      amount,
      currency,
      transactionId,
      metadata,
    }),
  ]);
  return { debitEntryId, creditEntryId };
}

/**
 * List ledger entries for an account (optional filter by transaction)
 *
 * @param {Object} options
 * @param {string} [options.account] - Filter by account (e.g. user_wallet:uid)
 * @param {string} [options.transactionId] - Filter by transaction ID
 * @param {number} [options.limit=50]
 * @param {admin.firestore.DocumentSnapshot} [options.startAfter] - Cursor for pagination
 * @returns {Promise<{ entries: Array<Object>, lastDoc: admin.firestore.DocumentSnapshot|null }>}
 */
async function listLedgerEntries({ account, transactionId, limit = 50, startAfter = null }) {
  let query = collection(LEDGER_COLLECTION).orderBy("createdAt", "desc").limit(limit);
  if (account) {
    query = query.where("account", "==", account);
  }
  if (transactionId) {
    query = query.where("transaction_id", "==", transactionId);
  }
  if (startAfter) {
    query = query.startAfter(startAfter);
  }
  const snapshot = await query.get();
  const entries = snapshot.docs.map((d) => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.()?.toISOString?.() }));
  const lastDoc = snapshot.docs.length === limit ? snapshot.docs[snapshot.docs.length - 1] : null;
  return { entries, lastDoc };
}

module.exports = {
  createLedgerEntry,
  createDoubleEntry,
  listLedgerEntries,
  generateLedgerEntryId,
};
