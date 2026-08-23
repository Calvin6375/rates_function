/**
 * @fileoverview B2B partner dashboard aggregates — summary cards, sales chart, recent sends/collections.
 * Partner users: scoped to their partnerId (B2B only).
 * Platform super admin: all partners; optional ?partnerId= filter and ?channel=c2b|all for consumer data.
 */

const config = require("../config");
const { collection } = require("../libs/firestore");
const transactionService = require("./transactionService");
const b2bSendService = require("./b2bSendService");
const settlementService = require("./settlementService");
const { getUserNotifications } = require("../utils/notifications");

const SEND_COL = config.collections.partnerSendPayments;
const SETTLEMENTS_COL = "settlements";

const B2B_DASHBOARD_TYPES = Object.freeze([
  "b2b_payment",
  "b2b_funding",
  "b2b_send",
  "b2b_admin_topup",
  "settlement",
]);

const COLLECTION_TYPES = Object.freeze(["b2b_payment"]);

const PENDING_SETTLEMENT_STATUSES = new Set([
  settlementService.STATUSES.pending,
  settlementService.STATUSES.scheduled,
  settlementService.STATUSES.processing,
]);

/**
 * @param {string} [periodKey]
 * @returns {{ key: string, label: string, from: Date, to: Date, previousFrom: Date, previousTo: Date }}
 */
function resolveDashboardPeriod(periodKey) {
  const key = String(periodKey || "month").toLowerCase();
  const to = new Date();
  const from = new Date(to);

  if (key === "7d") {
    from.setDate(from.getDate() - 7);
  } else if (key === "30d") {
    from.setDate(from.getDate() - 30);
  } else if (key === "90d") {
    from.setDate(from.getDate() - 90);
  } else {
    from.setDate(1);
    from.setHours(0, 0, 0, 0);
  }

  const spanMs = to.getTime() - from.getTime();
  const previousTo = new Date(from.getTime() - 1);
  const previousFrom = new Date(previousTo.getTime() - spanMs);

  const labels = {
    "7d": "Last 7 days",
    "30d": "Last 30 days",
    "90d": "Last 90 days",
    month: "This month",
  };

  return {
    key: key === "month" || !labels[key] ? "month" : key,
    label: labels[key] || labels.month,
    from,
    to,
    previousFrom,
    previousTo,
  };
}

/**
 * @param {string|null|undefined} iso
 * @returns {number}
 */
function isoToMs(iso) {
  if (!iso) {
    return 0;
  }
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * @param {Date} from
 * @param {Date} to
 * @returns {{ fromMs: number, toMs: number }}
 */
function periodBounds(from, to) {
  return { fromMs: from.getTime(), toMs: to.getTime() };
}

/**
 * @param {number} ms
 * @param {number} fromMs
 * @param {number} toMs
 * @returns {boolean}
 */
function inRangeMs(ms, fromMs, toMs) {
  if (!ms) {
    return false;
  }
  return ms >= fromMs && ms <= toMs;
}

/**
 * @param {string} channel
 * @param {boolean} platformScope
 * @returns {string[]|null}
 */
function resolveDashboardTypes(channel, platformScope) {
  const ch = String(channel || "b2b").toLowerCase();
  if (!platformScope) {
    return [...B2B_DASHBOARD_TYPES];
  }
  if (ch === "all") {
    const b2b = transactionService.CHANNEL_TYPES.b2b || [];
    const c2b = transactionService.CHANNEL_TYPES.c2b || [];
    return [...new Set([...b2b, ...c2b])];
  }
  if (ch === "c2b") {
    return transactionService.CHANNEL_TYPES.c2b || null;
  }
  return transactionService.CHANNEL_TYPES.b2b || [...B2B_DASHBOARD_TYPES];
}

/**
 * @param {Object} opts
 * @returns {Promise<Array<Object>>}
 */
async function loadDashboardTransactions(opts) {
  const {
    partnerId,
    types,
    scanLimit = 2500,
  } = opts;

  const typeList = types && types.length ? types.slice(0, 10) : null;

  /** @type {import("firebase-admin/firestore").Query} */
  let query = collection("transactionRecords")
      .orderBy("createdAt", "desc")
      .limit(scanLimit);

  if (partnerId) {
    query = query.where("partnerId", "==", String(partnerId));
  } else if (typeList && typeList.length === 1) {
    query = query.where("type", "==", typeList[0]);
  } else if (typeList && typeList.length > 1) {
    query = query.where("type", "in", typeList);
  }

  try {
    const snap = await query.get();
    let rows = snap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        ...d,
        createdAt: d.createdAt?.toDate?.()?.toISOString?.() ?? null,
        updatedAt: d.updatedAt?.toDate?.()?.toISOString?.() ?? null,
      };
    });

    if (typeList && typeList.length > 1 && partnerId) {
      rows = rows.filter((row) => typeList.includes(row.type));
    }
    if (typeList && typeList.length > 1 && !partnerId && typeList.length <= 10) {
      rows = rows.filter((row) => typeList.includes(row.type));
    }

    return rows;
  } catch (err) {
    const fallbackSnap = await collection("transactionRecords")
        .orderBy("createdAt", "desc")
        .limit(scanLimit)
        .get();
    let rows = fallbackSnap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        ...d,
        createdAt: d.createdAt?.toDate?.()?.toISOString?.() ?? null,
        updatedAt: d.updatedAt?.toDate?.()?.toISOString?.() ?? null,
      };
    });
    if (partnerId) {
      rows = rows.filter((row) => row.partnerId === partnerId);
    }
    if (typeList && typeList.length) {
      rows = rows.filter((row) => typeList.includes(row.type));
    }
    return rows;
  }
}

