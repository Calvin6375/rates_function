/**
 * @fileoverview Realtime Database client for TruePay backend.
 * Used for caching rates and syncing wallet balances for the Flutter app.
 */

const admin = require("../admin");

const rtdb = admin.database();

/**
 * Get Realtime Database instance
 * @returns {admin.database.Database}
 */
function getRealtimeDb() {
  return rtdb;
}

/**
 * Get a reference to a path
 * @param {string} path - Path (e.g. 'wallet/rates', 'wallet/{userId}/fiat')
 * @returns {admin.database.Reference}
 */
function ref(path) {
  return rtdb.ref(path);
}

module.exports = {
  rtdb,
  getRealtimeDb,
  ref,
};
