const admin = require("../admin");
const {logTransaction} = require("./transactions");

const firestore = admin.firestore();

/**
 * Update user balance using Firestore transaction
 * Prevents race conditions and ensures atomicity
 * @param {string} userId - User ID
 * @param {number} amountDelta - Amount to add (positive) or subtract (negative)
 * @param {string} transactionType - Type of transaction (credit, debit, etc.)
 * @param {Object} metadata - Additional metadata for transaction log
 * @returns {Promise<{success: boolean, previousBalance: number, newBalance: number, transactionId?: string}>}
 */
async function updateBalanceWithTransaction(
    userId,
    amountDelta,
    transactionType = "credit",
    metadata = {},
) {
  try {
    const userRef = firestore.collection("users").doc(userId);

    const result = await firestore.runTransaction(async (transaction) => {
      // Read current user document
      const userDoc = await transaction.get(userRef);

      if (!userDoc.exists) {
        throw new Error(`User ${userId} not found`);
      }

      const userData = userDoc.data();
      const currentBalance = Number(userData.balance || 0);
      const newBalance = currentBalance + amountDelta;

      // Prevent negative balance (unless explicitly allowed in metadata)
      if (newBalance < 0 && !metadata.allowNegative) {
        throw new Error(`Insufficient balance. Current: ${currentBalance}, Attempted: ${amountDelta}`);
      }

      // Update balance
      transaction.update(userRef, {
        balance: newBalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return {
        previousBalance: currentBalance,
        newBalance: newBalance,
      };
    });

    // Log transaction after successful update
    let transactionId;
    try {
      transactionId = await logTransaction(
          userId,
          transactionType,
          Math.abs(amountDelta),
          "completed",
          result.previousBalance,
          result.newBalance,
          {
            ...metadata,
            amountDelta,
          },
      );
    } catch (logError) {
      // Log error but don't fail the balance update
      console.error("⚠️ Failed to log transaction (balance updated successfully):", logError.message);
    }

    return {
      success: true,
      previousBalance: result.previousBalance,
      newBalance: result.newBalance,
      transactionId,
    };
  } catch (error) {
    console.error("❌ Error updating balance with transaction:", {
      userId,
      amountDelta,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Get user balance from Firestore (master source)
 * @param {string} userId - User ID
 * @returns {Promise<number>} Current balance
 */
async function getUserBalance(userId) {
  try {
    const userDoc = await firestore.collection("users").doc(userId).get();

    if (!userDoc.exists) {
      throw new Error(`User ${userId} not found`);
    }

    const userData = userDoc.data();
    return Number(userData.balance || 0);
  } catch (error) {
    console.error("❌ Error getting user balance:", {
      userId,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Check if user exists
 * @param {string} userId - User ID
 * @returns {Promise<boolean>} True if user exists
 */
async function userExists(userId) {
  try {
    const userDoc = await firestore.collection("users").doc(userId).get();
    return userDoc.exists;
  } catch (error) {
    console.error("❌ Error checking user existence:", {
      userId,
      error: error.message,
    });
    return false;
  }
}

module.exports = {
  updateBalanceWithTransaction,
  getUserBalance,
  userExists,
};

