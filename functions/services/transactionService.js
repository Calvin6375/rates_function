/**
 * @fileoverview Transaction engine: central system for all financial activity.
 * Creates unified transaction records and (optionally) ledger entries.
 * Backwards compatibility: continues to write to existing transactions/{userId}/transactions for consumer app.
 */

const config = require("../config");
const { collection, serverTimestamp } = require("../libs/firestore");
const { logTransaction, generateTransactionId } = require("../utils/transactions");
const ledgerService = require("./ledgerService");
const walletService = require("./walletService");
const fundingOrderService = require("./funding/fundingOrderService");
const { FUNDING_STATUSES, B2B_SELF_TOPUP_PRODUCT } = require("../utils/fundingTypes");

/** Transaction types supported by the engine */
const TRANSACTION_TYPES = Object.freeze({
  topup: "topup",
  withdrawal: "withdrawal",
  crypto_onramp: "crypto_onramp",
  crypto_offramp: "crypto_offramp",
  b2b_payment: "b2b_payment",
  b2b_funding: "b2b_funding",
  b2b_send: "b2b_send",
  b2b_admin_topup: "b2b_admin_topup",
  settlement: "settlement",
  funding: "funding",
  merchant_payment: "merchant_payment",
});

/** Transaction lifecycle statuses */
const STATUSES = Object.freeze({
  created: "created",
  pending: "pending",
  processing: "processing",
  completed: "completed",
  failed: "failed",
});

/**
 * Generate a unique transaction record ID
 * @returns {string}
 */
