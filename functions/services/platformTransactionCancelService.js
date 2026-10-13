/**
 * @fileoverview Super-admin cancel for a non-terminal transaction record.
 * Pending collections are blocked from later settlement. Pending sends
 * credit the partner wallet back, matching a failed send reversal.
 */

const config = require("../config");
const {collection, serverTimestamp, getFirestore} = require("../libs/firestore");
const transactionService = require("./transactionService");
const walletService = require("./walletService");
const fundingOrderService = require("./funding/fundingOrderService");
const {FUNDING_STATUSES} = require("../utils/fundingTypes");
const {logAdminAction} = require("../utils/transactions");

const CREDIT_TYPES = new Set(transactionService.REVERSIBLE_CREDIT_TYPES);

/**
 * @param {string} message
 * @param {number} statusCode
 * @param {string} code
 * @returns {Error}
 */
function fail(message, statusCode, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

/**
 * @param {unknown} reason
 * @returns {string}
 */
function cleanReason(reason) {
  const text = reason ? String(reason).trim() : "";
  return (text || "Cancelled by super admin").slice(0, 300);
}

/**
 * @param {string} colKey
 * @param {string|null|undefined} docId
 * @param {Object} patch
 * @returns {Promise<boolean>}
 */
async function mergeIfExists(colKey, docId, patch) {
  if (!docId) {
    return false;
  }
  const ref = collection(colKey).doc(String(docId));
  const snap = await ref.get();
  if (!snap.exists) {
    return false;
  }
  await ref.set({
    ...patch,
    updatedAt: serverTimestamp(),
  }, {merge: true});
  return true;
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function firstFinite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Amount previously credited to the partner for this collection.
 *
 * @param {Object} row
 * @returns {{ partnerId: string, currency: string, amount: number }|null}
 */
function settledCredit(row) {
  if (!CREDIT_TYPES.has(String(row.type || ""))) {
    return null;
  }
  const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  if (meta.walletReversed === true) {
    return null;
  }
  const partnerId = row.partnerId ? String(row.partnerId) : "";
  const currency = row.currency ? String(row.currency).toUpperCase() : "";
  let amount = firstFinite(meta.netCredit);
  if (amount == null) {
    const gross = firstFinite(row.amount);
    const fee = firstFinite(meta.platformFee);
    if (gross != null && fee != null) {
      amount = Math.round((gross - fee + Number.EPSILON) * 100) / 100;
    } else {
      amount = gross;
    }
  }
  if (!partnerId || !currency || amount == null || amount <= 0) {
    return null;
  }
  return {partnerId, currency, amount};
}

/**
 * @param {Object} row
 * @param {string|null} actorUid
 * @param {string} reason
 * @returns {Promise<{ settled: boolean }>}
 */
async function blockFundingOrder(row, actorUid, reason) {
  const fundingOrderId = row.metadata && row.metadata.fundingOrderId ?
    String(row.metadata.fundingOrderId) :
    "";
  if (!fundingOrderId) {
    return {settled: false};
  }
  const order = await fundingOrderService.getFundingOrder(fundingOrderId);
  if (!order) {
    return {settled: false};
  }
  const metadata = {
    ...(order.metadata && typeof order.metadata === "object" ? order.metadata : {}),
    adminCancelled: true,
    cancelledByUid: actorUid,
    cancelReason: reason,
  };
  if (order.status === FUNDING_STATUSES.completed) {
    try {
      await fundingOrderService.updateFundingOrder(fundingOrderId, {metadata});
    } catch (err) {
      console.warn("cancelPlatformTransaction funding metadata:", err.message);
    }
    return {settled: true};
  }
  try {
    if (order.metadata && order.metadata.adminCancelled === true &&
        order.status === FUNDING_STATUSES.failed) {
      return {settled: false};
    }
    await fundingOrderService.updateFundingOrder(fundingOrderId, {
      status: FUNDING_STATUSES.failed,
      failureReason: reason,
      metadata,
    });
  } catch (err) {
    if (String(err.message || "").includes("already terminal")) {
      return {settled: true};
    }
    throw err;
  }
  return {settled: false};
}

/**
 * Stop a pending collection from settling after cancel.
 *
 * @param {Object} row
 * @param {string|null} actorUid
 * @param {string} reason
 * @returns {Promise<{ settled: boolean }>}
 */
async function blockCollectionSettlement(row, actorUid, reason) {
  const funding = await blockFundingOrder(row, actorUid, reason);
  const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const patch = {
    status: transactionService.STATUSES.cancelled,
    cancelReason: reason,
    cancelledByUid: actorUid,
    cancelledAt: serverTimestamp(),
  };
  const checkoutId = meta.checkoutId ? String(meta.checkoutId) : "";
  const invoiceId = meta.invoiceId ? String(meta.invoiceId) : "";
  await mergeIfExists(config.collections.invoiceMappings, checkoutId, patch);
  if (invoiceId && invoiceId !== checkoutId) {
    await mergeIfExists(config.collections.invoiceMappings, invoiceId, patch);
  }
  if (meta.orderId) {
    await mergeIfExists(config.collections.orders, String(meta.orderId), patch);
  }
  return funding;
}

/**
 * Take a settled collection back out of the partner wallet.
 *
 * @param {Object} row
 * @returns {Promise<Object|null>}
 */
async function reverseSettledCredit(row) {
  const credit = settledCredit(row);
  if (!credit) {
    return null;
  }
  try {
    const wallet = await walletService.updatePartnerWalletBalance(
        credit.partnerId,
        credit.currency,
        -credit.amount,
    );
    return {
      amount: credit.amount,
      currency: credit.currency,
      direction: "debit",
      previousBalance: wallet.previousBalance,
      newBalance: wallet.newBalance,
    };
  } catch (err) {
    if (String(err.message || "").toLowerCase().includes("insufficient")) {
      throw fail(
          "Partner wallet does not have enough balance to reverse this payment",
          409,
          "INSUFFICIENT_BALANCE",
      );
    }
    throw err;
  }
}

/**
 * Credit a pending send back once. Later calls leave an already-reversed payment alone.
 *
 * @param {Object} row
 * @param {string|null} actorUid
 * @param {string} reason
 * @returns {Promise<Object|null>}
 */
async function ensureSendReversed(row, actorUid, reason) {
  const paymentId = row.metadata && row.metadata.paymentId ?
    String(row.metadata.paymentId) :
    "";
  if (!paymentId) {
    throw fail("Send payment id is missing on this transaction", 400, "SEND_PAYMENT_MISSING");
  }
  const ref = collection(config.collections.partnerSendPayments).doc(paymentId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw fail("Send payment record was not found", 404, "SEND_PAYMENT_NOT_FOUND");
  }
  const data = snap.data() || {};
  const current = String(data.status || "").toLowerCase();
  if (current === "completed" || current === "success") {
    throw fail("This send has already been completed", 409, "ALREADY_SETTLED");
  }

  let reversal = data.reversal || null;
  const alreadyReversed = current === "failed" || current === "cancelled" || data.reversed === true;
  if (!alreadyReversed) {
    const amount = Number(data.totalDeduction) || Number(row.amount) || 0;
    const currency = String(data.fromCurrency || row.currency || "").toUpperCase();
    const partnerId = data.partnerId || row.partnerId;
    if (amount > 0 && currency && partnerId) {
      const wallet = await walletService.updatePartnerWalletBalance(partnerId, currency, amount);
      reversal = {
        amount,
        currency,
        previousBalance: wallet.previousBalance,
        newBalance: wallet.newBalance,
      };
    }
  }

  await ref.set({
    status: transactionService.STATUSES.cancelled,
    resolvedByUid: actorUid,
    failureReason: reason,
    cancelledByUid: actorUid,
    cancelledAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    reversed: Boolean(reversal),
    reversal,
  }, {merge: true});
  return reversal;
}

/**
 * @param {string} transactionId
 * @param {Object} extra
 * @returns {Promise<"updated"|"already">}
 */
async function markTransactionCancelled(transactionId, extra) {
  const ref = collection("transactionRecords").doc(transactionId);
  let outcome = "updated";
  await getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw fail("Transaction not found", 404, "NOT_FOUND");
    }
    const data = snap.data() || {};
    const status = String(data.status || "").toLowerCase();
    if (status === transactionService.STATUSES.cancelled) {
      outcome = "already";
      return;
    }
    if (!transactionService.isPortalTransactionCancellable({...data, id: transactionId})) {
      throw fail(
          `Transaction is already ${status} and cannot be cancelled`,
          409,
          "NOT_CANCELLABLE",
      );
    }
    tx.update(ref, {
      status: transactionService.STATUSES.cancelled,
      updatedAt: serverTimestamp(),
      cancelledAt: serverTimestamp(),
      ...extra,
    });
  });
  return outcome;
}