/**
 * @param {Array<Object>} rows
 * @param {number} fromMs
 * @param {number} toMs
 * @returns {Array<Object>}
 */
function filterRowsByPeriod(rows, fromMs, toMs) {
  return rows.filter((row) => inRangeMs(isoToMs(row.createdAt), fromMs, toMs));
}

/**
 * @param {Array<Object>} rows
 * @returns {{ amount: number, currency: string }}
 */
function sumCollectedPayments(rows) {
  let amount = 0;
  let currency = "KES";
  for (const row of rows) {
    if (row.type !== "b2b_payment" && row.type !== "funding" && row.type !== "topup") {
      continue;
    }
    if (String(row.status || "").toLowerCase() !== "completed") {
      continue;
    }
    amount += Number(row.amount) || 0;
    if (row.currency) {
      currency = String(row.currency).toUpperCase();
    }
  }
  return { amount: round2(amount), currency };
}

/**
 * @param {number} n
 * @returns {number}
 */
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * @param {Array<Object>} rows
 * @returns {number}
 */
function sumKesCompleted(rows) {
  let total = 0;
  for (const row of rows) {
    if (String(row.status || "").toLowerCase() !== "completed") {
      continue;
    }
    const cur = String(row.currency || "").toUpperCase();
    if (cur === "KES") {
      total += Number(row.amount) || 0;
    }
    const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
    if (Number.isFinite(Number(meta.amountKes))) {
      total += Number(meta.amountKes);
    }
  }
  return round2(total);
}

/**
 * @param {Array<Object>} rows
 * @param {Date} from
 * @param {Date} to
 * @returns {Array<{ date: string, amount: number, count: number }>}
 */
