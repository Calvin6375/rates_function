const admin = require("../admin");

const realtimeDb = admin.database();

/**
 * Update balance in Realtime Database (cached mirror)
 * This is called after Firestore balance is updated
 * @param {string} userId - User ID
 * @param {number} balance - New balance value
 * @returns {Promise<void>}
 */
async function syncBalanceToRealtime(userId, balance) {
  try {
    const balanceRef = realtimeDb.ref(`balances/${userId}/balance`);
    await balanceRef.set(balance);

    // Also update lastUpdated timestamp
    await realtimeDb.ref(`balances/${userId}/lastUpdated`).set(
        admin.database.ServerValue.TIMESTAMP,
    );

    console.log(`✅ Synced balance to Realtime DB: ${userId} = ${balance}`);
  } catch (error) {
    console.error("❌ Error syncing balance to Realtime DB:", {
      userId,
      balance,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Get balance from Realtime Database (cached value)
 * @param {string} userId - User ID
 * @returns {Promise<number>} Cached balance
 */
async function getBalanceFromRealtime(userId) {
  try {
    const balanceRef = realtimeDb.ref(`balances/${userId}/balance`);
    const snapshot = await balanceRef.get();

    if (!snapshot.exists()) {
      return 0;
    }

    return Number(snapshot.val() || 0);
  } catch (error) {
    console.error("❌ Error getting balance from Realtime DB:", {
      userId,
      error: error.message,
    });
    return 0; // Return 0 on error (Firestore is source of truth)
  }
}

/**
 * Initialize balance in Realtime Database (for new users)
 * @param {string} userId - User ID
 * @param {number} initialBalance - Initial balance (default: 0)
 * @returns {Promise<void>}
 */
async function initializeBalanceInRealtime(userId, initialBalance = 0) {
  try {
    const balanceRef = realtimeDb.ref(`balances/${userId}`);
    await balanceRef.set({
      balance: initialBalance,
      lastUpdated: admin.database.ServerValue.TIMESTAMP,
    });

    console.log(`✅ Initialized balance in Realtime DB: ${userId} = ${initialBalance}`);
  } catch (error) {
    console.error("❌ Error initializing balance in Realtime DB:", {
      userId,
      initialBalance,
      error: error.message,
    });
    throw error;
  }
}

module.exports = {
  syncBalanceToRealtime,
  getBalanceFromRealtime,
  initializeBalanceInRealtime,
};

