const admin = require("../admin");
const config = require("../config");

const firestore = admin.firestore();

/**
 * Generate a unique transaction ID
 * @returns {string} Transaction ID
 */
function generateTransactionId() {
  return `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Log a transaction to Firestore
 * @param {string} userId - User ID
 * @param {string} type - Transaction type (credit, debit, transfer, etc.)
 * @param {number} amount - Transaction amount
 * @param {string} status - Transaction status (completed, pending, failed)
 * @param {number} previousBalance - Balance before transaction
 * @param {number} newBalance - Balance after transaction
 * @param {Object} metadata - Additional metadata (optional)
 * @returns {Promise<string>} Transaction ID
 */
async function logTransaction(
    userId,
    type,
    amount,
    status,
    previousBalance,
    newBalance,
    metadata = {},
) {
  try {
    const txId = generateTransactionId();
    const timestamp = admin.firestore.FieldValue.serverTimestamp();

    // Coerce numbers so Firestore never gets NaN or invalid values
    const safeAmount = Number(amount);
    const safePrevious = Number(previousBalance);
    const safeNew = Number(newBalance);

    // Extract currency from metadata if present (for topup, swap, etc.)
    const currency = metadata.currency || null;

    // Strip undefined from metadata so Firestore accepts the document
    const sanitizedMetadata = Object.fromEntries(
      Object.entries(metadata).filter(([, v]) => v !== undefined),
    );

    const transactionData = {
      type: String(type),
      amount: Number.isFinite(safeAmount) ? safeAmount : 0,
      status: String(status),
      timestamp,
      previousBalance: Number.isFinite(safePrevious) ? safePrevious : 0,
      newBalance: Number.isFinite(safeNew) ? safeNew : 0,
      metadata: sanitizedMetadata,
      userId: String(userId),
    };

    // Add currency as top-level field if present in metadata
    if (currency) {
      transactionData.currency = String(currency);
    }

    const transactionsCol = config.collections.transactions || "transactions";
    const userTxRef = firestore.collection(transactionsCol).doc(userId);

    // Ensure parent document exists so the subcollection is visible in console and queries
    await userTxRef.set(
      { updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true },
    );

    await userTxRef
        .collection("transactions")
        .doc(txId)
        .set(transactionData);

    console.log("✅ Transaction logged: " + txId, {
      userId,
      type,
      amount: transactionData.amount,
      status,
      previousBalance: transactionData.previousBalance,
      newBalance: transactionData.newBalance,
    });

    return txId;
  } catch (error) {
    console.error("❌ Error logging transaction:", {
      userId,
      type,
      amount,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Log an admin action
 * @param {string} adminId - Admin user ID
 * @param {string} userId - Target user ID (if applicable)
 * @param {string} action - Action type (updateBalance, updateProfile, etc.)
 * @param {Object} before - State before action
 * @param {Object} after - State after action
 * @returns {Promise<string>} Admin log ID
 */
async function logAdminAction(adminId, userId, action, before, after) {
  try {
    const logId = `admin_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const timestamp = admin.firestore.FieldValue.serverTimestamp();

    const logData = {
      adminId,
      userId,
      action,
      before,
      after,
      timestamp,
    };

    await firestore.collection("adminLogs").doc(logId).set(logData);

    console.log(`✅ Admin action logged: ${logId}`, {
      adminId,
      userId,
      action,
    });

    return logId;
  } catch (error) {
    console.error("❌ Error logging admin action:", {
      adminId,
      userId,
      action,
      error: error.message,
    });
    throw error;
  }
}

module.exports = {
  logTransaction,
  logAdminAction,
  generateTransactionId,
};

