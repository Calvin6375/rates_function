const admin = require("../admin");

const realtimeDb = admin.database();

/**
 * Update balance in Realtime Database (cached mirror)
 * This is called after Firestore balance is updated
 * @param {string} userId - User ID
 * @param {number} balance - New balance value
 * @returns {Promise<void>}
 */
async function syncBalanceToRealtime(userId, balance, currency = "USD") {
  try {
    // Write to wallet/${userId}/fiat/${currency} (expected by Flutter app)
    // Client expects: wallet/{userId}/fiat/{currency} with structure:
    // { balance: number, currency: string, createdAt: timestamp, updatedAt: timestamp }
    const balanceRef = realtimeDb.ref(`wallet/${userId}/fiat/${currency}`);
    
    // Get existing data to preserve createdAt if it exists
    const existingSnap = await balanceRef.get();
    const existingData = existingSnap.exists() ? existingSnap.val() : null;
    
    // Prepare update data
    const updateData = {
      balance: balance,
      currency: currency,
      updatedAt: admin.database.ServerValue.TIMESTAMP,
    };
    
    // Preserve createdAt if it exists, otherwise set it now
    if (existingData && existingData.createdAt) {
      updateData.createdAt = existingData.createdAt;
    } else {
      updateData.createdAt = admin.database.ServerValue.TIMESTAMP;
    }
    
    await balanceRef.set(updateData);

    // Clean up old balance paths if they exist
    try {
      const oldBalanceRef = realtimeDb.ref(`wallet/${userId}/balance`);
      const oldSnap = await oldBalanceRef.get();
      
      // If old path exists and is different from new path, remove it
      if (oldSnap.exists()) {
        const oldData = oldSnap.val();
        // Check if it's an object (old structure) vs just a number
        if (typeof oldData === "object" && oldData !== null) {
          // It's the old structured format, remove it
          await oldBalanceRef.remove();
          console.log(`🧹 Cleaned up old balance path: wallet/${userId}/balance`);
        } else if (typeof oldData === "number") {
          // It's a direct number value, remove it too
          await oldBalanceRef.remove();
          console.log(`🧹 Cleaned up old numeric balance path: wallet/${userId}/balance`);
        }
      }
    } catch (cleanupError) {
      // Don't fail the sync if cleanup fails
      console.warn(`⚠️ Failed to clean up old balance path (non-critical):`, cleanupError.message);
    }

    console.log(`✅ Synced balance to Realtime DB: wallet/${userId}/fiat/${currency} = ${balance} ${currency}`);
  } catch (error) {
    console.error("❌ Error syncing balance to Realtime DB:", {
      userId,
      balance,
      currency,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

/**
 * Get balance from Realtime Database (cached value)
 * @param {string} userId - User ID
 * @returns {Promise<number>} Cached balance
 */
async function getBalanceFromRealtime(userId, currency = "USD") {
  try {
    // Read from wallet/${userId}/fiat/${currency} (expected by client app)
    const balanceRef = realtimeDb.ref(`wallet/${userId}/fiat/${currency}`);
    const snapshot = await balanceRef.get();

    if (!snapshot.exists()) {
      return 0;
    }

    const data = snapshot.val();
    // Handle both object format {balance: number} and direct number
    if (typeof data === "object" && data !== null && "balance" in data) {
      return Number(data.balance || 0);
    }
    return Number(data || 0);
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
async function initializeBalanceInRealtime(userId, initialBalance = 0, currency = "USD") {
  try {
    // Initialize at wallet/${userId}/fiat/${currency} (expected by client app)
    // Client expects: wallet/{userId}/fiat/{currency} with structure:
    // { balance: number, currency: string, createdAt: timestamp, updatedAt: timestamp }
    const balanceRef = realtimeDb.ref(`wallet/${userId}/fiat/${currency}`);
    await balanceRef.set({
      balance: initialBalance,
      currency: currency,
      createdAt: admin.database.ServerValue.TIMESTAMP,
      updatedAt: admin.database.ServerValue.TIMESTAMP,
    });

    console.log(`✅ Initialized balance in Realtime DB: wallet/${userId}/fiat/${currency} = ${initialBalance} ${currency}`);
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

