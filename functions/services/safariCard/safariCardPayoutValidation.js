/**
 * @fileoverview Safari Card payout input validation and phone normalization.
 */

const {
  PAYOUT_TYPES,
  B2B_ACCOUNT_TYPES,
  ERROR_CODES,
  payoutError,
} = require("../../utils/safariCardPayoutTypes");

const SUPPORTED_CURRENCY = "KES";
const MIN_BANK_AMOUNT = 100;
const MAX_BANK_AMOUNT = 999999;

/**
 * Normalize Kenyan mobile numbers to 2547XXXXXXXX when appropriate.
 * Does not modify valid international numbers outside Kenya patterns.
 *
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
function normalizeKenyanPhoneNumber(raw) {
  if (!raw) {
    return null;
  }
  let digits = String(raw).replace(/\D/g, "");
  if (!digits) {
    return null;
  }

  if (digits.startsWith("0") && digits.length === 10) {
    digits = `254${digits.slice(1)}`;
  } else if (digits.startsWith("7") && digits.length === 9) {
    digits = `254${digits}`;
  } else if (digits.startsWith("254") && digits.length === 12) {
    // already normalized
  } else if (digits.startsWith("254") && digits.length > 12) {
    digits = digits.slice(0, 12);
  }

  if (!/^2547\d{8}$/.test(digits)) {
    return null;
  }
  return digits;
}

/**
 * @param {string|null|undefined} value
 * @param {number} minLen
 * @param {number} maxLen
 * @returns {boolean}
 */
function isDigitsInRange(value, minLen, maxLen) {
  const s = String(value || "").replace(/\D/g, "");
  return s.length >= minLen && s.length <= maxLen;
}

/**
 * @param {Object} body
 * @returns {Object}
 */
function validateCreatePayoutRequest(body) {
  const type = String(body?.type || "").toUpperCase();
  if (!Object.values(PAYOUT_TYPES).includes(type)) {
    throw payoutError(ERROR_CODES.UNSUPPORTED_PAYOUT_TYPE, `Unsupported payout type: ${type}`);
  }

  const amount = Number(body?.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw payoutError(ERROR_CODES.INVALID_AMOUNT, "Amount must be a positive number");
  }

  const currency = String(body?.currency || SUPPORTED_CURRENCY).toUpperCase();
  if (currency !== SUPPORTED_CURRENCY) {
    throw payoutError(ERROR_CODES.INVALID_AMOUNT, `Only ${SUPPORTED_CURRENCY} payouts are supported`);
  }

  const clientRequestId = String(body?.clientRequestId || body?.requestId || "").trim();
  if (!clientRequestId || clientRequestId.length < 8) {
    throw payoutError(
        ERROR_CODES.VALIDATION_FAILED,
        "clientRequestId is required (minimum 8 characters)",
    );
  }

  const narrative = body?.narrative ?
    String(body.narrative).slice(0, 240) :
    "Safari Card transfer";

  /** @type {Record<string, unknown>} */
  const recipient = {};

  if (type === PAYOUT_TYPES.MPESA_B2C) {
    const phone = normalizeKenyanPhoneNumber(
        body?.recipient?.phoneNumber || body?.phoneNumber,
    );
    if (!phone) {
      throw payoutError(
          ERROR_CODES.INVALID_PHONE_NUMBER,
          "Invalid Kenyan M-Pesa phone number",
      );
    }
    recipient.phoneNumber = phone;
    recipient.name = body?.recipient?.name || body?.name || "Safari Card Customer";
  }

  if (type === PAYOUT_TYPES.MPESA_B2B) {
    const accountType = String(
        body?.accountType || body?.recipient?.accountType || "",
    );
    if (!Object.values(B2B_ACCOUNT_TYPES).includes(accountType)) {
      throw payoutError(
          ERROR_CODES.INVALID_RECIPIENT,
          "accountType must be TillNumber or PayBill",
      );
    }
    const account = String(body?.recipient?.account || body?.account || "").trim();
    if (!isDigitsInRange(account, 5, 10)) {
      throw payoutError(ERROR_CODES.INVALID_RECIPIENT, "Invalid Till or PayBill number");
    }
    recipient.account = account.replace(/\D/g, "");
    recipient.accountType = accountType;
    recipient.name = body?.recipient?.name || body?.name || "Safari Card Merchant";

    if (accountType === B2B_ACCOUNT_TYPES.PAYBILL) {
      const accountReference = String(
          body?.recipient?.accountReference ||
          body?.accountReference ||
          "",
      ).trim();
      if (!accountReference || accountReference.length < 1 || accountReference.length > 20) {
        throw payoutError(
            ERROR_CODES.INVALID_PAYBILL_REFERENCE,
            "PayBill accountReference is required (1-20 characters)",
        );
      }
      recipient.accountReference = accountReference;
    }
  }

  if (type === PAYOUT_TYPES.BANK) {
    if (amount < MIN_BANK_AMOUNT || amount > MAX_BANK_AMOUNT) {
      throw payoutError(
          ERROR_CODES.INVALID_AMOUNT,
          `Bank payout amount must be between ${MIN_BANK_AMOUNT} and ${MAX_BANK_AMOUNT} KES`,
      );
    }
    const bankCode = String(body?.recipient?.bankCode || body?.bankCode || "").trim();
    const accountNumber = String(
        body?.recipient?.accountNumber || body?.accountNumber || "",
    ).trim();
    if (!bankCode) {
      throw payoutError(ERROR_CODES.INVALID_BANK_ACCOUNT, "bankCode is required");
    }
    if (!accountNumber || accountNumber.length < 5 || accountNumber.length > 24) {
      throw payoutError(ERROR_CODES.INVALID_BANK_ACCOUNT, "Invalid bank account number");
    }
    recipient.bankCode = bankCode;
    recipient.accountNumber = accountNumber.replace(/\s/g, "");
    recipient.accountName = body?.recipient?.accountName || body?.accountName || "Safari Card Beneficiary";
  }

  if (type === PAYOUT_TYPES.SAFARITAP_WALLET) {
    const recipientUserId = String(
        body?.recipient?.userId || body?.recipientUserId || "",
    ).trim();
    const phone = normalizeKenyanPhoneNumber(
        body?.recipient?.phoneNumber || body?.phoneNumber,
    );
    if (!recipientUserId && !phone) {
      throw payoutError(
          ERROR_CODES.INVALID_RECIPIENT,
          "SafariTap wallet recipient requires phoneNumber or userId",
      );
    }
    if (phone) {
      recipient.phoneNumber = phone;
    }
    if (recipientUserId) {
      recipient.userId = recipientUserId;
    }
    recipient.name = body?.recipient?.name || body?.name || "SafariTap User";
  }

  return {
    type,
    amount,
    currency,
    narrative,
    clientRequestId,
    recipient,
  };
}

