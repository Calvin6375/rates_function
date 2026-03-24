/**
 * @fileoverview Balance sync: ensure user wallet balances in Firestore are reflected in Realtime DB.
 * Used by the Flutter app. Normal flow: balance updates (utils/firestore) already sync after each write.
 * This module can be used for one-off or batch sync (e.g. admin or recovery).
 */

const config = require("../config");
const admin = require("../admin");
const { syncBalanceToRealtimeDatabase } = require("../utils/firestore");

/**
 * Sync a single user's Firestore balances to Realtime DB.
 *
 * @param {string} userId - User ID
 * @param {string} [currency='USD'] - Currency that changed (triggers full wallet sync)
 * @returns {Promise<void>}
 */
async function syncUserBalance(userId, currency = "USD") {
  await syncBalanceToRealtimeDatabase(userId, currency);
}

/**
 * Sync balances for multiple users (e.g. batch or admin). Use with care on large sets.
 *
 * @param {string[]} userIds - List of user IDs
 * @returns {Promise<{ synced: number, failed: string[] }>}
 */
async function syncUserBalancesBatch(userIds) {
  const failed = [];
  let synced = 0;
  for (const uid of userIds) {
    try {
      await syncBalanceToRealtimeDatabase(uid, "USD");
      synced++;
    } catch (e) {
      failed.push(uid);
      console.warn("balanceSync: failed for user", uid, e.message);
    }
  }
  return { synced, failed };
}

module.exports = {
  syncUserBalance,
  syncUserBalancesBatch,
};
