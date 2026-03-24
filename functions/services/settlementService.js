/**
 * @fileoverview Settlement service: B2B partner payouts (e.g. hotel receives bank payout after tourist pays).
 * Flow: payment recorded → partner wallet credited → settlement scheduled → bank payout initiated.
 */

const { collection, serverTimestamp } = require("../libs/firestore");

const STATUSES = Object.freeze({
  pending: "pending",
  scheduled: "scheduled",
  processing: "processing",
  completed: "completed",
  failed: "failed",
});

/**
 * Create a settlement record for a partner
 *
 * @param {Object} params
 * @param {string} params.partnerId - Partner ID
 * @param {number} params.amount - Amount to settle
 * @param {string} params.currency - Currency (e.g. KES)
 * @param {string} [params.bankAccount] - Bank account identifier (or from partner profile)
 * @param {Object} [params.metadata] - Optional metadata
 * @returns {Promise<{ settlementId: string, settlement: Object }>}
 */
async function createSettlement({ partnerId, amount, currency, bankAccount = null, metadata = {} }) {
  const col = collection("settlements");
  const settlementId = `stl_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const data = {
    settlementId,
    partnerId: String(partnerId),
    amount: Number(amount),
    currency: String(currency),
    bankAccount: bankAccount || null,
    status: STATUSES.pending,
    metadata: metadata || {},
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  await col.doc(settlementId).set(data);
  return { settlementId, settlement: { id: settlementId, ...data } };
}

/**
 * Get settlement by ID
 *
 * @param {string} settlementId
 * @returns {Promise<Object|null>}
 */
async function getSettlement(settlementId) {
  const doc = await collection("settlements").doc(settlementId).get();
  if (!doc.exists) return null;
  const d = doc.data();
  return {
    id: doc.id,
    ...d,
    createdAt: d.createdAt?.toDate?.()?.toISOString?.() ?? null,
    updatedAt: d.updatedAt?.toDate?.()?.toISOString?.() ?? null,
  };
}

/**
 * List settlements for a partner (or all for admin)
 *
 * @param {Object} options
 * @param {string} [options.partnerId] - Filter by partner
 * @param {string} [options.status] - Filter by status
 * @param {number} [options.limit=50]
 * @param {any} [options.startAfter]
 * @returns {Promise<{ settlements: Array<Object>, lastDoc: any }>}
 */
async function listSettlements({ partnerId, status, limit = 50, startAfter = null }) {
  let query = collection("settlements").orderBy("createdAt", "desc").limit(limit);
  if (partnerId) query = query.where("partnerId", "==", partnerId);
  if (status) query = query.where("status", "==", status);
  if (startAfter) query = query.startAfter(startAfter);
  const snapshot = await query.get();
  const settlements = snapshot.docs.map((doc) => {
    const d = doc.data();
    return {
      id: doc.id,
      ...d,
      createdAt: d.createdAt?.toDate?.()?.toISOString?.() ?? null,
      updatedAt: d.updatedAt?.toDate?.()?.toISOString?.() ?? null,
    };
  });
  const lastDoc = snapshot.docs.length === limit ? snapshot.docs[snapshot.docs.length - 1] : null;
  return { settlements, lastDoc };
}

/**
 * Update settlement status (e.g. when bank payout is initiated or completed)
 *
 * @param {string} settlementId
 * @param {string} status - pending | scheduled | processing | completed | failed
 * @param {Object} [updates] - Additional fields
 * @returns {Promise<void>}
 */
async function updateSettlementStatus(settlementId, status, updates = {}) {
  const ref = collection("settlements").doc(settlementId);
  await ref.update({
    status: String(status),
    updatedAt: serverTimestamp(),
    ...updates,
  });
}

module.exports = {
  STATUSES,
  createSettlement,
  getSettlement,
  listSettlements,
  updateSettlementStatus,
};