/**
 * @param {Object} body
 * @returns {Object}
 */
function validateBeneficiaryRequest(body) {
  const type = String(body?.type || "").toUpperCase();

  if (type === PAYOUT_TYPES.MPESA_B2C) {
    const phone = normalizeKenyanPhoneNumber(
        body?.recipient?.phoneNumber || body?.phoneNumber,
    );
    if (!phone) {
      throw payoutError(ERROR_CODES.INVALID_PHONE_NUMBER, "Invalid Kenyan M-Pesa phone number");
    }
    return {
      provider: "MPESA-B2C",
      account: phone,
      accountType: null,
      bankCode: null,
    };
  }

  if (type === PAYOUT_TYPES.MPESA_B2B) {
    const accountType = String(body?.accountType || body?.recipient?.accountType || "");
    const account = String(body?.recipient?.account || body?.account || "").trim();
    if (!Object.values(B2B_ACCOUNT_TYPES).includes(accountType)) {
      throw payoutError(ERROR_CODES.INVALID_RECIPIENT, "accountType must be TillNumber or PayBill");
    }
    if (!isDigitsInRange(account, 5, 10)) {
      throw payoutError(ERROR_CODES.INVALID_RECIPIENT, "Invalid Till or PayBill number");
    }
    if (accountType === B2B_ACCOUNT_TYPES.PAYBILL) {
      const accountReference = String(
          body?.recipient?.accountReference || body?.accountReference || "",
      ).trim();
      if (!accountReference) {
        throw payoutError(ERROR_CODES.INVALID_PAYBILL_REFERENCE, "PayBill accountReference is required");
      }
    }
    return {
      provider: "MPESA-B2B",
      account: account.replace(/\D/g, ""),
      accountType,
      bankCode: null,
    };
  }

  if (type === PAYOUT_TYPES.BANK) {
    const bankCode = String(body?.recipient?.bankCode || body?.bankCode || "").trim();
    const accountNumber = String(
        body?.recipient?.accountNumber || body?.accountNumber || "",
    ).trim();
    if (!bankCode || !accountNumber) {
      throw payoutError(ERROR_CODES.INVALID_BANK_ACCOUNT, "bankCode and accountNumber are required");
    }
    return {
      provider: "PESALINK",
      account: accountNumber.replace(/\s/g, ""),
      accountType: null,
      bankCode,
    };
  }

  if (type === PAYOUT_TYPES.SAFARITAP_WALLET) {
    const recipientUserId = String(
        body?.recipient?.userId || body?.recipientUserId || "",
    ).trim();
    const phone = normalizeKenyanPhoneNumber(
        body?.recipient?.phoneNumber || body?.phoneNumber,
    );
    if (!recipientUserId && !phone) {
      throw payoutError(
          ERROR_CODES.INVALID_RECIPIENT,
          "SafariTap wallet recipient requires phoneNumber or userId",
      );
    }
    return {
      provider: "SAFARITAP_WALLET",
      account: phone || recipientUserId,
      accountType: "SafariTapWallet",
      bankCode: null,
      phoneNumber: phone || null,
      userId: recipientUserId || null,
      name: body?.recipient?.name || body?.name || null,
    };
  }

  throw payoutError(ERROR_CODES.UNSUPPORTED_PAYOUT_TYPE, `Unsupported validation type: ${type}`);
}

module.exports = {
  normalizeKenyanPhoneNumber,
  validateCreatePayoutRequest,
  validateBeneficiaryRequest,
  SUPPORTED_CURRENCY,
};
