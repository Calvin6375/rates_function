/**
 * @fileoverview Immutable payment timeline — append-only event history per funding order.
 */

const config = require("../../config");
const { collection, serverTimestamp } = require("../../libs/firestore");
const { TIMELINE_EVENT_TYPES } = require("../../utils/fundingTypes");
const { defaultLogger } = require("../../utils/paymentOpsLogger");

const COL = config.collections.fundingOrders;

/**
 * @param {string} fundingOrderId
 * @param {string} eventType
 * @param {string} [idempotencyKey]
 * @returns {string}
 */
function timelineDocId(fundingOrderId, eventType, idempotencyKey) {
  if (idempotencyKey) {
    return `tl_${eventType}_${idempotencyKey}`.slice(0, 120);
  }
  return `tl_${eventType}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

/**
 * Record an immutable timeline event. Failures are logged but never block payment flow.
 *
 * @param {Object} params
 * @param {string} params.fundingOrderId
 * @param {string} params.correlationId
 * @param {string} params.eventType
 * @param {string} [params.provider]
 * @param {string} [params.status]
 * @param {Object} [params.metadata]
 * @param {string} [params.source]
 * @param {string} [params.idempotencyKey]
 * @returns {Promise<{ eventId: string, duplicate?: boolean }|null>}
 */
async function recordEvent(params) {
  const {
    fundingOrderId,
    correlationId,
    eventType,
    provider = null,
    status = null,
    metadata = {},
    source = "system",
    idempotencyKey = null,
  } = params;

  if (!fundingOrderId || !correlationId || !eventType) {
    defaultLogger.warn("timeline.record.skipped", {
      reason: "missing required fields",
      fundingOrderId,
      correlationId,
      eventType,
    });
    return null;
  }

  const eventId = timelineDocId(fundingOrderId, eventType, idempotencyKey);
  const ref = collection(COL).doc(fundingOrderId).collection("timeline").doc(eventId);

  try {
    const existing = await ref.get();
    if (existing.exists) {
      return { eventId, duplicate: true };
    }

    await ref.set({
      id: eventId,
      fundingOrderId,
      correlationId,
      eventType,
      provider,
      status,
      source,
      metadata: typeof metadata === "object" ? metadata : {},
      createdAt: serverTimestamp(),
    });

    return { eventId, duplicate: false };
  } catch (err) {
    defaultLogger.error("timeline.record.failed", {
      correlationId,
      fundingOrderId,
      eventType,
      error: err.message,
    });
    return null;
  }
}

/**
 * @param {string} fundingOrderId
 * @param {number} [limit=100]
 * @returns {Promise<Array<Object>>}
 */
async function listEvents(fundingOrderId, limit = 100) {
  const snap = await collection(COL)
      .doc(fundingOrderId)
      .collection("timeline")
      .orderBy("createdAt", "asc")
      .limit(limit)
      .get();

  return snap.docs.map((doc) => {
    const d = doc.data();
    return {
      id: doc.id,
      ...d,
      createdAt: d.createdAt?.toDate?.()?.toISOString?.() ?? null,
    };
  });
}

/**
 * @param {string} correlationId
 * @param {number} [limit=50]
 * @returns {Promise<Array<Object>>}
 */
async function listEventsByCorrelationId(correlationId, limit = 50) {
  const ordersSnap = await collection(COL)
      .where("correlationId", "==", correlationId)
      .limit(5)
      .get();

  /** @type {Array<Object>} */
  const all = [];
  for (const orderDoc of ordersSnap.docs) {
    const events = await listEvents(orderDoc.id, limit);
    all.push(...events);
  }
  return all.sort((a, b) => {
    const ta = a.createdAt || "";
    const tb = b.createdAt || "";
    return ta.localeCompare(tb);
  });
}

module.exports = {
  TIMELINE_EVENT_TYPES,
  recordEvent,
  listEvents,
  listEventsByCorrelationId,
};
