const admin = require("../admin");

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

    const transactionData = {
      type,
      amount,
      status,
      timestamp,
      previousBalance,
      newBalance,
      metadata,
      userId,
    };

    await firestore
        .collection("transactions")
        .doc(userId)
        .collection("transactions")
        .doc(txId)
        .set(transactionData);

    console.log(`✅ Transaction logged: ${txId}`, {
      userId,
      type,
      amount,
      status,
      previousBalance,
      newBalance,
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