function bucketSalesByDay(rows, from, to) {
  /** @type {Map<string, { amount: number, count: number }>} */
  const buckets = new Map();
  const fromMs = from.getTime();
  const toMs = to.getTime();

  for (const row of rows) {
    if (row.type !== "b2b_payment" && row.type !== "funding" && row.type !== "topup") {
      continue;
    }
    const ms = isoToMs(row.createdAt);
    if (!inRangeMs(ms, fromMs, toMs)) {
      continue;
    }
    const day = new Date(ms).toISOString().slice(0, 10);
    const prev = buckets.get(day) || { amount: 0, count: 0 };
    prev.amount += Number(row.amount) || 0;
    prev.count += 1;
    buckets.set(day, prev);
  }

  const out = [];
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);
  while (cursor <= end) {
    const key = cursor.toISOString().slice(0, 10);
    const bucket = buckets.get(key) || { amount: 0, count: 0 };
    out.push({
      date: key,
      amount: round2(bucket.amount),
      count: bucket.count,
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

/**
 * @param {Object} payment
 * @returns {Object}
 */
function formatRecentSendRow(payment) {
  const snap = payment.recipientSnapshot && typeof payment.recipientSnapshot === "object" ?
    payment.recipientSnapshot :
    {};
  return {
    id: payment.id,
    date: payment.createdAt || null,
    reference: payment.paymentReference || payment.id,
    merchant: snap.displayName || snap.name || snap.businessName || "Merchant",
    sent: {
      amount: Number(payment.youSend) || 0,
      currency: payment.fromCurrency || null,
    },
    received: {
      amount: Number(payment.recipientGets) || 0,
      currency: payment.toCurrency || null,
    },
    status: payment.status || "pending",
    partnerId: payment.partnerId || null,
    partnerName: payment.partnerName || null,
  };
}

/**
 * @param {Object} row
 * @returns {Object}
 */
function formatRecentCollectionRow(row) {
  const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const currency = String(row.currency || "KES").toUpperCase();
  const amount = Number(row.amount) || 0;
  let kesEquivalent = null;
  if (currency === "KES") {
    kesEquivalent = amount;
  } else if (Number.isFinite(Number(meta.amountKes))) {
    kesEquivalent = Number(meta.amountKes);
  }

  return {
    id: row.id,
    date: row.createdAt || null,
    guestOrBookingRef:
      meta.bookingReference ||
      meta.reference ||
      meta.invoiceId ||
      row.id,
    payerName: meta.payerName || meta.guestName || null,
    currency,
    amount,
    kesEquivalent,
    status: row.status || "unknown",
    linkId: meta.linkId || null,
    partnerId: row.partnerId || null,
    type: row.type,
  };
}

/**
 * @param {Object} row
 * @returns {Object}
 */
function formatActivityItem(row) {
  const titles = {
    b2b_payment: "Payment collected",
    b2b_funding: "Wallet funded",
    b2b_send: "Send payment",
    b2b_admin_topup: "Admin top-up",
    settlement: "Settlement",
    funding: "Consumer top-up",
    topup: "Consumer top-up",
    merchant_payment: "Merchant payment",
    withdrawal: "Withdrawal",
  };
  const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const amount = Number(row.amount) || 0;
  const currency = row.currency || "";
  return {
    id: row.id,
    type: row.type,
    title: titles[row.type] || row.type || "Activity",
    message: `${amount} ${currency}`.trim(),
    createdAt: row.createdAt || null,
    status: row.status || null,
    partnerId: row.partnerId || null,
    userId: row.userId || null,
    metadata: meta,
  };
}

/**
 * @param {string|null} partnerId
 * @returns {Promise<{ count: number, amount: number, currency: string }>}
 */
async function getPendingSettlementsSummary(partnerId) {
  let query = collection(SETTLEMENTS_COL).orderBy("createdAt", "desc").limit(500);
  if (partnerId) {
    query = query.where("partnerId", "==", String(partnerId));
  }

  let docs;
  try {
    docs = (await query.get()).docs;
  } catch (err) {
    const snap = await collection(SETTLEMENTS_COL).limit(500).get();
    docs = snap.docs.filter((doc) => {
      if (!partnerId) {
        return true;
      }
      return doc.data().partnerId === partnerId;
    });
  }

  let count = 0;
  let amount = 0;
  for (const doc of docs) {
    const d = doc.data();
    if (!PENDING_SETTLEMENT_STATUSES.has(String(d.status || ""))) {
      continue;
    }
    count += 1;
    if (String(d.currency || "KES").toUpperCase() === "KES") {
      amount += Number(d.amount) || 0;
    }
  }

  return { count, amount: round2(amount), currency: "KES" };
}

/**
 * @param {string|null} partnerId
 * @param {number} limit
 * @returns {Promise<Array<Object>>}
 */
async function getRecentSends(partnerId, limit = 10) {
  if (partnerId) {
    const { payments } = await b2bSendService.listSendPayments(partnerId, { limit });
    return payments.map(formatRecentSendRow);
  }

  const snap = await collection(SEND_COL).limit(Math.min(limit * 20, 400)).get();
  const payments = snap.docs
      .map((d) => b2bSendService.serializePayment(d.id, d.data() || {}))
      .sort((a, b) => isoToMs(b.createdAt) - isoToMs(a.createdAt))
      .slice(0, limit);
  return payments.map(formatRecentSendRow);
}

/**
 * @param {Object} params
 * @returns {Promise<Object>}
 */
async function getPartnerDashboard(params) {
  const {
    partnerId = null,
    platformScope = false,
    channel = "b2b",
    periodKey = "month",
    activityUserId = null,
    sendsLimit = 10,
    collectionsLimit = 10,
    activityLimit = 15,
  } = params;

  const period = resolveDashboardPeriod(periodKey);
  const { fromMs, toMs } = periodBounds(period.from, period.to);
  const prevBounds = periodBounds(period.previousFrom, period.previousTo);
  const types = resolveDashboardTypes(channel, platformScope);

  const allRows = await loadDashboardTransactions({
    partnerId: platformScope && !partnerId ? null : partnerId,
    types,
  });

  const currentRows = filterRowsByPeriod(allRows, fromMs, toMs);
  const previousRows = filterRowsByPeriod(
      allRows,
      prevBounds.fromMs,
      prevBounds.toMs,
  );

  const collected = sumCollectedPayments(currentRows);
  const kesSettled = sumKesCompleted(currentRows);
  const pendingSettlements = await getPendingSettlementsSummary(partnerId);

  const completedPayments = currentRows.filter(
      (r) => COLLECTION_TYPES.includes(r.type) &&
        String(r.status).toLowerCase() === "completed",
  );

  const summary = {
    totalPaymentsCollected: collected,
    kesSettled: { amount: kesSettled, currency: "KES" },
    transactionCount: currentRows.length,
    completedPaymentCount: completedPayments.length,
    pendingSettlements,
    conversionRate: currentRows.length ?
      round2((completedPayments.length / currentRows.length) * 100) :
      0,
  };

  const salesChart = {
    granularity: "day",
    current: bucketSalesByDay(allRows, period.from, period.to),
    previous: bucketSalesByDay(allRows, period.previousFrom, period.previousTo),
  };

  const collectionRows = allRows
      .filter((r) => COLLECTION_TYPES.includes(r.type) ||
        (platformScope && (r.type === "funding" || r.type === "topup")))
      .sort((a, b) => isoToMs(b.createdAt) - isoToMs(a.createdAt))
      .slice(0, collectionsLimit);

  const recentCollections = collectionRows.map(formatRecentCollectionRow);
  const recentSends = await getRecentSends(partnerId, sendsLimit);

  const activityFromTx = allRows
      .slice(0, activityLimit)
      .map(formatActivityItem);

  let notifications = [];
  if (activityUserId) {
    try {
      notifications = await getUserNotifications(activityUserId, activityLimit);
    } catch (notifErr) {
      console.warn("getPartnerDashboard notifications:", notifErr.message);
    }
  }

  const activityFeed = [
    ...notifications.map((n) => ({
      id: n.id,
      type: n.type || "notification",
      title: n.title || "Notification",
      message: n.message || "",
      createdAt: n.createdAt || null,
      read: Boolean(n.read),
      source: "notification",
    })),
    ...activityFromTx.map((a) => ({ ...a, source: "transaction" })),
  ]
      .sort((a, b) => isoToMs(b.createdAt) - isoToMs(a.createdAt))
      .slice(0, activityLimit);

  return {
    scope: platformScope ? "platform" : "partner",
    partnerId: partnerId || null,
    channel: platformScope ? String(channel || "b2b").toLowerCase() : "b2b",
    period: {
      key: period.key,
      label: period.label,
      from: period.from.toISOString(),
      to: period.to.toISOString(),
      previousFrom: period.previousFrom.toISOString(),
      previousTo: period.previousTo.toISOString(),
    },
    summary,
    salesChart,
    recentSends,
    recentCollections,
    activityFeed,
  };
}

module.exports = {
  resolveDashboardPeriod,
  resolveDashboardTypes,
  getPartnerDashboard,
  formatRecentSendRow,
  formatRecentCollectionRow,
};
