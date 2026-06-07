/**
 * @fileoverview Send-operation idempotency keys (24h TTL).
 */

const admin = require("../../admin");
const { collection, serverTimestamp } = require("../../libs/firestore");

const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Acquire or return cached result for a send idempotency key.
 * @param {string} key
 * @param {string} userId
 * @param {Object} requestData
 * @returns {Promise<{ acquired: boolean, cachedResult?: Object }>}
 */
async function acquireSendKey(key, userId, requestData) {
  const ref = collection("sendIdempotencyKeys").doc(key);
  const db = admin.firestore();

  return db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (doc.exists) {
      const data = doc.data();
      const createdAt = data.createdAt?.toMillis?.() || 0;
      if (Date.now() - createdAt < TTL_MS) {
        if (data.result) {
          return { acquired: false, cachedResult: data.result };
        }
        throw new Error("Duplicate send request already in progress");
      }
    }

    tx.set(ref, {
      key,
      userId,
      requestData,
      createdAt: serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + TTL_MS)),
    });

    return { acquired: true };
  });
}

/**
 * @param {string} key
 * @param {Object} result
 * @param {string} [circleTransactionId]
 */
async function storeSendResult(key, result, circleTransactionId) {
  const data = {
    result,
    completedAt: serverTimestamp(),
  };
  if (circleTransactionId) {
    data.circleTransactionId = circleTransactionId;
  }
  await collection("sendIdempotencyKeys").doc(key).set(data, { merge: true });
}

module.exports = {
  acquireSendKey,
  storeSendResult,
};
