/**
 * @fileoverview fundingOrders CRUD and lifecycle management.
 */

const config = require("../../config");
const { collection, serverTimestamp } = require("../../libs/firestore");
const {
  FUNDING_STATUSES,
  FUNDING_CURRENCY,
  isTerminalFundingStatus,
} = require("../../utils/fundingTypes");

const COL = config.collections.fundingOrders;

/**
 * @returns {string}
 */
function generateFundingOrderId() {
  return `fund_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * @param {Object} params
 * @returns {Promise<Object>}
 */
async function createFundingOrder(params) {
  const {
    id: explicitId,
    userId,
    provider,
    amount,
    currency = FUNDING_CURRENCY,
    metadata = {},
    providerReference = null,
    correlationId = null,
    fundingRequestId = null,
  } = params;

  const numericAmount = Number(amount);
  if (!userId || !provider || !Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error("Invalid funding order parameters");
  }

  const id = explicitId || generateFundingOrderId();
  const ref = collection(COL).doc(id);
  const data = {
    id,
    userId: String(userId),
    provider: String(provider).toLowerCase(),
    currency: String(currency).toUpperCase(),
    amount: numericAmount,
    status: FUNDING_STATUSES.pending,
    providerReference: providerReference || id,
    providerTransactionId: "",
    transactionRecordId: null,
    checkoutUrl: null,
    failureReason: null,
    correlationId: correlationId || null,
    fundingRequestId: fundingRequestId || null,
    metadata: typeof metadata === "object" ? metadata : {},
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    completedAt: null,
  };

  await ref.set(data);
  return serializeFundingOrder(id, data);
}

/**
 * @param {string} fundingOrderId
 * @param {Object} updates
 * @returns {Promise<Object>}
 */
async function updateFundingOrder(fundingOrderId, updates) {
  const ref = collection(COL).doc(fundingOrderId);
  const doc = await ref.get();
  if (!doc.exists) {
    throw new Error("Funding order not found");
  }

  const current = doc.data();
  if (isTerminalFundingStatus(current.status) && updates.status && updates.status !== current.status) {
    throw new Error(`Funding order already terminal: ${current.status}`);
  }

  const patch = {
    ...updates,
    updatedAt: serverTimestamp(),
  };
  if (updates.status === FUNDING_STATUSES.completed) {
    patch.completedAt = serverTimestamp();
  }

  await ref.update(patch);
  const after = await ref.get();
  return serializeFundingOrder(fundingOrderId, after.data());
}

/**
 * @param {string} fundingOrderId
 * @returns {Promise<Object|null>}
 */
async function getFundingOrder(fundingOrderId) {
  const doc = await collection(COL).doc(fundingOrderId).get();
  if (!doc.exists) return null;
  return serializeFundingOrder(doc.id, doc.data());
}

/**
 * @param {string} userId
 * @param {string} fundingOrderId
 * @returns {Promise<Object|null>}
 */
async function getFundingOrderForUser(userId, fundingOrderId) {
  const order = await getFundingOrder(fundingOrderId);
  if (!order || order.userId !== userId) return null;
  return order;
}

/**
 * @param {string} provider
 * @param {string} providerReference
 * @returns {Promise<Object|null>}
 */
async function findByProviderReference(provider, providerReference) {
  const snap = await collection(COL)
      .where("provider", "==", String(provider).toLowerCase())
      .where("providerReference", "==", String(providerReference))
      .limit(1)
      .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return serializeFundingOrder(doc.id, doc.data());
}

/**
 * @param {string} id
 * @param {Object} data
 * @returns {Object}
 */
function serializeFundingOrder(id, data) {
  return {
    id,
    userId: data.userId,
    provider: data.provider,
    currency: data.currency,
    amount: Number(data.amount),
    status: data.status,
    providerReference: data.providerReference || null,
    providerTransactionId: data.providerTransactionId || null,
    transactionRecordId: data.transactionRecordId || null,
    checkoutUrl: data.checkoutUrl || null,
    failureReason: data.failureReason || null,
    correlationId: data.correlationId || null,
    fundingRequestId: data.fundingRequestId || null,
    metadata: data.metadata || {},
    createdAt: data.createdAt?.toDate?.()?.toISOString?.() ?? null,
    updatedAt: data.updatedAt?.toDate?.()?.toISOString?.() ?? null,
    completedAt: data.completedAt?.toDate?.()?.toISOString?.() ?? null,
  };
}

module.exports = {
  generateFundingOrderId,
  createFundingOrder,
  updateFundingOrder,
  getFundingOrder,
  getFundingOrderForUser,
  findByProviderReference,
  serializeFundingOrder,
};
