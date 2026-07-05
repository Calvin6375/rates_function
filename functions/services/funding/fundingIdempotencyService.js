/**
 * @fileoverview Funding order idempotency — Idempotency-Key header support.
 */

const admin = require("../../admin");
const config = require("../../config");
const { collection, serverTimestamp } = require("../../libs/firestore");

const COL = config.collections.fundingIdempotencyKeys;
const TTL_HOURS = config.funding.idempotencyTtlHours || 24;

/**
 * @param {string} userId
 * @param {string} idempotencyKey
 * @returns {string}
 */
function keyDocId(userId, idempotencyKey) {
  return `fik_${userId}_${idempotencyKey}`.slice(0, 150);
}

/**
 * @param {Object} params
 * @returns {Promise<{ duplicate: boolean, fundingOrderId?: string }>}
 */
async function claimIdempotencyKey(params) {
  const { userId, idempotencyKey, fundingOrderId } = params;
  if (!userId || !idempotencyKey || !fundingOrderId) {
    throw new Error("userId, idempotencyKey, and fundingOrderId required");
  }

  const docId = keyDocId(userId, idempotencyKey);
  const ref = collection(COL).doc(docId);
  const expiresAt = admin.firestore.Timestamp.fromDate(
      new Date(Date.now() + TTL_HOURS * 60 * 60 * 1000),
  );

  return admin.firestore().runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (doc.exists) {
      const data = doc.data();
      return { duplicate: true, fundingOrderId: data.fundingOrderId };
    }
    tx.set(ref, {
      id: docId,
      userId,
      idempotencyKey,
      fundingOrderId,
      createdAt: serverTimestamp(),
      expiresAt,
    });
    return { duplicate: false, fundingOrderId };
  });
}

/**
 * @param {string} userId
 * @param {string} idempotencyKey
 * @returns {Promise<{ fundingOrderId: string }|null>}
 */
async function lookupIdempotencyKey(userId, idempotencyKey) {
  if (!userId || !idempotencyKey) return null;
  const doc = await collection(COL).doc(keyDocId(userId, idempotencyKey)).get();
  if (!doc.exists) return null;
  const data = doc.data();
  if (data.expiresAt?.toDate?.() < new Date()) return null;
  return { fundingOrderId: data.fundingOrderId };
}

module.exports = {
  claimIdempotencyKey,
  lookupIdempotencyKey,
};
