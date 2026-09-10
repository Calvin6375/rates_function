/**
 * @fileoverview Safari Card payout types, status mapping, and error codes.
 */

/** @typedef {"MPESA_B2C"|"MPESA_B2B"|"BANK"|"SAFARITAP_WALLET"|"TRUEPAY_MERCHANT"} SafariCardPayoutType */

/** @typedef {"PENDING"|"INITIATED"|"PROCESSING"|"SUCCESS"|"FAILED"|"CANCELLED"|"RETRY"|"UNKNOWN"} SafariCardPayoutStatus */

const PAYOUT_TYPES = Object.freeze({
  MPESA_B2C: "MPESA_B2C",
  MPESA_B2B: "MPESA_B2B",
  BANK: "BANK",
  /** Internal TruePay ledger transfer (no IntaSend) */
  SAFARITAP_WALLET: "SAFARITAP_WALLET",
  /** SafariTap KES → B2B partner wallet via profile QR / merchant ID */
  TRUEPAY_MERCHANT: "TRUEPAY_MERCHANT",
});

const B2B_ACCOUNT_TYPES = Object.freeze({
  TILL: "TillNumber",
  PAYBILL: "PayBill",
});

const PAYOUT_STATUS = Object.freeze({
  PENDING: "PENDING",
  INITIATED: "INITIATED",
  PROCESSING: "PROCESSING",
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  RETRY: "RETRY",
  UNKNOWN: "UNKNOWN",
});

const TERMINAL_STATUSES = new Set([
  PAYOUT_STATUS.SUCCESS,
  PAYOUT_STATUS.FAILED,
  PAYOUT_STATUS.CANCELLED,
]);

const ERROR_CODES = Object.freeze({
  INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
  INVALID_RECIPIENT: "INVALID_RECIPIENT",
  INVALID_AMOUNT: "INVALID_AMOUNT",
  INVALID_PHONE_NUMBER: "INVALID_PHONE_NUMBER",
  INVALID_PAYBILL_REFERENCE: "INVALID_PAYBILL_REFERENCE",
  INVALID_BANK_ACCOUNT: "INVALID_BANK_ACCOUNT",
  PROVIDER_ERROR: "PROVIDER_ERROR",
  PROVIDER_AUTH_ERROR: "PROVIDER_AUTH_ERROR",
  PROVIDER_TIMEOUT: "PROVIDER_TIMEOUT",
  PAYOUT_ALREADY_EXISTS: "PAYOUT_ALREADY_EXISTS",
  PAYOUT_PROCESSING: "PAYOUT_PROCESSING",
  PAYOUT_FAILED: "PAYOUT_FAILED",
  UNSUPPORTED_PAYOUT_TYPE: "UNSUPPORTED_PAYOUT_TYPE",
  UNAUTHORIZED: "UNAUTHORIZED",
  NOT_FOUND: "NOT_FOUND",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  RECIPIENT_NOT_FOUND: "RECIPIENT_NOT_FOUND",
  SELF_TRANSFER: "SELF_TRANSFER",
});

/** Batch-level IntaSend status codes */
const BATCH_SUCCESS_CODES = new Set(["BC100"]);
const BATCH_FAILED_CODES = new Set(["BF102", "BF105", "BF107"]);
const BATCH_CANCELLED_CODES = new Set(["BE111"]);

/** Transaction-level IntaSend status codes */
const TX_SUCCESS_CODES = new Set(["TS100"]);
const TX_FAILED_CODES = new Set(["TF103", "TF106"]);
const TX_CANCELLED_CODES = new Set(["TC108"]);
const TX_RETRY_CODES = new Set(["TR109"]);
const TX_PROCESSING_CODES = new Set(["TP101", "TP102", "TP104"]);

/**
 * @param {string|null|undefined} batchStatusCode
 * @param {string|null|undefined} txStatusCode
 * @returns {SafariCardPayoutStatus}
 */
function mapIntaSendStatus(batchStatusCode, txStatusCode) {
  const tx = String(txStatusCode || "").toUpperCase();
  const batch = String(batchStatusCode || "").toUpperCase();

  if (TX_SUCCESS_CODES.has(tx) || BATCH_SUCCESS_CODES.has(batch)) {
    if (TX_FAILED_CODES.has(tx)) {
      return PAYOUT_STATUS.FAILED;
    }
    if (TX_SUCCESS_CODES.has(tx) || batch === "BC100") {
      return PAYOUT_STATUS.SUCCESS;
    }
  }
  if (TX_FAILED_CODES.has(tx) || BATCH_FAILED_CODES.has(batch)) {
    return PAYOUT_STATUS.FAILED;
  }
  if (TX_CANCELLED_CODES.has(tx) || BATCH_CANCELLED_CODES.has(batch)) {
    return PAYOUT_STATUS.CANCELLED;
  }
  if (TX_RETRY_CODES.has(tx)) {
    return PAYOUT_STATUS.RETRY;
  }
  if (TX_PROCESSING_CODES.has(tx) ||
      ["BP109", "BP110", "BP103", "BP104", "BP106", "BP108"].includes(batch)) {
    return PAYOUT_STATUS.PROCESSING;
  }
  if (tx === "TF105") {
    return PAYOUT_STATUS.UNKNOWN;
  }
  return PAYOUT_STATUS.UNKNOWN;
}

