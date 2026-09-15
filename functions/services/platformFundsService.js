/**
 * @fileoverview Platform liquidity balances for the super-admin Funds page.
 * Payout account is sourced from IntaSend disbursement webhook `wallet`.
 */

const {collection, serverTimestamp} = require("../libs/firestore");

const PAYOUT_ACCOUNT_DOC = "payoutAccount";
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 200;

const COLLECTION_CURRENCIES = Object.freeze(["KES", "USD"]);
const PAYOUT_CURRENCIES = Object.freeze(["KES"]);
const CRYPTO_ASSETS = Object.freeze(["BTC", "ETH", "SOL"]);
const STABLECOIN_ASSETS = Object.freeze(["USDT", "USDC"]);

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function parseMoney(value) {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number.parseFloat(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function toIso(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
  }
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return null;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeIdPart(value) {
  const cleaned = String(value || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned.slice(0, 80) || "unknown";
}

/**
 * @param {Object} payload
 * @returns {Object|null}
 */
function extractPayoutWalletSnapshot(payload) {
  if (!payload || typeof payload !== "object") return null;
  const wallet = payload.wallet;
  if (!wallet || typeof wallet !== "object") return null;

  const currentBalance = parseMoney(wallet.current_balance);
  const availableBalance = parseMoney(wallet.available_balance);
  if (currentBalance == null && availableBalance == null) return null;

  const firstTx = Array.isArray(payload.transactions) ? payload.transactions[0] : null;
  const currency = String(wallet.currency || firstTx?.currency || "KES").trim().toUpperCase() ||
    "KES";
  const providerUpdatedAt = wallet.updated_at || payload.updated_at || null;

  return {
    accountType: "payout",
    currency,
    currentBalance,
    availableBalance,
    walletId: wallet.wallet_id || null,
    label: wallet.label || null,
    canDisburse: wallet.can_disburse === true,
    walletType: wallet.wallet_type || null,
    providerUpdatedAt,
    source: "intasend_disbursement_webhook",
    trackingId: payload.tracking_id || null,
    fileId: payload.file_id || null,
    batchReference: payload.batch_reference || null,
    providerStatus: payload.status || null,
    providerStatusCode: payload.status_code || null,
  };
}

/**
 * @param {Object} snapshot
 * @returns {string}
 */
function payoutSnapshotDocId(snapshot) {
  const wallet = sanitizeIdPart(snapshot.walletId);
  const stamp = sanitizeIdPart(snapshot.providerUpdatedAt || snapshot.trackingId);
  return `payout_${wallet}_${stamp}`;
}

/**
 * Persist IntaSend settlement-wallet balances as the platform payout account.
 * Idempotent per wallet + provider `updated_at` (webhook retries overwrite).
 *
 * @param {Object} payload
 * @returns {Promise<{recorded: boolean, snapshot?: Object}>}
 */
async function recordPayoutAccountFromDisbursement(payload) {
  const extracted = extractPayoutWalletSnapshot(payload);
  if (!extracted) {
    return {recorded: false};
  }

  const recordedAtIso = new Date().toISOString();
  const doc = {
    ...extracted,
    recordedAtIso,
    providerUpdatedAtIso: toIso(extracted.providerUpdatedAt) || recordedAtIso,
    updatedAt: serverTimestamp(),
    recordedAt: serverTimestamp(),
  };

  const accountRef = collection("platformFunds").doc(PAYOUT_ACCOUNT_DOC);
  await accountRef.set(doc, {merge: true});

  const snapshotId = payoutSnapshotDocId(extracted);
  await accountRef.collection("snapshots").doc(snapshotId).set({
    ...doc,
    snapshotId,
  }, {merge: true});

  return {
    recorded: true,
    snapshot: {
      ...extracted,
      snapshotId,
      recordedAtIso,
    },
  };
}

/**
 * @param {Object|null} data
 * @param {string} code
 * @returns {Object}
 */
function serializeCurrencyRow(data, code) {
  if (!data || String(data.currency || "").toUpperCase() !== code) {
    return {
      code,
      currentBalance: null,
      availableBalance: null,
      updatedAt: null,
    };
  }
  return {
    code,
    currentBalance: data.currentBalance ?? null,
    availableBalance: data.availableBalance ?? null,
    walletId: data.walletId || null,
    walletType: data.walletType || null,
    label: data.label || null,
    canDisburse: data.canDisburse === true,
    source: data.source || null,
    trackingId: data.trackingId || null,
    providerUpdatedAt: toIso(data.providerUpdatedAt),
    updatedAt: toIso(data.updatedAt) || data.recordedAtIso || null,
  };
}

/**
 * @param {string[]} codes
 * @returns {Object[]}
 */
function emptyCurrencyRows(codes) {
  return codes.map((code) => ({
    code,
    currentBalance: null,
    availableBalance: null,
    updatedAt: null,
  }));
}

/**
 * Funds page payload: payout is live from IntaSend webhooks; other books stay null
 * until a source is wired.
 *
 * @returns {Promise<Object>}
 */
async function getPlatformFunds() {
  const snap = await collection("platformFunds").doc(PAYOUT_ACCOUNT_DOC).get();
  const payout = snap.exists ? snap.data() : null;

  return {
    updatedAt: payout ? (toIso(payout.updatedAt) || payout.recordedAtIso || null) : null,
    collectionsAccount: {
      label: "Collections account",
      currencies: emptyCurrencyRows(COLLECTION_CURRENCIES),
    },
    payoutAccount: {
      label: "Payout account",
      currencies: PAYOUT_CURRENCIES.map((code) => serializeCurrencyRow(payout, code)),
    },
    digitalAssets: {
      crypto: emptyCurrencyRows(CRYPTO_ASSETS),
      stablecoin: emptyCurrencyRows(STABLECOIN_ASSETS),
    },
  };
}

/**
 * @param {{ account?: string, limit?: number, startAfter?: string|null }} opts
 * @returns {Promise<{items: Object[], nextCursor: string|null}>}
 */
async function listFundHistory(opts = {}) {
  const account = String(opts.account || "payout").trim().toLowerCase();
  if (account !== "payout") {
    const err = new Error("Only payout account history is available");
    err.statusCode = 400;
    err.code = "UNSUPPORTED_ACCOUNT";
    throw err;
  }

  const limit = Math.min(
      Math.max(Number.parseInt(opts.limit, 10) || DEFAULT_HISTORY_LIMIT, 1),
      MAX_HISTORY_LIMIT,
  );
  const startAfter = opts.startAfter ? String(opts.startAfter) : null;
  const snapshots = collection("platformFunds").doc(PAYOUT_ACCOUNT_DOC).collection("snapshots");

  let query = snapshots.orderBy("providerUpdatedAtIso", "desc").limit(limit);
  if (startAfter) {
    const cursorDoc = await snapshots.doc(startAfter).get();
    if (cursorDoc.exists) {
      query = snapshots.orderBy("providerUpdatedAtIso", "desc")
          .startAfter(cursorDoc)
          .limit(limit);
    }
  }

  const page = await query.get();
  const items = page.docs.map((docSnap) => {
    const data = docSnap.data() || {};
    return {
      snapshotId: docSnap.id,
      accountType: data.accountType || "payout",
      currency: data.currency || "KES",
      currentBalance: data.currentBalance ?? null,
      availableBalance: data.availableBalance ?? null,
      walletId: data.walletId || null,
      walletType: data.walletType || null,
      source: data.source || null,
      trackingId: data.trackingId || null,
      fileId: data.fileId || null,
      batchReference: data.batchReference || null,
      providerStatus: data.providerStatus || null,
      providerUpdatedAt: toIso(data.providerUpdatedAt),
      recordedAt: data.recordedAtIso || toIso(data.recordedAt),
    };
  });

  const last = page.docs[page.docs.length - 1];
  return {
    items,
    nextCursor: page.docs.length === limit && last ? last.id : null,
  };
}

module.exports = {
  extractPayoutWalletSnapshot,
  recordPayoutAccountFromDisbursement,
  getPlatformFunds,
  listFundHistory,
  parseMoney,
};
