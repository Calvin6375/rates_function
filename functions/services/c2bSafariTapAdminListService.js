/**
 * @fileoverview Admin list for Safari Tap (C2B) dashboard tabs:
 * Topups | Pay | Send | Exchange.
 *
 * Merges transactionRecords, orders, fundingOrders, and safariCardPayouts into
 * one row shape for the admin UI.
 */

const admin = require("../admin");
const config = require("../config");
const {collection} = require("../libs/firestore");
const {dedupeSafariTapAdminRows} = require("../utils/transactionDedupe");
const {resolveFundingDisplayMoney} = require("../utils/fundingTypes");

const firestore = admin.firestore();

const METHOD_TYPES = Object.freeze({
  TOPUPS: "topups",
  PAY: "pay",
  SEND: "send",
  EXCHANGE: "exchange",
});

const CHANNEL = "C2B";
const MAX_SCAN = 1500;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeMethodType(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return null;
  if (s === "topup" || s === "top-ups" || s === "top_ups") return METHOD_TYPES.TOPUPS;
  if (s === "topups") return METHOD_TYPES.TOPUPS;
  if (s === "pay" || s === "payment" || s === "payments") return METHOD_TYPES.PAY;
  if (s === "send" || s === "sends" || s === "payout" || s === "payouts") {
    return METHOD_TYPES.SEND;
  }
  if (s === "exchange" || s === "exchanges" || s === "swap" || s === "swaps") {
    return METHOD_TYPES.EXCHANGE;
  }
  return null;
}

/**
 * Period presets matching the Safari Tap admin UI.
 * @param {string} [periodKey]
 * @param {{ startDate?: string, endDate?: string }} [custom]
 * @returns {{ key: string, label: string, from: Date, to: Date }}
 */
function resolveSafariTapPeriod(periodKey, custom = {}) {
  const key = String(periodKey || "30d").toLowerCase();
  const to = new Date();
  const from = new Date(to);

  if (key === "today") {
    from.setHours(0, 0, 0, 0);
    return {key: "today", label: "Today", from, to};
  }
  if (key === "7d") {
    from.setDate(from.getDate() - 7);
    return {key: "7d", label: "Last 7 days", from, to};
  }
  if (key === "30d") {
    from.setDate(from.getDate() - 30);
    return {key: "30d", label: "Last 30 days", from, to};
  }
  if (key === "month") {
    from.setDate(1);
    from.setHours(0, 0, 0, 0);
    return {key: "month", label: "This month", from, to};
  }
  if (key === "custom") {
    const start = custom.startDate ? new Date(custom.startDate) : null;
    const end = custom.endDate ? new Date(custom.endDate) : null;
    if (!start || Number.isNaN(start.getTime()) || !end || Number.isNaN(end.getTime())) {
      const err = new Error("period=custom requires valid startDate and endDate (ISO)");
      err.code = "VALIDATION_FAILED";
      err.httpStatus = 400;
      throw err;
    }
    end.setHours(23, 59, 59, 999);
    return {key: "custom", label: "Custom", from: start, to: end};
  }

  from.setDate(from.getDate() - 30);
  return {key: "30d", label: "Last 30 days", from, to};
}

/**
 * @param {FirebaseFirestore.Timestamp|Date|string|null|undefined} value
 * @returns {number}
 */