/**
 * Cancel a pending payment, or a settled collection (wallet credit is reversed).
 *
 * @param {Object} params
 * @param {string} params.transactionId
 * @param {string} [params.actorUid]
 * @param {string} [params.reason]
 * @returns {Promise<{ transaction: Object, alreadyCancelled: boolean, reversal: Object|null }>}
 */
async function cancelPlatformTransaction(params) {
  const transactionId = String(params.transactionId || "").trim();
  const actorUid = params.actorUid ? String(params.actorUid) : null;
  const reason = cleanReason(params.reason);
  if (!transactionId) {
    throw fail("transactionId is required", 400, "INVALID_ARGUMENT");
  }

  const row = await transactionService.getTransactionRecord(transactionId);
  if (!row) {
    throw fail("Transaction not found", 404, "NOT_FOUND");
  }

  const status = String(row.status || "").toLowerCase();
  const isSend = row.type === transactionService.TRANSACTION_TYPES.b2b_send;

  if (status === transactionService.STATUSES.cancelled) {
    const reversal = isSend ? await ensureSendReversed(row, actorUid, reason) : null;
    const current = await transactionService.getTransactionRecord(transactionId);
    return {
      transaction: transactionService.serializePortalTransaction(current || row),
      alreadyCancelled: true,
      reversal,
    };
  }

  if (!transactionService.isPortalTransactionCancellable(row)) {
    throw fail(
        `Transaction is already ${status} and cannot be cancelled`,
        409,
        "NOT_CANCELLABLE",
    );
  }

  let settlement = {settled: false};
  if (row.type === transactionService.TRANSACTION_TYPES.b2b_payment ||
      row.type === transactionService.TRANSACTION_TYPES.b2b_funding ||
      row.type === transactionService.TRANSACTION_TYPES.b2b_admin_topup ||
      (row.metadata && row.metadata.fundingOrderId)) {
    settlement = await blockCollectionSettlement(row, actorUid, reason);
  }

  let reversal = null;
  const shouldReverseCredit = CREDIT_TYPES.has(String(row.type || "")) &&
    (status === transactionService.STATUSES.completed || settlement.settled);
  if (shouldReverseCredit) {
    reversal = await reverseSettledCredit(row);
  }

  const outcome = await markTransactionCancelled(transactionId, {
    cancelledByUid: actorUid,
    cancelReason: reason,
    metadata: {
      ...(row.metadata && typeof row.metadata === "object" ? row.metadata : {}),
      cancelReason: reason,
      cancelledByUid: actorUid,
      walletReversed: Boolean(reversal),
      reversal,
    },
  });

  if (isSend) {
    reversal = await ensureSendReversed(row, actorUid, reason);
  }

  const updated = await transactionService.getTransactionRecord(transactionId);
  try {
    await logAdminAction(
        actorUid,
        row.partnerId || row.userId || transactionId,
        "cancel_transaction",
        {transactionId, status: row.status, type: row.type},
        {status: transactionService.STATUSES.cancelled, reason},
    );
  } catch (logErr) {
    console.warn("cancelPlatformTransaction admin log:", logErr.message);
  }

  return {
    transaction: transactionService.serializePortalTransaction(updated || {
      ...row,
      status: transactionService.STATUSES.cancelled,
      cancelReason: reason,
      cancelledByUid: actorUid,
    }),
    alreadyCancelled: outcome === "already",
    reversal,
  };
}

module.exports = {
  cancelPlatformTransaction,
  cleanReason,
};
