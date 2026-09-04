/**
 * @fileoverview Collapse duplicate history rows that represent one financial event
 * across transactionRecords (txr_), fundingOrders (fund_), safariCardPayouts,
 * and legacy transactions/{uid}/transactions (tx_).
 */

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function nonEmptyString(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s : null;
}

/**
 * Linking keys for one logical event. Rows that share any key are the same event.
 * Own document id is included only when it is a known foreign-key shape, so two
 * unrelated rows never collapse just because they have unique ids.
 *
 * @param {Object} row
 * @returns {string[]}
 */
function collectLinkKeys(row) {
  if (!row || typeof row !== "object") return [];
  const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const id = nonEmptyString(row.id || row.orderId);
  const source = String(row.source || "").toLowerCase();
  const keys = new Set();

  const add = (prefix, value) => {
    const v = nonEmptyString(value);
    if (v) keys.add(`${prefix}:${v}`);
  };

  add("payout", meta.payoutId || row.payoutId);
  add("funding", meta.fundingOrderId || row.fundingOrderId);
  add("mp", meta.merchantPaymentId || row.merchantPaymentId);
  add("txr", meta.transactionRecordId || row.transactionRecordId);
  add("txr", meta.transactionId || row.transactionId);
  add(
      "mpesa",
      meta.mpesaReference ||
      meta.providerReference ||
      row.mpesaReference ||
      row.providerReference,
  );

  if (id) {
    if (id.startsWith("txr_")) add("txr", id);
    if (id.startsWith("fund_")) add("funding", id);
    if (id.startsWith("funding_order_")) add("funding", id.slice("funding_order_".length));
    if (source === "safaricardpayouts" || source === "safari_card_payouts") {
      add("payout", id);
    }
    if (source === "fundingorders" || source === "funding_orders") {
      add("funding", id);
    }
  }

  return [...keys];
}

/**
 * Union-find parent index.
 * @param {number[]} parent
 * @param {number} i
 * @returns {number}
 */
function findRoot(parent, i) {
  let cur = i;
  while (parent[cur] !== cur) {
    parent[cur] = parent[parent[cur]];
    cur = parent[cur];
  }
  return cur;
}

/**
 * Default: keep the first row in each group (caller should sort by preference).
 * @param {Object[]} group
 * @returns {Object}
 */
function firstRow(group) {
  return group[0];
}

/**
 * Collapse rows that share a payout / funding / merchant / mpesa / txr link.
 *
 * @param {Object[]} rows
 * @param {(group: Object[]) => Object} [pickWinner]
 * @returns {Object[]}
 */
function dedupeLinkedRecords(rows, pickWinner = firstRow) {
  if (!Array.isArray(rows) || rows.length <= 1) {
    return Array.isArray(rows) ? rows : [];
  }

  const parent = rows.map((_, i) => i);
  /** @type {Map<string, number>} */
  const keyOwner = new Map();

  for (let i = 0; i < rows.length; i++) {
    const keys = collectLinkKeys(rows[i]);
    for (const key of keys) {
      if (!keyOwner.has(key)) {
        keyOwner.set(key, i);
        continue;
      }
      const a = findRoot(parent, i);
      const b = findRoot(parent, keyOwner.get(key));
      if (a !== b) parent[a] = b;
    }
  }

  /** @type {Map<number, Object[]>} */
  const groups = new Map();
  for (let i = 0; i < rows.length; i++) {
    const root = findRoot(parent, i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(rows[i]);
  }

  const out = [];
  for (const group of groups.values()) {
    out.push(pickWinner(group) || group[0]);
  }
  return out;
}

/**
 * Rank Safari Tap admin rows: prefer the richer operational document.
 * Send/Pay → payout doc (recipient + rail type). Topups → ledger txr over fund_.
 *
 * @param {Object} row
 * @param {string} method
 * @returns {number}
 */
function safariTapSourceRank(row, method) {
  const source = String(row.source || "");
  const status = String(row.status || "").toLowerCase();
  const completedBonus = status === "completed" || status === "success" ? 1 : 0;
  if (method === "send" || method === "pay") {
    if (source === "safariCardPayouts") return 40 + completedBonus;
    if (source === "transactionRecords") return 20 + completedBonus;
    return 10 + completedBonus;
  }
  if (method === "topups") {
    if (source === "transactionRecords") return 40 + completedBonus;
    if (source === "orders") return 20 + completedBonus;
    if (source === "fundingOrders") return 10 + completedBonus;
    return 5;
  }
  return completedBonus;
}

/**
 * @param {Object[]} rows
 * @param {string} method
 * @returns {Object[]}
 */
function dedupeSafariTapAdminRows(rows, method) {
  return dedupeLinkedRecords(rows, (group) => {
    const sorted = [...group].sort(
        (a, b) => safariTapSourceRank(b, method) - safariTapSourceRank(a, method),
    );
    return sorted[0];
  });
}

/**
 * C2B feed: prefer Firestore ledger rows over RTDB / pending order snapshots.
 *
 * @param {Object[]} rows
 * @returns {Object[]}
 */
function dedupeC2bTransactionFeed(rows) {
  return dedupeLinkedRecords(rows, (group) => {
    const score = (row) => {
      const source = String(row.source || "").toLowerCase();
      let n = 0;
      if (source === "firestore") n += 30;
      if (source === "fundingorders" || source === "orders") n += 5;
      if (String(row.status || "").toLowerCase() === "completed") n += 10;
      const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
      if (meta.payoutId || meta.fundingOrderId || row.merchantName) n += 5;
      return n;
    };
    const sorted = [...group].sort((a, b) => score(b) - score(a));
    return sorted[0];
  });
}

module.exports = {
  collectLinkKeys,
  dedupeLinkedRecords,
  dedupeSafariTapAdminRows,
  dedupeC2bTransactionFeed,
  safariTapSourceRank,
};