function toMs(value) {
  if (!value) return 0;
  if (typeof value.toDate === "function") return value.toDate().getTime();
  if (typeof value.toMillis === "function") return value.toMillis();
  const d = value instanceof Date ? value : new Date(value);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * @param {FirebaseFirestore.Timestamp|Date|string|null|undefined} value
 * @returns {string|null}
 */
function toIso(value) {
  const ms = toMs(value);
  return ms ? new Date(ms).toISOString() : null;
}

/**
 * @param {Object|null|undefined} user
 * @param {string|null|undefined} uid
 * @returns {string}
 */
function displayNameFromUser(user, uid) {
  if (user && typeof user === "object") {
    const name = user.name ||
      [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
      user.displayName ||
      null;
    if (name) return name;
    if (user.email) return String(user.email);
    if (user.phoneNumber || user.phone) return String(user.phoneNumber || user.phone);
  }
  if (uid) return `User ${String(uid).slice(0, 8)}`;
  return "Unknown";
}

/**
 * @param {string[]} userIds
 * @returns {Promise<Map<string, Object>>}
 */
async function loadUsersByIds(userIds) {
  const map = new Map();
  const unique = [...new Set(userIds.filter(Boolean))];
  const chunkSize = 30;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    await Promise.all(chunk.map(async (uid) => {
      try {
        const snap = await firestore.collection(config.collections.users).doc(uid).get();
        if (snap.exists) {
          map.set(uid, {id: uid, ...snap.data()});
        }
      } catch (_err) {
        // ignore missing users
      }
    }));
  }
  return map;
}

/**
 * @param {Object} params
 * @returns {Object}
 */
/**
 * Provider / ledger failure copy for Failed rows.
 * @param {Object|null|undefined} data
 * @returns {string|null}
 */
function resolveFailureReason(data) {
  const meta = data && data.metadata && typeof data.metadata === "object" ? data.metadata : {};
  const candidates = [
    data && data.failureReason,
    data && data.statusReason,
    data && data.status_description,
    data && data.errorMessage,
    data && data.error,
    meta.failureReason,
    meta.reason,
    meta.error,
    meta.gatewayResponse,
    meta.gateway_response,
  ];
  for (const value of candidates) {
    const s = String(value == null ? "" : value).trim();
    if (s) return s;
  }
  return null;
}

function buildRow(params) {
  const {
    id,
    orderId = null,
    clientName = null,
    recipientName = null,
    date = null,
    type = null,
    amount = null,
    currency = "KES",
    phone = null,
    channel = CHANNEL,
    status = null,
    userId = null,
    method = null,
    source = null,
    failureReason = null,
    metadata = null,
  } = params;

  return {
    orderId: orderId || id,
    id,
    clientName,
    recipientName,
    date,
    type,
    amount: amount == null ? null : Number(amount),
    currency: currency ? String(currency).toUpperCase() : null,
    phone,
    channel,
    status,
    failureReason: failureReason ? String(failureReason) : null,
    userId,
    method,
    source,
    metadata: metadata && typeof metadata === "object" ? metadata : {},
  };
}

/**
 * @param {Object} row
 * @param {{ from: Date, to: Date }} period
 * @param {{ status?: string|null, currency?: string|null, userId?: string|null }} filters
 * @returns {boolean}
 */
function passesFilters(row, period, filters) {
  const ms = toMs(row.date);
  if (ms < period.from.getTime() || ms > period.to.getTime()) return false;
  if (filters.status && String(row.status || "").toLowerCase() !== String(filters.status).toLowerCase()) {
    return false;
  }
  if (filters.currency &&
      String(row.currency || "").toUpperCase() !== String(filters.currency).toUpperCase()) {
    return false;
  }
  if (filters.userId && row.userId !== filters.userId) return false;
  return true;
}

/**
 * @param {FirebaseFirestore.QuerySnapshot} snap
 * @returns {Array<{ id: string, data: Object }>}
 */
function docsFromSnap(snap) {
  return snap.docs.map((doc) => ({id: doc.id, data: doc.data() || {}}));
}

/**
 * Scan recent docs ordered by createdAt when possible.
 * @param {string} colName
 * @param {number} [limit]
 * @returns {Promise<Array<{ id: string, data: Object }>>}
 */
async function scanRecent(colName, limit = MAX_SCAN) {
  try {
    const snap = await collection(colName).orderBy("createdAt", "desc").limit(limit).get();
    return docsFromSnap(snap);
  } catch (err) {
    console.warn(`c2bSafariTapAdminList: orderBy createdAt failed for ${colName}:`, err.message);
    const snap = await collection(colName).limit(limit).get();
    return docsFromSnap(snap).sort(
        (a, b) => toMs(b.data.createdAt || b.data.updatedAt) - toMs(a.data.createdAt || a.data.updatedAt),
    );
  }
}

/**
 * @param {Map<string, Object>} users
 * @param {string|null} userId
 * @returns {{ name: string|null, phone: string|null }}
 */
function clientFromUserMap(users, userId) {
  const u = userId ? users.get(userId) : null;
  return {
    name: displayNameFromUser(u, userId),
    phone: u ? (u.phoneNumber || u.phone || null) : null,
  };
}

/**
 * @param {Array<{ id: string, data: Object }>} docs
 * @param {Map<string, Object>} users
 * @returns {Object[]}
 */
function mapTopupRows(docs, users) {
  const rows = [];
  for (const {id, data} of docs) {
    const meta = data.metadata && typeof data.metadata === "object" ? data.metadata : {};
    if (String(meta.product || "").toLowerCase() === "b2b_self_topup") continue;

    const type = String(data.type || data.orderType || "funding").toLowerCase();
    const userId = data.userId || null;
    const client = clientFromUserMap(users, userId);
    const source = data.orderType ? "orders" : (data.provider ? "fundingOrders" : "transactionRecords");
    const display = resolveFundingDisplayMoney(data);
    const failureReason = resolveFailureReason(data);
    rows.push(buildRow({
      id,
      orderId: id,
      clientName: client.name,
      recipientName: client.name,
      date: toIso(data.createdAt || data.updatedAt),
      type,
      amount: display.amount,
      currency: display.currency,
      phone: data.phoneNumber || client.phone,
      status: data.status || "unknown",
      failureReason,
      userId,
      method: METHOD_TYPES.TOPUPS,
      source,
      metadata: {
        ...meta,
        fundingOrderId: meta.fundingOrderId || (source === "fundingOrders" ? id : null),
        transactionRecordId: data.transactionRecordId || meta.transactionRecordId || null,
        failureReason: failureReason || meta.failureReason || null,
      },
    }));
  }
  return rows;
}

/**
 * @param {Array<{ id: string, data: Object }>} docs
 * @param {Map<string, Object>} users
 * @returns {Object[]}
 */
function mapPayRows(docs, users) {
  const rows = [];
  for (const {id, data} of docs) {
    const meta = data.metadata && typeof data.metadata === "object" ? data.metadata : {};
    const typeLower = String(data.type || "").toLowerCase();
    const typeUpper = String(data.type || "").toUpperCase();
    const isMerchant = typeLower === "merchant_payment";
    const isB2bPayout = typeUpper === "MPESA_B2B";
    const isProfilePay = typeUpper === "TRUEPAY_MERCHANT" ||
      String(meta.source || "").toLowerCase() === "truepay_merchant_profile";
    if (!isMerchant && !isB2bPayout && !isProfilePay) continue;

    const userId = data.userId || null;
    const client = clientFromUserMap(users, userId);
    const recipient = data.recipient && typeof data.recipient === "object" ? data.recipient : {};
    const tillAccount = recipient.account || recipient.accountNumber || null;
    const isTill = recipient.accountType === "TillNumber" ||
      recipient.account_type === "TillNumber";
    const recipientName = meta.merchantName ||
      data.merchantName ||
      recipient.name ||
      recipient.accountName ||
      (isTill && tillAccount ? `Till ${tillAccount}` : null) ||
      null;

    rows.push(buildRow({
      id,
      orderId: id,
      clientName: client.name,
      recipientName,
      date: toIso(data.createdAt || data.updatedAt || data.completedAt),
      type: isMerchant || isProfilePay ? "merchant_payment" : "MPESA_B2B",
      amount: data.amount,
      currency: data.currency || "KES",
      phone: recipient.phoneNumber || client.phone,
      status: data.status || "unknown",
      failureReason: resolveFailureReason(data),
      userId,
      method: METHOD_TYPES.PAY,
      source: isB2bPayout ? "safariCardPayouts" : "transactionRecords",
      metadata: {
        ...meta,
        recipient,
        payoutId: meta.payoutId || (isB2bPayout ? id : null),
        transactionId: data.transactionId || meta.transactionId || null,
        merchantPaymentId: meta.merchantPaymentId || data.merchantPaymentId || null,
        mpesaReference: meta.mpesaReference || data.providerReference || null,
      },
    }));
  }
  return rows;
}

/**
 * @param {Array<{ id: string, data: Object }>} docs
 * @param {Map<string, Object>} users
 * @returns {Object[]}
 */
function mapSendRows(docs, users) {
  const rows = [];
  for (const {id, data} of docs) {
    const meta = data.metadata && typeof data.metadata === "object" ? data.metadata : {};
    const type = String(data.type || data.orderType || "").toUpperCase();
    const source = String(meta.source || "").toLowerCase();
    const isWallet = type === "SAFARITAP_WALLET" || source === "safaritap_wallet_transfer";
    const isB2c = type === "MPESA_B2C";
    const isBank = type === "BANK";
    const isP2pOrder = String(data.orderType || "").toLowerCase() === "send";
    const payoutKind = String(meta.type || meta.payoutType || "").toUpperCase();
    const isWithdrawalSend = String(data.type || "").toLowerCase() === "withdrawal" &&
      (source === "safaritap_wallet_transfer" ||
        (source === "safari_card_payout" &&
          ["MPESA_B2C", "BANK", "SAFARITAP_WALLET"].includes(payoutKind)));

    if (!isWallet && !isB2c && !isBank && !isP2pOrder && !isWithdrawalSend) {
      continue;
    }
    // Pay tab owns B2B till/paybill
    if (type === "MPESA_B2B") continue;

    const userId = data.userId || null;
    const client = clientFromUserMap(users, userId);
    const recipient = data.recipient && typeof data.recipient === "object" ? data.recipient : {};
    const recipientUserId = data.recipientUserId || meta.recipientUserId || null;
    const recipientUser = recipientUserId ? users.get(recipientUserId) : null;
    const recipientName = meta.recipientName ||
      meta.merchantName ||
      recipient.name ||
      displayNameFromUser(recipientUser, recipientUserId) ||
      recipient.phoneNumber ||
      null;

    const rowSource = data.orderType ? "orders" :
      (data.provider || data.recipient ? "safariCardPayouts" : "transactionRecords");
    rows.push(buildRow({
      id,
      orderId: id,
      clientName: client.name,
      recipientName: recipientName === "Unknown" ? null : recipientName,
      date: toIso(data.createdAt || data.updatedAt || data.completedAt),
      type: data.orderType || data.type || "send",
      amount: data.amount,
      currency: data.currency || "KES",
      phone: recipient.phoneNumber || data.phoneNumber || client.phone,
      status: data.status || "unknown",
      failureReason: resolveFailureReason(data),
      userId,
      method: METHOD_TYPES.SEND,
      source: rowSource,
      metadata: {
        ...meta,
        recipient,
        recipientUserId,
        payoutId: meta.payoutId || (rowSource === "safariCardPayouts" ? id : null),
        transactionId: data.transactionId || meta.transactionId || null,
        mpesaReference: meta.mpesaReference || data.providerReference || null,
      },
    }));
  }
  return rows;
}

/**
 * @param {Array<{ id: string, data: Object }>} docs
 * @param {Map<string, Object>} users
 * @returns {Object[]}
 */
function mapExchangeRows(docs, users) {
  const rows = [];
  for (const {id, data} of docs) {
    const orderType = String(data.orderType || data.type || "").toLowerCase();
    if (orderType !== "swap") continue;

    const userId = data.userId || null;
    const client = clientFromUserMap(users, userId);
    const from = data.fromCurrency || data.metadata?.fromCurrency || null;
    const to = data.toCurrency || data.metadata?.toCurrency || null;
    const typeLabel = from && to ? `swap_${from}_${to}` : "swap";

    rows.push(buildRow({
      id,
      orderId: id,
      clientName: client.name,
      recipientName: to || null,
      date: toIso(data.createdAt || data.updatedAt),
      type: typeLabel,
      amount: data.fromAmount != null ? data.fromAmount : data.amount,
      currency: from || data.currency || "KES",
      phone: client.phone,
      status: data.status || "completed",
      failureReason: resolveFailureReason(data),
      userId,
      method: METHOD_TYPES.EXCHANGE,
      source: "orders",
      metadata: {
        fromCurrency: from,
        toCurrency: to,
        toAmount: data.toAmount != null ? data.toAmount : data.metadata?.toAmount,
        exchangeRate: data.exchangeRate != null ? data.exchangeRate : data.metadata?.exchangeRate,
        quoteId: data.quoteId || null,
      },
    }));
  }
  return rows;
}

/**
 * Collect raw docs for a method tab.
 * @param {string} method
 * @returns {Promise<Array<{ id: string, data: Object }>>}
 */
async function collectDocsForMethod(method) {
  if (method === METHOD_TYPES.TOPUPS) {
    const [txr, funding, orders] = await Promise.all([
      scanRecent(config.collections.transactionRecords),
      scanRecent(config.collections.fundingOrders),
      scanRecent(config.collections.orders),
    ]);
    const fundingFiltered = funding.filter((d) => {
      const product = String(d.data.metadata?.product || "").toLowerCase();
      return product !== "b2b_self_topup" && product !== "b2b";
    });
    const orderFiltered = orders.filter((d) => {
      const ot = String(d.data.orderType || "").toLowerCase();
      return ot === "topup" || ot === "direct_topup";
    });
    const txrFiltered = txr.filter((d) => {
      const t = String(d.data.type || "").toLowerCase();
      return t === "funding" || t === "topup" || t === "crypto_onramp";
    });
    return [...txrFiltered, ...fundingFiltered, ...orderFiltered];
  }

  if (method === METHOD_TYPES.PAY) {
    const [txr, payouts] = await Promise.all([
      scanRecent(config.collections.transactionRecords),
      scanRecent(config.collections.safariCardPayouts),
    ]);
    const txrFiltered = txr.filter((d) => {
      const t = String(d.data.type || "").toLowerCase();
      const src = String(d.data.metadata?.source || "").toLowerCase();
      return t === "merchant_payment" || src === "truepay_merchant_profile";
    });
    const payoutFiltered = payouts.filter((d) => {
      const t = String(d.data.type || "").toUpperCase();
      return t === "MPESA_B2B" || t === "TRUEPAY_MERCHANT";
    });
    return [...txrFiltered, ...payoutFiltered];
  }

  if (method === METHOD_TYPES.SEND) {
    const [txr, payouts, orders] = await Promise.all([
      scanRecent(config.collections.transactionRecords),
      scanRecent(config.collections.safariCardPayouts),
      scanRecent(config.collections.orders),
    ]);
    const payoutFiltered = payouts.filter((d) => {
      const t = String(d.data.type || "").toUpperCase();
      return t === "SAFARITAP_WALLET" || t === "MPESA_B2C" || t === "BANK";
    });
    const txrFiltered = txr.filter((d) => {
      const t = String(d.data.type || "").toLowerCase();
      const src = String(d.data.metadata?.source || "").toLowerCase();
      return t === "withdrawal" &&
        (src === "safaritap_wallet_transfer" || src === "safari_card_payout");
    });
    const orderFiltered = orders.filter((d) => String(d.data.orderType || "").toLowerCase() === "send");
    return [...payoutFiltered, ...txrFiltered, ...orderFiltered];
  }

  if (method === METHOD_TYPES.EXCHANGE) {
    const orders = await scanRecent(config.collections.orders);
    return orders.filter((d) => String(d.data.orderType || "").toLowerCase() === "swap");
  }

  return [];
}

/**
 * @param {Object} query
 * @returns {Promise<{
 *   method: string,
 *   period: Object,
 *   transactions: Object[],
 *   pagination: Object,
 * }>}
 */
async function listSafariTapTransactions(query = {}) {
  const method = normalizeMethodType(query.type || query.method);
  if (!method) {
    const err = new Error(
        "Query param type (or method) is required: topups | pay | send | exchange",
    );
    err.code = "VALIDATION_FAILED";
    err.httpStatus = 400;
    throw err;
  }

  const period = resolveSafariTapPeriod(query.period, {
    startDate: query.startDate,
    endDate: query.endDate,
  });

  const limit = Math.min(
      Math.max(parseInt(String(query.limit || DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, 1),
      MAX_LIMIT,
  );
  const startAfter = query.startAfter ? String(query.startAfter).trim() : null;
  const filters = {
    status: query.status ? String(query.status).trim() : null,
    currency: query.currency ? String(query.currency).trim().toUpperCase() : null,
    userId: query.userId ? String(query.userId).trim() : null,
  };
  const search = query.search || query.q ?
    String(query.search || query.q).trim().toLowerCase() :
    null;

  const docs = await collectDocsForMethod(method);
  const userIds = [];
  for (const {data} of docs) {
    if (data.userId) userIds.push(data.userId);
    if (data.recipientUserId) userIds.push(data.recipientUserId);
    if (data.metadata?.recipientUserId) userIds.push(data.metadata.recipientUserId);
    if (data.metadata?.senderUserId) userIds.push(data.metadata.senderUserId);
  }
  const users = await loadUsersByIds(userIds);

  let rows = [];
  if (method === METHOD_TYPES.TOPUPS) rows = mapTopupRows(docs, users);
  else if (method === METHOD_TYPES.PAY) rows = mapPayRows(docs, users);
  else if (method === METHOD_TYPES.SEND) rows = mapSendRows(docs, users);
  else if (method === METHOD_TYPES.EXCHANGE) rows = mapExchangeRows(docs, users);

  rows = rows.filter((row) => passesFilters(row, period, filters));

  if (search) {
    rows = rows.filter((row) => {
      const hay = [
        row.orderId,
        row.clientName,
        row.recipientName,
        row.phone,
        row.type,
        row.status,
        row.failureReason,
        row.userId,
      ].map((v) => String(v || "").toLowerCase()).join(" ");
      return hay.includes(search);
    });
  }

  // Same event is stored as txr_ + fund_ / safariCardPayout with different ids.
  rows = dedupeSafariTapAdminRows(rows, method);
  const seen = new Set();
  rows = rows.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });

  rows.sort((a, b) => toMs(b.date) - toMs(a.date));

  let startIdx = 0;
  if (startAfter) {
    const idx = rows.findIndex((r) => r.id === startAfter || r.orderId === startAfter);
    startIdx = idx >= 0 ? idx + 1 : 0;
  }
  const window = rows.slice(startIdx, startIdx + limit + 1);
  const hasMore = window.length > limit;
  const page = hasMore ? window.slice(0, limit) : window;
  const last = page.length ? page[page.length - 1] : null;

  return {
    method,
    period: {
      key: period.key,
      label: period.label,
      from: period.from.toISOString(),
      to: period.to.toISOString(),
    },
    transactions: page,
    pagination: {
      limit,
      count: page.length,
      totalMatched: rows.length,
      hasMore,
      startAfter: last ? last.id : null,
    },
  };
}

module.exports = {
  METHOD_TYPES,
  normalizeMethodType,
  resolveSafariTapPeriod,
  listSafariTapTransactions,
  buildRow,
  resolveFailureReason,
};
