/**
 * @fileoverview Admin payment audit — query by correlationId across collections.
 */

const config = require("../../config");
const { collection } = require("../../libs/firestore");
const fundingOrderService = require("../funding/fundingOrderService");
const webhookReceiptService = require("./webhookReceiptService");
const { listEventsByCorrelationId } = require("./paymentTimelineService");

/**
 * @param {string} correlationId
 * @returns {Promise<Object>}
 */
async function auditByCorrelationId(correlationId) {
  if (!correlationId) {
    throw new Error("correlationId is required");
  }

  const ordersSnap = await collection(config.collections.fundingOrders)
      .where("correlationId", "==", correlationId)
      .limit(10)
      .get();

  const fundingOrders = [];
  for (const doc of ordersSnap.docs) {
    fundingOrders.push(fundingOrderService.serializeFundingOrder(doc.id, doc.data()));
  }

  const timeline = await listEventsByCorrelationId(correlationId);

  const receiptsSnap = await collection(config.collections.webhookReceipts)
      .where("correlationId", "==", correlationId)
      .limit(20)
      .get();

  const webhookReceipts = receiptsSnap.docs.map((d) => ({
    id: d.id,
    ...d.data(),
    receivedAt: d.data().receivedAt?.toDate?.()?.toISOString?.() ?? null,
    processedAt: d.data().processedAt?.toDate?.()?.toISOString?.() ?? null,
  }));

  const merchantPayments = [];
  if (fundingOrders.length > 0) {
    const userId = fundingOrders[0].userId;
    const mpSnap = await collection(config.collections.merchantPayments)
        .where("userId", "==", userId)
        .limit(20)
        .get();
    for (const doc of mpSnap.docs) {
      const d = doc.data();
      if (d.metadata?.correlationId === correlationId || d.correlationId === correlationId) {
        merchantPayments.push({ id: doc.id, ...d });
      }
    }
  }

  return {
    correlationId,
    fundingOrders,
    timeline,
    webhookReceipts,
    merchantPayments,
  };
}

/**
 * @param {Object} entry
 * @returns {Promise<string>}
 */
async function logAuditEntry(entry) {
  const ref = collection(config.collections.paymentAuditLog).doc();
  await ref.set({
    ...entry,
    createdAt: new Date().toISOString(),
  });
  return ref.id;
}

module.exports = {
  auditByCorrelationId,
  logAuditEntry,
};