/**
 * @param {string} code
 * @param {string} message
 * @param {number} [httpStatus=400]
 * @returns {Error & { code: string, httpStatus: number }}
 */
function payoutError(code, message, httpStatus = 400) {
  const err = new Error(message);
  err.code = code;
  err.httpStatus = httpStatus;
  return err;
}

/**
 * Merge IntaSend transaction row into stored recipient (name, account, account_type).
 * @param {Object|null|undefined} firstTx
 * @returns {Object}
 */
function providerTxRecipientPatch(firstTx) {
  if (!firstTx || typeof firstTx !== "object") {
    return {};
  }
  const patch = {};
  if (firstTx.name) {
    patch["recipient.name"] = String(firstTx.name);
  }
  if (firstTx.account != null && String(firstTx.account).trim()) {
    patch["recipient.account"] = String(firstTx.account).trim();
  }
  if (firstTx.account_type) {
    patch["recipient.accountType"] = String(firstTx.account_type);
  }
  if (firstTx.account_reference) {
    patch["recipient.accountReference"] = String(firstTx.account_reference);
  }
  return patch;
}

/**
 * Client-facing recipient account fields (no merchant name — use merchantName).
 * @param {Object} payout
 * @returns {Object|null}
 */
function serializeRecipientForClient(payout) {
  const recipient = payout.recipient && typeof payout.recipient === "object" ?
    payout.recipient :
    {};
  const payoutType = payout.type;

  if (payoutType === PAYOUT_TYPES.MPESA_B2B) {
    return {
      account_type: recipient.accountType || null,
      account: recipient.account || null,
      account_reference: recipient.accountReference || null,
    };
  }

  if (payoutType === PAYOUT_TYPES.MPESA_B2C) {
    return {
      account_type: "PhoneNumber",
      account: recipient.phoneNumber || null,
    };
  }

  if (payoutType === PAYOUT_TYPES.BANK) {
    return {
      account_type: "BankAccount",
      account: recipient.accountNumber || null,
      bank_code: recipient.bankCode || null,
    };
  }

  if (payoutType === PAYOUT_TYPES.SAFARITAP_WALLET) {
    return {
      account_type: "SafariTapWallet",
      account: recipient.phoneNumber || recipient.userId || null,
      user_id: recipient.userId || null,
      phone_number: recipient.phoneNumber || null,
    };
  }

  if (payoutType === PAYOUT_TYPES.TRUEPAY_MERCHANT) {
    return {
      account_type: "TruePayMerchant",
      account: recipient.merchantId || recipient.partnerId || null,
      merchant_id: recipient.merchantId || recipient.partnerId || null,
    };
  }

  return null;
}

/**
 * @param {Object} payout
 * @returns {string|null}
 */
function resolveMerchantName(payout) {
  const recipient = payout.recipient && typeof payout.recipient === "object" ?
    payout.recipient :
    {};
  return recipient.name ||
    recipient.accountName ||
    null;
}

/**
 * @param {Object} payout
 * @returns {Object}
 */
function serializePayoutForClient(payout) {
  if (!payout) {
    return null;
  }
  const defaultProvider =
    payout.type === PAYOUT_TYPES.SAFARITAP_WALLET ||
    payout.type === PAYOUT_TYPES.TRUEPAY_MERCHANT ?
      "truepay" :
      "intasend";
  const row = {
    status: payout.status,
    provider: payout.provider || defaultProvider,
    amount: Number(payout.amount),
    fee: Number(payout.fee || 0),
    totalDebit: Number(payout.totalDebit || payout.amount),
    currency: payout.currency,
    merchantName: resolveMerchantName(payout),
    mpesaReference: payout.providerReference || null,
    recipient: serializeRecipientForClient(payout),
    failureReason: payout.failureReason || null,
    createdAt: payout.createdAt?.toDate?.()?.toISOString?.() || payout.createdAt || null,
    updatedAt: payout.updatedAt?.toDate?.()?.toISOString?.() || payout.updatedAt || null,
    completedAt: payout.completedAt?.toDate?.()?.toISOString?.() || payout.completedAt || null,
    failedAt: payout.failedAt?.toDate?.()?.toISOString?.() || payout.failedAt || null,
  };
  if (payout.type === PAYOUT_TYPES.SAFARITAP_WALLET) {
    row.recipientUserId = payout.recipientUserId || payout.recipient?.userId || null;
  }
  if (payout.type === PAYOUT_TYPES.TRUEPAY_MERCHANT) {
    row.merchantId = payout.recipientPartnerId || payout.recipient?.merchantId || null;
    row.partnerId = payout.recipientPartnerId || payout.recipient?.partnerId || null;
  }
  return row;
}

module.exports = {
  PAYOUT_TYPES,
  B2B_ACCOUNT_TYPES,
  PAYOUT_STATUS,
  TERMINAL_STATUSES,
  ERROR_CODES,
  mapIntaSendStatus,
  payoutError,
  serializePayoutForClient,
  serializeRecipientForClient,
  resolveMerchantName,
  providerTxRecipientPatch,
};
