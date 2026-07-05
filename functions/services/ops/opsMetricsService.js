/**
 * @fileoverview Operational metrics — decoupled from business logic.
 * Daily rollups in Firestore for ops dashboards.
 */

const admin = require("../../admin");
const config = require("../../config");
const { collection, serverTimestamp } = require("../../libs/firestore");
const { defaultLogger } = require("../../utils/paymentOpsLogger");

const COL = config.collections.opsMetricsDaily;

/**
 * @returns {string} YYYY-MM-DD UTC
 */
function todayBucket() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * @param {string} path dot-separated e.g. funding.successCount
 * @param {number} [delta=1]
 * @param {Object} [extra]
 * @returns {Promise<void>}
 */
async function increment(path, delta = 1, extra = {}) {
  const date = todayBucket();
  const ref = collection(COL).doc(date);
  const parts = String(path).split(".");
  if (parts.length < 2) {
    return;
  }

  const fieldPath = parts.join(".");

  try {
    await admin.firestore().runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      const data = doc.exists ? doc.data() : { date, funding: {}, settlement: {}, integrity: {} };
      const nested = { ...data };
      let cursor = nested;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!cursor[parts[i]] || typeof cursor[parts[i]] !== "object") {
          cursor[parts[i]] = {};
        }
        cursor = cursor[parts[i]];
      }
      const leaf = parts[parts.length - 1];
      cursor[leaf] = Number(cursor[leaf] || 0) + Number(delta);
      nested.updatedAt = serverTimestamp();
      tx.set(ref, nested, { merge: true });
    });
  } catch (err) {
    defaultLogger.warn("opsMetrics.increment.failed", { path, error: err.message, ...extra });
  }
}

/**
 * @param {string} path e.g. webhook.processingMs
 * @param {number} durationMs
 * @returns {Promise<void>}
 */
async function recordTiming(path, durationMs) {
  await increment(`${path}Count`, 1);
  const date = todayBucket();
  const ref = collection(COL).doc(date);
  const sumPath = `${path}TotalMs`;

  try {
    await ref.set({
      [sumPath]: admin.firestore.FieldValue.increment(Number(durationMs) || 0),
      updatedAt: serverTimestamp(),
    }, { merge: true });
  } catch (err) {
    defaultLogger.warn("opsMetrics.timing.failed", { path, error: err.message });
  }
}

/**
 * @param {number} amountUsd
 * @returns {Promise<void>}
 */
async function recordFundingVolume(amountUsd) {
  const numeric = Number(amountUsd) || 0;
  if (numeric <= 0) return;
  const date = todayBucket();
  const ref = collection(COL).doc(date);
  try {
    await ref.set({
      funding: {
        volumeUsd: admin.firestore.FieldValue.increment(numeric),
        successCount: admin.firestore.FieldValue.increment(1),
      },
      updatedAt: serverTimestamp(),
    }, { merge: true });
  } catch (err) {
    defaultLogger.warn("opsMetrics.volume.failed", { error: err.message });
  }
}

/**
 * @param {number} amountUsd
 * @returns {Promise<void>}
 */
async function recordMerchantVolume(amountUsd) {
  const numeric = Number(amountUsd) || 0;
  if (numeric <= 0) return;
  const date = todayBucket();
  const ref = collection(COL).doc(date);
  try {
    await ref.set({
      settlement: {
        volumeUsd: admin.firestore.FieldValue.increment(numeric),
        successCount: admin.firestore.FieldValue.increment(1),
      },
      updatedAt: serverTimestamp(),
    }, { merge: true });
  } catch (err) {
    defaultLogger.warn("opsMetrics.merchantVolume.failed", { error: err.message });
  }
}

/**
 * @param {string} [date]
 * @returns {Promise<Object|null>}
 */
async function getDailyRollup(date = todayBucket()) {
  const doc = await collection(COL).doc(date).get();
  if (!doc.exists) return null;
  const d = doc.data();
  return {
    date,
    ...d,
    updatedAt: d.updatedAt?.toDate?.()?.toISOString?.() ?? null,
  };
}

module.exports = {
  todayBucket,
  increment,
  recordTiming,
  recordFundingVolume,
  recordMerchantVolume,
  getDailyRollup,
};
