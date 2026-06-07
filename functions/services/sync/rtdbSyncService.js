/**
 * @fileoverview Sole gateway for Circle USDC RTDB cache writes.
 * RTDB is a UI projection only — never read for balance computation.
 *
 * RULE: No direct admin.database().ref().set() for USDC outside this module.
 */

const { ref } = require("../../libs/realtime");

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

  console.warn("rtdbSyncService: unsupported asset, skipping", { userId, asset });
}

module.exports = {
  syncToRTDB,
};
