const admin = require("../admin");
const {logTransaction} = require("./transactions");

const firestore = admin.firestore();
const rtdb = admin.database();

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
      const currentFiatBalance = Number(userData.fiatBalance || 0);
      const currentCryptoBalance = Number(userData.cryptoBalance || 0);
      const newBalance = currentBalance + amountDelta;

      // Prevent negative balance (unless explicitly allowed in metadata)
      if (newBalance < 0 && !metadata.allowNegative) {
        throw new Error(`Insufficient balance. Current: ${currentBalance}, Attempted: ${amountDelta}`);
      }

      // Determine which balance field to update based on transaction type and currency
      const currency = metadata.currency || "USD";
      const isCryptoTransaction = currency === "USDT" || 
                                   currency === "BTC" || 
                                   currency === "ETH" ||
                                   transactionType === "crypto" ||
                                   metadata.isCrypto === true;
      
      // Update balance fields to keep them synchronized with the master balance field
      // This ensures admin dashboard reading directly from Firestore sees correct values
      const updateData = {
        balance: newBalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      
      // Get current currency-specific balances
      const currentUsdBalance = Number(userData.usdBalance || userData.USD || currentFiatBalance || 0);
      const currentKesBalance = Number(userData.kesBalance || userData.KES || 0);
      const currentUsdtBalance = Number(userData.usdtBalance || userData.USDT || 0);

      // Calculate new balances for all currencies
      let newUsdBalance = currentUsdBalance;
      let newKesBalance = currentKesBalance;
      let newUsdtBalance = currentUsdtBalance;

      if (isCryptoTransaction) {
        // Crypto transaction: update cryptoBalance and currency-specific balance
        updateData.cryptoBalance = currentCryptoBalance + amountDelta;
        if (currency === "USDT") {
          newUsdtBalance = currentUsdtBalance + amountDelta;
          updateData.usdtBalance = newUsdtBalance;
          updateData.USDT = newUsdtBalance;
        }
      } else {
        // Fiat transaction: update currency-specific balance
        // Only update shared fiatBalance for USD (not for KES to prevent cross-contamination)
        
        // Update currency-specific balance fields
        if (currency === "USD") {
          newUsdBalance = currentUsdBalance + amountDelta;
          updateData.usdBalance = newUsdBalance;
          updateData.USD = newUsdBalance;
          // Only update fiatBalance for USD transactions (shared field)
          updateData.fiatBalance = currentFiatBalance + amountDelta;
        } else if (currency === "KES") {
          newKesBalance = currentKesBalance + amountDelta;
          updateData.kesBalance = newKesBalance;
          updateData.KES = newKesBalance;
          // DO NOT update fiatBalance for KES - it's a shared field that should only reflect USD
        }
      }

      // Update wallets object for dashboard compatibility (stored in Firestore)
      // This ensures the dashboard can read wallets.USD, wallets.KES, wallets.USDT directly
      updateData.wallets = {
        USD: newUsdBalance,
        KES: newKesBalance,
        USDT: newUsdtBalance,
      };

      transaction.update(userRef, updateData);

      return {
        previousBalance: currentBalance,
        newBalance: newBalance,
      };
    });

    // Sync balance to Realtime Database for Flutter app
    try {
      await syncBalanceToRealtimeDatabase(userId, metadata.currency || "USD");
    } catch (syncError) {
      // Log error but don't fail the balance update
      console.error("⚠️ Failed to sync balance to Realtime DB (balance updated successfully):", syncError.message);
    }

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

/**
 * Sync user balances to Realtime Database for Flutter app
 * Flutter app reads from: wallet/{userId}/fiat/{currency} and wallet/{userId}/crypto/{currency}
 * @param {string} userId - User ID
 * @param {string} currency - Currency code (USD, KES, USDT)
 * @returns {Promise<void>}
 */
async function syncBalanceToRealtimeDatabase(userId, currency = "USD") {
  try {
    const userDoc = await firestore.collection("users").doc(userId).get();
    
    if (!userDoc.exists) {
      console.warn(`⚠️ User ${userId} not found, skipping RTDB sync`);
      return;
    }

    const userData = userDoc.data();
    const walletRef = rtdb.ref(`wallet/${userId}`);

    // Sync fiat balances
    // DO NOT fall back to fiatBalance for USD - it may contain incorrect values from KES transactions
    const usdBalance = Number(userData.usdBalance || userData.USD || 0);
    const kesBalance = Number(userData.kesBalance || userData.KES || 0);
    
    await walletRef.child("fiat/USD").set(usdBalance);
    await walletRef.child("fiat/KES").set(kesBalance);

    // Sync crypto balances
    const usdtBalance = Number(userData.usdtBalance || userData.USDT || userData.cryptoBalance || 0);
    await walletRef.child("crypto/USDT").set(usdtBalance);

    console.log(`✅ Synced balances to Realtime DB for user ${userId}`, {
      USD: usdBalance,
      KES: kesBalance,
      USDT: usdtBalance,
    });
  } catch (error) {
    console.error("❌ Error syncing balance to Realtime DB:", {
      userId,
      currency,
      error: error.message,
    });
    throw error;
  }
}

module.exports = {
  updateBalanceWithTransaction,
  getUserBalance,
  userExists,
  syncBalanceToRealtimeDatabase,
};

