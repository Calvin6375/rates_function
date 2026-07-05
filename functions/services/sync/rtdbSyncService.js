/**
 * @fileoverview Sole gateway for RTDB balance cache writes.
 * RTDB is a UI projection only — never read for balance computation.
 *
 * RULE: No direct admin.database().ref().set() for balances outside this module.
 */

const { ref } = require("../../libs/realtime");

const FIAT_RTDB_ASSETS = new Set(["USD", "KES", "NGN", "GHS", "USDT", "TZS", "ETB"]);

/**
 * Project a Firestore-derived balance to RTDB (read-only cache for Flutter).
 * @param {string} userId
 * @param {string} asset
 * @param {number} value
 * @returns {Promise<void>}
 */
async function syncToRTDB(userId, asset, value) {
  const numeric = Number(value);
  if (!userId || !asset || !Number.isFinite(numeric)) {
    throw new Error("Invalid RTDB sync parameters");
  }

  if (asset === "USDC") {
    await ref(`wallet/${userId}/crypto/USDC`).set(numeric);
    return;
  }

  if (FIAT_RTDB_ASSETS.has(asset)) {
    await syncFiatToRTDB(userId, asset, numeric);
    return;
  }

  console.warn("rtdbSyncService: unsupported asset, skipping", { userId, asset });
}

/**
 * Project a single fiat currency balance to RTDB.
 * @param {string} userId
 * @param {string} currency
 * @param {number} value
 * @returns {Promise<void>}
 */
async function syncFiatToRTDB(userId, currency, value) {
  const cur = String(currency || "").toUpperCase();
  const numeric = Number(value);
  if (!userId || !cur || !Number.isFinite(numeric)) {
    throw new Error("Invalid fiat RTDB sync parameters");
  }
  await ref(`wallet/${userId}/fiat/${cur}`).set(numeric);
}

module.exports = {
  syncToRTDB,
  syncFiatToRTDB,
};
