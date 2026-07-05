/**
 * @fileoverview Persist webhook payloads before processing — receipt-first idempotency.
 */

const config = require("../../config");
const { collection, serverTimestamp } = require("../../libs/firestore");
const { WEBHOOK_RECEIPT_STATUSES } = require("../../utils/fundingTypes");
const { defaultLogger } = require("../../utils/paymentOpsLogger");

const COL = config.collections.webhookReceipts;

/**
 * @param {string} provider
 * @param {string} eventId
 * @returns {string}
 */
function receiptDocId(provider, eventId) {
  return `${String(provider).toLowerCase()}_${String(eventId)}`.slice(0, 150);
}

/**
 * @param {Object} params
 * @returns {Promise<{ receiptId: string, duplicate: boolean, status: string }>}
 */
async function persistReceipt(params) {
  const {
    provider,
    eventId,
    payload,
    correlationId = null,
    fundingOrderId = null,
  } = params;

  if (!provider || !eventId) {
    throw new Error("provider and eventId required for webhook receipt");
  }

  const receiptId = receiptDocId(provider, eventId);
  const ref = collection(COL).doc(receiptId);
  const existing = await ref.get();

  if (existing.exists) {
    const data = existing.data();
    return {
      receiptId,
      duplicate: true,
      status: data.status || WEBHOOK_RECEIPT_STATUSES.received,
    };
  }

  await ref.set({
    id: receiptId,
    provider: String(provider).toLowerCase(),
    eventId: String(eventId),
    status: WEBHOOK_RECEIPT_STATUSES.received,
    correlationId,
    fundingOrderId,
    payload: typeof payload === "object" ? payload : {},
    receivedAt: serverTimestamp(),
    processedAt: null,
    error: null,
  });

  return { receiptId, duplicate: false, status: WEBHOOK_RECEIPT_STATUSES.received };
}

/**
 * @param {string} receiptId
 * @param {string} status
 * @param {Object} [extra]
 * @returns {Promise<void>}
 */
async function updateReceiptStatus(receiptId, status, extra = {}) {
  const ref = collection(COL).doc(receiptId);
  await ref.update({
    status,
    ...extra,
    processedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

/**
 * @param {string} receiptId
 * @returns {Promise<Object|null>}
 */
async function getReceipt(receiptId) {
  const doc = await collection(COL).doc(receiptId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

module.exports = {
  receiptDocId,
  persistReceipt,
  updateReceiptStatus,
  getReceipt,
};
