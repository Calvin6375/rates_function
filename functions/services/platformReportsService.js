/**
 * @fileoverview Reports: TruePay revenue = service fees on collection, pay, send, exchange.
 */

const config = require("../config");
const {collection} = require("../libs/firestore");
const {
  resolveDashboardPeriod,
  loadDashboardTransactions,
} = require("./b2bPortalDashboardService");

const REPORT_CATEGORIES = Object.freeze(["collection", "pay", "send", "exchange"]);
const SCAN_LIMIT = 2500;

/**
 * @param {number} n
 * @returns {number}
 */
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * @param {string|null|undefined} iso
 * @returns {number}
 */
function isoToMs(iso) {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function toIso(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return null;
}

/**
 * @param {string} status
 * @returns {boolean}
 */
function isCompleted(status) {
  const s = String(status || "").toLowerCase();
  return s === "completed" || s === "success";
}

/**
 * TruePay take (not face amount, not rail paymentFee).
 * @param {Object} row
 * @returns {number}
 */
function extractServiceFee(row) {
  const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const fees = meta.fees && typeof meta.fees === "object" ? meta.fees : {};
  const rowFees = row.fees && typeof row.fees === "object" ? row.fees : {};
  const candidates = [
    meta.platformFee,
    meta.feeAmount,
    fees.ourFee,
    rowFees.ourFee,
    row.fee,
    row.feeAmount,
    row.platformFee,
    meta.fee,
  ];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/**
 * @param {Object} row
 * @param {number} fee
 * @returns {{ kes: number, currency: string, unconverted: number }}
 */
function feeAsKes(row, fee) {
  const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const currency = String(
      row.feeCurrency ||
      meta.fees?.currency ||
      row.fees?.currency ||
      row.currency ||
      "KES",
  ).toUpperCase();
  if (currency === "KES") {
    return {kes: fee, currency, unconverted: 0};
  }
  const fx = Number(meta.fxRate || row.fxRate || row.exchangeRate || 0);
  if (Number.isFinite(fx) && fx > 0) {
    return {kes: round2(fee * fx), currency, unconverted: 0};
  }
  return {kes: 0, currency, unconverted: fee};
}

/**
 * @param {Object} row
 * @returns {string|null}
 */
function classifyReportCategory(row) {
  const type = String(row.type || row.orderType || "").toLowerCase();
  const typeU = String(row.type || "").toUpperCase();
  const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const payoutType = String(meta.type || meta.payoutType || row.payoutType || "").toUpperCase();

  if (type === "b2b_payment") return "collection";
  if (type === "merchant_payment") return "pay";
  if (type === "swap") return "exchange";
  if (type === "b2b_send") return "send";
  if (typeU === "MPESA_B2B" || payoutType === "MPESA_B2B") return "pay";
  if (typeU === "MPESA_B2C" || typeU === "BANK" || typeU === "SAFARITAP_WALLET") {
    return "send";
  }
  if (payoutType === "MPESA_B2C" || payoutType === "BANK" || payoutType === "SAFARITAP_WALLET") {
    return "send";
  }
  if (type === "withdrawal") {
    if (payoutType === "MPESA_B2B") return "pay";
    const source = String(meta.source || "").toLowerCase();
    if (source === "safari_card_payout" || source === "safaritap_wallet_transfer") {
      return "send";
    }
  }
  return null;
}

/**
 * @param {string} key
 * @returns {{ revenue: number, count: number, unconverted: number, currency: string }}
 */
function emptyBucket() {
  return {revenue: 0, count: 0, unconverted: 0, currency: "KES"};
}

/**
 * @param {Array<Object>} events
 * @param {number} fromMs
 * @param {number} toMs
 * @returns {{
 *   totalRevenue: number,
 *   breakdown: Object,
 *   transactionCount: number,
 *   completedCount: number,
 *   buckets: Array<{ date: string, amount: number, count: number }>,
 * }}
 */
function aggregateFeeEvents(events, fromMs, toMs) {
  const breakdown = {
    collection: emptyBucket(),
    pay: emptyBucket(),
    send: emptyBucket(),
    exchange: emptyBucket(),
  };
  /** @type {Map<string, { amount: number, count: number }>} */
  const byDay = new Map();
  let totalRevenue = 0;
  let classifiedCount = 0;
  let completedCount = 0;

  for (const event of events) {
    const ms = isoToMs(event.createdAt);
    if (!ms || ms < fromMs || ms > toMs) continue;
    if (!isCompleted(event.status)) continue;
    const category = classifyReportCategory(event);
    if (!category || !breakdown[category]) continue;
    classifiedCount += 1;
    const fee = extractServiceFee(event);
    if (fee <= 0) {
      continue;
    }

    const {kes, unconverted} = feeAsKes(event, fee);
    breakdown[category].revenue = round2(breakdown[category].revenue + kes);
    breakdown[category].unconverted = round2(breakdown[category].unconverted + unconverted);
    breakdown[category].count += 1;
    totalRevenue = round2(totalRevenue + kes);
    completedCount += 1;

    const day = new Date(ms).toISOString().slice(0, 10);
    const prev = byDay.get(day) || {amount: 0, count: 0};
    prev.amount = round2(prev.amount + kes);
    prev.count += 1;
    byDay.set(day, prev);
  }

  return {totalRevenue, breakdown, classifiedCount, completedCount, byDay};
}

/**
 * @param {Map<string, { amount: number, count: number }>} byDay
 * @param {Date} from
 * @param {Date} to
 * @returns {Array<{ date: string, amount: number, count: number }>}
 */
function fillDays(byDay, from, to) {
  const out = [];
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);
  while (cursor <= end) {
    const key = cursor.toISOString().slice(0, 10);
    const bucket = byDay.get(key) || {amount: 0, count: 0};
    out.push({date: key, amount: round2(bucket.amount), count: bucket.count});
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

/**
 * @param {string} colName
 * @param {number} [limit]
 * @returns {Promise<Array<{ id: string, data: Object }>>}
 */
async function scanRecent(colName, limit = SCAN_LIMIT) {
  try {
    const snap = await collection(colName).orderBy("createdAt", "desc").limit(limit).get();
    return snap.docs.map((doc) => ({id: doc.id, data: doc.data() || {}}));
  } catch (err) {
    const snap = await collection(colName).limit(limit).get();
    return snap.docs.map((doc) => ({id: doc.id, data: doc.data() || {}}));
  }
}

/**
 * @param {{ partnerId?: string|null, platformScope?: boolean }} opts
 * @returns {Promise<Object[]>}
 */
async function loadReportSourceEvents(opts) {
  const partnerId = opts.partnerId || null;
  const platformScope = Boolean(opts.platformScope);
  const events = [];
  const seen = new Set();

  const add = (row, idHint) => {
    const key = row.metadata?.payoutId ||
      row.metadata?.paymentId ||
      row.payoutId ||
      row.id ||
      idHint;
    if (key && seen.has(String(key))) return;
    if (key) seen.add(String(key));
    events.push(row);
  };

  const txTypes = platformScope ?
    [
      "b2b_payment",
      "b2b_send",
      "merchant_payment",
      "withdrawal",
    ] :
    ["b2b_payment", "b2b_send"];

  const txRows = await loadDashboardTransactions({
    partnerId: platformScope && !partnerId ? null : partnerId,
    types: txTypes,
    scanLimit: SCAN_LIMIT,
  });
  for (const row of txRows) {
    add({
      ...row,
      createdAt: row.createdAt,
    }, row.id);
  }

  if (platformScope) {
    const payouts = await scanRecent(config.collections.safariCardPayouts || "safariCardPayouts");
    for (const {id, data} of payouts) {
      add({
        id,
        type: data.type,
        status: data.status,
        fee: data.fee,
        feeAmount: data.fee,
        currency: data.currency,
        createdAt: toIso(data.createdAt || data.completedAt),
        metadata: {
          type: data.type,
          payoutType: data.type,
          payoutId: id,
          source: "safari_card_payout",
        },
      }, id);
    }

    const orders = await scanRecent(config.collections.orders || "orders");
    for (const {id, data} of orders) {
      if (String(data.orderType || data.type || "").toLowerCase() !== "swap") continue;
      add({
        id,
        type: "swap",
        orderType: "swap",
        status: data.status,
        fee: data.fee,
        feeAmount: data.fee,
        feeCurrency: data.feeCurrency,
        currency: data.fromCurrency || data.feeCurrency,
        fxRate: data.exchangeRate,
        exchangeRate: data.exchangeRate,
        createdAt: toIso(data.createdAt),
        metadata: data.metadata || {},
      }, id);
    }
  }

  const sendCol = config.collections.partnerSendPayments || "partnerSendPayments";
  const sends = await scanRecent(sendCol);
  for (const {id, data} of sends) {
    if (partnerId && String(data.partnerId || "") !== String(partnerId)) continue;
    add({
      id,
      type: "b2b_send",
      status: data.status,
      fees: data.fees,
      currency: data.fromCurrency,
      createdAt: toIso(data.createdAt || data.completedAt),
      metadata: {
        paymentId: id,
        fees: data.fees,
      },
    }, id);
  }

  return events;
}

/**
 * @param {Object} params
 * @returns {Promise<Object>}
 */
async function getRevenueReport(params) {
  const {
    partnerId = null,
    platformScope = false,
    periodKey = "month",
  } = params;

  const period = resolveDashboardPeriod(periodKey);
  const fromMs = period.from.getTime();
  const toMs = period.to.getTime();
  const prevFromMs = period.previousFrom.getTime();
  const prevToMs = period.previousTo.getTime();

  const events = await loadReportSourceEvents({partnerId, platformScope});
  const current = aggregateFeeEvents(events, fromMs, toMs);
  const previous = aggregateFeeEvents(events, prevFromMs, prevToMs);

  const revenueByChannel = REPORT_CATEGORIES.map((key) => ({
    key,
    label: key === "pay" ? "Pay" : key.charAt(0).toUpperCase() + key.slice(1),
    revenue: current.breakdown[key].revenue,
    count: current.breakdown[key].count,
    currency: "KES",
  }));

  const activityMix = revenueByChannel.map((row) => ({
    key: row.key,
    label: row.label,
    count: row.count,
    revenue: row.revenue,
  }));

  const averageFee = current.completedCount ?
    round2(current.totalRevenue / current.completedCount) :
    0;
  const conversionRate = current.classifiedCount ?
    round2((current.completedCount / current.classifiedCount) * 100) :
    0;

  return {
    scope: platformScope ? "platform" : "partner",
    partnerId: partnerId || null,
    period: {
      key: period.key,
      label: period.label,
      from: period.from.toISOString(),
      to: period.to.toISOString(),
      previousFrom: period.previousFrom.toISOString(),
      previousTo: period.previousTo.toISOString(),
    },
    currency: "KES",
    revenueMeaning: "service_fee",
    summary: {
      totalRevenue: current.totalRevenue,
      previousRevenue: previous.totalRevenue,
      transactionCount: current.classifiedCount,
      completedCount: current.completedCount,
      conversionRate,
      averageOrder: averageFee,
      averageFee,
    },
    kpis: {
      totalRevenue: {
        amount: current.totalRevenue,
        currency: "KES",
        previousAmount: previous.totalRevenue,
      },
      transactions: {
        count: current.classifiedCount,
        completedCount: current.completedCount,
      },
      conversionRate,
      averageOrder: {
        amount: averageFee,
        currency: "KES",
      },
    },
    breakdown: current.breakdown,
    revenueByChannel,
    activityMix,
    salesChart: {
      granularity: "day",
      current: fillDays(current.byDay, period.from, period.to),
      previous: fillDays(previous.byDay, period.previousFrom, period.previousTo),
    },
  };
}

module.exports = {
  REPORT_CATEGORIES,
  extractServiceFee,
  classifyReportCategory,
  getRevenueReport,
};