function generateTransactionRecordId() {
  return `txr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Create a transaction record in the unified transaction log (transactionRecords).
 * Optionally creates ledger entries and/or logs to legacy transactions/{userId}/transactions.
 *
 * @param {Object} params
 * @param {string} params.type - One of TRANSACTION_TYPES
 * @param {string} [params.userId] - Consumer user ID (for topup, swap, etc.)
 * @param {string} [params.partnerId] - Partner ID (for b2b_payment, settlement)
 * @param {number} params.amount - Amount
 * @param {string} params.currency - Currency code (USD, KES, USDT)
 * @param {string} [params.status='created'] - Initial status
 * @param {Object} [params.metadata] - Extra data (invoiceId, orderId, etc.)
 * @param {boolean} [params.createLedgerEntries=false] - If true, creates double-entry (requires debitAccount, creditAccount)
 * @param {string} [params.debitAccount] - For ledger (e.g. liquidity_pool)
 * @param {string} [params.creditAccount] - For ledger (e.g. user_wallet:uid)
 * @param {boolean} [params.logLegacy=true] - If true and userId present, also writes to transactions/{userId}/transactions
 * @returns {Promise<{ transactionId: string, legacyTxId?: string, ledgerEntryIds?: { debitEntryId: string, creditEntryId: string } }>}
 */
async function createTransactionRecord({
  type,
  userId = null,
  partnerId = null,
  amount,
  currency,
  status = STATUSES.created,
  metadata = {},
  createLedgerEntries = false,
  debitAccount = null,
  creditAccount = null,
  logLegacy = true,
}) {
  const transactionId = generateTransactionRecordId();
  const col = collection("transactionRecords");
  const ref = col.doc(transactionId);

  const data = {
    id: transactionId,
    type: String(type),
    userId: userId || null,
    partnerId: partnerId || null,
    amount: Number(amount),
    currency: String(currency),
    status: String(status),
    createdAt: serverTimestamp(),
    metadata: typeof metadata === "object" ? metadata : {},
  };

  await ref.set(data);

  let legacyTxId;
  if (logLegacy && userId && (status === STATUSES.completed || status === STATUSES.processing)) {
    try {
      legacyTxId = await logTransaction(
        userId,
        type,
        amount,
        status,
        metadata.previousBalance ?? 0,
        metadata.newBalance ?? Number(amount),
        { currency, ...metadata }
      );
    } catch (e) {
      console.warn("transactionService: legacy log failed (non-fatal):", e.message);
    }
  }

  let ledgerEntryIds;
  if (createLedgerEntries && debitAccount && creditAccount && Number(amount) > 0) {
    ledgerEntryIds = await ledgerService.createDoubleEntry({
      debitAccount,
      creditAccount,
      amount: Number(amount),
      currency: String(currency),
      transactionId,
      metadata,
    });
  }

  return { transactionId, legacyTxId, ledgerEntryIds };
}

/**
 * Update transaction record status
 *
 * @param {string} transactionId - Transaction record ID
 * @param {string} status - New status (pending, processing, completed, failed)
 * @param {Object} [updates] - Additional fields to merge
 * @returns {Promise<void>}
 */
async function updateTransactionStatus(transactionId, status, updates = {}) {
  const ref = collection("transactionRecords").doc(transactionId);
  await ref.update({
    status: String(status),
    updatedAt: serverTimestamp(),
    ...updates,
  });
}

/**
 * Get a transaction record by ID
 *
 * @param {string} transactionId
 * @returns {Promise<Object|null>}
 */
async function getTransactionRecord(transactionId) {
  const doc = await collection("transactionRecords").doc(transactionId).get();
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
 * @param {FirebaseFirestore.QuerySnapshot} snapshot
 * @returns {Array<Object>}
 */
function mapTransactionSnapshot(snapshot) {
  return snapshot.docs.map((doc) => {
    const d = doc.data();
    return {
      id: doc.id,
      ...d,
      createdAt: d.createdAt?.toDate?.()?.toISOString?.() ?? null,
      updatedAt: d.updatedAt?.toDate?.()?.toISOString?.() ?? null,
    };
  });
}

/** Firestore composite index missing or still building (code 9). */
function isFirestoreIndexUnavailable(err) {
  const code = err?.code;
  const msg = String(err?.message || "");
  return code === 9 || msg.includes("FAILED_PRECONDITION") || msg.includes("requires an index");
}

/** Transaction types grouped for platform dashboard channel filter */
const CHANNEL_TYPES = Object.freeze({
  b2b: ["b2b_payment", "b2b_funding", "b2b_send", "b2b_admin_topup"],
  c2b: ["topup", "withdrawal", "crypto_onramp", "crypto_offramp", "funding", "merchant_payment"],
});

/**
 * @param {string} [channel]
 * @returns {string[]|null} Firestore type filter; null = all types
 */
function resolveChannelTypes(channel) {
  const key = String(channel || "b2b").toLowerCase();
  if (key === "all") {
    return null;
  }
  return CHANNEL_TYPES[key] || CHANNEL_TYPES.b2b;
}

/**
 * @param {string} cursorId
 * @returns {Promise<FirebaseFirestore.DocumentSnapshot|null>}
 */
async function resolveTransactionCursor(cursorId) {
  if (!cursorId) {
    return null;
  }
  const doc = await collection("transactionRecords").doc(String(cursorId)).get();
  return doc.exists ? doc : null;
}

/**
 * Normalize a transaction row for portal / platform API consumers.
 *
 * @param {Object} row
 * @returns {Object}
 */
function serializePortalTransaction(row) {
  const metadata = row.metadata && typeof row.metadata === "object" ? { ...row.metadata } : {};
  const bookingReference =
    metadata.bookingReference ||
    metadata.reference ||
    metadata.productReference ||
    null;
  const payerName =
    metadata.payerName ||
    row.payerName ||
    metadata.guestName ||
    null;
  if (payerName) {
    metadata.payerName = payerName;
  }
  if (bookingReference) {
    metadata.bookingReference = bookingReference;
  }
  return {
    transactionId: row.id,
    id: row.id,
    type: row.type,
    partnerId: row.partnerId ?? null,
    userId: row.userId ?? null,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
    payerName,
    metadata,
  };
}

/**
 * List transaction records (e.g. for a partner or user)
 *
 * @param {Object} options
 * @param {string} [options.userId] - Filter by userId
 * @param {string} [options.partnerId] - Filter by partnerId
 * @param {string} [options.type] - Filter by type (single)
 * @param {string[]} [options.types] - Filter by type (`in` query, max 10)
 * @param {string} [options.status] - Filter by status
 * @param {number} [options.limit=50]
 * @param {admin.firestore.DocumentSnapshot} [options.startAfter]
 * @param {string} [options.startAfterId] - Document id cursor
 * @returns {Promise<{ transactions: Array<Object>, lastDoc: admin.firestore.DocumentSnapshot|null, nextPageCursor: string|null }>}
 */
async function listTransactionRecords({
  userId,
  partnerId,
  type,
  types,
  status,
  limit = 50,
  startAfter = null,
  startAfterId = null,
}) {
  let cursor = startAfter;
  if (!cursor && startAfterId) {
    cursor = await resolveTransactionCursor(startAfterId);
  }

  const typeList = Array.isArray(types) && types.length ?
    types.slice(0, 10) :
    (type ? [type] : null);

  let query = collection("transactionRecords").orderBy("createdAt", "desc").limit(limit);
  if (userId) query = query.where("userId", "==", userId);
  if (partnerId) query = query.where("partnerId", "==", partnerId);
  if (typeList && typeList.length === 1) {
    query = query.where("type", "==", typeList[0]);
  } else if (typeList && typeList.length > 1) {
    query = query.where("type", "in", typeList);
  }
  if (status) query = query.where("status", "==", status);
  if (cursor) query = query.startAfter(cursor);

  try {
    const snapshot = await query.get();
    const transactions = mapTransactionSnapshot(snapshot);
    const lastDoc = snapshot.docs.length === limit ? snapshot.docs[snapshot.docs.length - 1] : null;
    return {
      transactions,
      lastDoc,
      nextPageCursor: lastDoc ? lastDoc.id : null,
    };
  } catch (err) {
    if (!isFirestoreIndexUnavailable(err) || cursor) {
      throw err;
    }
    // Index building or not deployed yet: scan recent rows and filter in memory.
    const scanLimit = Math.min(Math.max(limit * 10, 200), 1000);
    const fallbackSnap = await collection("transactionRecords")
        .orderBy("createdAt", "desc")
        .limit(scanLimit)
        .get();
    let transactions = mapTransactionSnapshot(fallbackSnap);
    if (userId) transactions = transactions.filter((row) => row.userId === userId);
    if (partnerId) transactions = transactions.filter((row) => row.partnerId === partnerId);
    if (typeList && typeList.length) {
      transactions = transactions.filter((row) => typeList.includes(row.type));
    }
    if (status) transactions = transactions.filter((row) => row.status === status);
    if (startAfterId) {
      const idx = transactions.findIndex((row) => row.id === startAfterId);
      if (idx >= 0) {
        transactions = transactions.slice(idx + 1);
      }
    }
    transactions = transactions.slice(0, limit);
    const lastRow = transactions.length === limit ? transactions[transactions.length - 1] : null;
    return {
      transactions,
      lastDoc: null,
      nextPageCursor: lastRow ? lastRow.id : null,
    };
  }
}

/**
 * Complete a funding order: ledger credit, transaction record, order status update.
 * No provider-specific logic — caller must verify payment first.
 *
 * @param {Object} params
 * @param {Object} params.fundingOrder
 * @param {import("../utils/fundingTypes").NormalizedFundingEvent} params.verifiedEvent
 * @returns {Promise<{ success: boolean, duplicate?: boolean, transactionRecordId?: string, error?: string }>}
 */
/**
 * B2B Add Money orders must credit the partner org wallet, never users/{uid} fiat.
 * Detect by product marker, or by partnerId / portal source if product was dropped.
 *
 * @param {Object} fundingOrder
 * @returns {boolean}
 */
function isB2bSelfTopupOrder(fundingOrder) {
  const meta = fundingOrder?.metadata && typeof fundingOrder.metadata === "object" ?
    fundingOrder.metadata :
    {};
  const product = String(meta.product || "").toLowerCase();
  if (product === B2B_SELF_TOPUP_PRODUCT || product === "b2b") {
    return true;
  }
  if (meta.partnerId) {
    return true;
  }
  const source = String(meta.source || "").toLowerCase();
  return source === "b2b_portal_add_money" || source === "b2b_add_money";
}

/**
 * Credit partner wallet for B2B Add Money (Paystack KES self-topup).
 *
 * @param {Object} params
 * @param {Object} params.fundingOrder
 * @param {import("../utils/fundingTypes").NormalizedFundingEvent} params.verifiedEvent
 * @returns {Promise<{ success: boolean, duplicate?: boolean, transactionRecordId?: string, error?: string }>}
 */
async function completeB2bSelfTopupOrder(params) {
  const { fundingOrder, verifiedEvent } = params;
  const meta = fundingOrder.metadata && typeof fundingOrder.metadata === "object" ?
    fundingOrder.metadata :
    {};
  const partnerId = meta.partnerId ? String(meta.partnerId) : null;
  if (!partnerId) {
    return { success: false, error: "B2B funding order missing partnerId" };
  }

  const creditAmount = Number.isFinite(Number(meta.requestedAmount)) && Number(meta.requestedAmount) > 0 ?
    Number(meta.requestedAmount) :
    fundingOrder.amount;
  const creditCurrency = String(meta.requestedCurrency || fundingOrder.currency || "KES").toUpperCase();

  await fundingOrderService.updateFundingOrder(fundingOrder.id, {
    status: FUNDING_STATUSES.processing,
    providerTransactionId: verifiedEvent.providerTransactionId || fundingOrder.providerTransactionId,
  });

  try {
    await walletService.getOrCreatePartnerWallet(partnerId);
    const { previousBalance, newBalance } = await walletService.updatePartnerWalletBalance(
        partnerId,
        creditCurrency,
        creditAmount,
    );

    const { transactionId } = await createTransactionRecord({
      type: TRANSACTION_TYPES.b2b_funding,
      partnerId,
      userId: fundingOrder.userId || null,
      amount: creditAmount,
      currency: creditCurrency,
      status: STATUSES.completed,
      metadata: {
        fundingOrderId: fundingOrder.id,
        provider: fundingOrder.provider,
        providerReference: fundingOrder.providerReference,
        providerTransactionId: verifiedEvent.providerTransactionId,
        product: B2B_SELF_TOPUP_PRODUCT,
        source: "paystack",
        rail: "paystack",
        previousBalance,
        newBalance,
        chargeAmount: fundingOrder.amount,
        chargeCurrency: fundingOrder.currency,
      },
      logLegacy: false,
    });

    await fundingOrderService.updateFundingOrder(fundingOrder.id, {
      status: FUNDING_STATUSES.completed,
      transactionRecordId: transactionId,
      providerTransactionId: verifiedEvent.providerTransactionId || fundingOrder.providerTransactionId,
    });

    return {
      success: true,
      duplicate: false,
      transactionRecordId: transactionId,
    };
  } catch (err) {
    await fundingOrderService.updateFundingOrder(fundingOrder.id, {
      status: FUNDING_STATUSES.failed,
      failureReason: err.message,
    });
    return { success: false, error: err.message };
  }
}

async function completeFundingOrder(params) {
  const { fundingOrder, verifiedEvent } = params;

  if (!fundingOrder || !verifiedEvent) {
    return { success: false, error: "Missing funding order or verified event" };
  }

  if (fundingOrder.status === FUNDING_STATUSES.completed) {
    return { success: true, duplicate: true, transactionRecordId: fundingOrder.transactionRecordId };
  }

  if (isB2bSelfTopupOrder(fundingOrder)) {
    return completeB2bSelfTopupOrder(params);
  }

  const referenceId = `fund_${fundingOrder.provider}_${verifiedEvent.providerTransactionId || verifiedEvent.providerReference}`;

  const meta = fundingOrder.metadata && typeof fundingOrder.metadata === "object" ?
    fundingOrder.metadata :
    {};
  const requestedAmount = Number(meta.requestedAmount);
  const requestedCurrency = meta.requestedCurrency ?
    String(meta.requestedCurrency).toUpperCase() :
    null;
  const creditAmount = Number.isFinite(requestedAmount) && requestedAmount > 0 ?
    requestedAmount :
    fundingOrder.amount;
  const creditCurrency = requestedCurrency || fundingOrder.currency;

  await fundingOrderService.updateFundingOrder(fundingOrder.id, {
    status: FUNDING_STATUSES.processing,
    providerTransactionId: verifiedEvent.providerTransactionId || fundingOrder.providerTransactionId,
  });

  try {
    const { transactionId } = await createTransactionRecord({
      type: TRANSACTION_TYPES.funding,
      userId: fundingOrder.userId,
      amount: creditAmount,
      currency: creditCurrency,
      status: STATUSES.processing,
      metadata: {
        fundingOrderId: fundingOrder.id,
        provider: fundingOrder.provider,
        providerReference: fundingOrder.providerReference,
        providerTransactionId: verifiedEvent.providerTransactionId,
        product: fundingOrder.metadata?.product || "tourist_payments",
        chargeAmount: fundingOrder.amount,
        chargeCurrency: fundingOrder.currency,
        requestedAmount: creditAmount,
        requestedCurrency: creditCurrency,
      },
      logLegacy: false,
    });

    const creditResult = await walletService.creditUserFiat(
        fundingOrder.userId,
        creditAmount,
        creditCurrency,
        {
          referenceId,
          type: "funding",
          source: fundingOrder.provider,
          fundingOrderId: fundingOrder.id,
          transactionRecordId: transactionId,
          metadata: {
            providerReference: fundingOrder.providerReference,
            chargeAmount: fundingOrder.amount,
            chargeCurrency: fundingOrder.currency,
          },
        },
    );

    await updateTransactionStatus(transactionId, STATUSES.completed, {
      metadata: {
        fundingOrderId: fundingOrder.id,
        provider: fundingOrder.provider,
        previousBalance: creditResult.previousBalance,
        newBalance: creditResult.newBalance,
        ledgerEntryId: creditResult.ledgerEntryId,
      },
    });

    await fundingOrderService.updateFundingOrder(fundingOrder.id, {
      status: FUNDING_STATUSES.completed,
      transactionRecordId: transactionId,
      providerTransactionId: verifiedEvent.providerTransactionId || fundingOrder.providerTransactionId,
    });

    try {
      await logTransaction(
          fundingOrder.userId,
          TRANSACTION_TYPES.funding,
          creditAmount,
          STATUSES.completed,
          creditResult.previousBalance,
          creditResult.newBalance,
          {
            currency: creditCurrency,
            fundingOrderId: fundingOrder.id,
            provider: fundingOrder.provider,
          },
      );
    } catch (logErr) {
      console.warn("completeFundingOrder: legacy log failed (non-fatal):", logErr.message);
    }

    return {
      success: true,
      duplicate: creditResult.duplicate,
      transactionRecordId: transactionId,
    };
  } catch (err) {
    await fundingOrderService.updateFundingOrder(fundingOrder.id, {
      status: FUNDING_STATUSES.failed,
      failureReason: err.message,
    });
    return { success: false, error: err.message };
  }
}

module.exports = {
  TRANSACTION_TYPES,
  STATUSES,
  CHANNEL_TYPES,
  createTransactionRecord,
  updateTransactionStatus,
  getTransactionRecord,
  listTransactionRecords,
  serializePortalTransaction,
  resolveChannelTypes,
  generateTransactionRecordId,
  completeFundingOrder,
  completeB2bSelfTopupOrder,
  isB2bSelfTopupOrder,
};
