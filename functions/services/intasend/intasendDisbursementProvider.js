/**
 * @fileoverview IntaSend send-money / disbursement API adapter.
 * Separate from collection checkout in paymentRailService.js.
 */

const {
  intaSendRequest,
  isDisbursementStubMode,
  getIntaSendApiConfig,
} = require("./intasendClient");

/** IntaSend send-money provider identifiers. */
const DISBURSEMENT_PROVIDERS = Object.freeze({
  MPESA_B2C: "MPESA-B2C",
  MPESA_B2B: "MPESA-B2B",
  PESALINK: "PESALINK",
});

/**
 * @returns {string|null}
 */
function getDeviceId() {
  return process.env.INTASEND_DEVICE_ID || null;
}

/**
 * @returns {string|null}
 */
function getDisbursementCallbackUrl() {
  return process.env.INTASEND_DISBURSEMENT_CALLBACK_URL ||
    process.env.SAFARI_CARD_DISBURSEMENT_WEBHOOK_URL ||
    null;
}

/**
 * @param {Object} params
 * @param {string} params.provider
 * @param {string} params.currency
 * @param {Object[]} params.transactions
 * @param {string} [params.batchReference]
 * @param {string} [params.callbackUrl]
 * @returns {Promise<Object>}
 */
async function initiateSendMoney(params) {
  const {
    provider,
    currency,
    transactions,
    batchReference = null,
    callbackUrl = getDisbursementCallbackUrl(),
  } = params;

  if (isDisbursementStubMode()) {
    const trackingId = `stub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      tracking_id: trackingId,
      file_id: `stub_file_${trackingId.slice(-6)}`,
      status: "Preview and Approve",
      status_code: "BP103",
      batch_reference: batchReference,
      transactions: transactions.map((tx, idx) => ({
        ...tx,
        request_reference_id: tx.request_reference_id || `stub-ref-${idx}`,
        status: "Pending",
        status_code: "TP101",
      })),
      stub: true,
    };
  }

  /** @type {Record<string, unknown>} */
  const body = {
    currency: String(currency || "KES").toUpperCase(),
    provider,
    country: "KE",
    requires_approval: "NO",
    transactions,
  };

  const deviceId = getDeviceId();
  if (deviceId) {
    body.device_id = deviceId;
  }
  if (batchReference) {
    body.batch_reference = String(batchReference).slice(0, 70);
  }
  if (callbackUrl) {
    body.callback_url = callbackUrl;
  }

  return intaSendRequest("POST", "/api/v1/send-money/initiate/", { body });
}

/**
 * Approve a send-money batch (required when requires_approval=YES; safe to call after NO initiate).
 * @param {Object} initiateResponse
 * @returns {Promise<Object>}
 */
async function approveSendMoney(initiateResponse) {
  if (isDisbursementStubMode()) {
    const trackingId = initiateResponse.tracking_id;
    return {
      ...initiateResponse,
      status: "Completed",
      status_code: "BC100",
      transactions: (initiateResponse.transactions || []).map((tx) => ({
        ...tx,
        transaction_id: `stub_tx_${Math.random().toString(36).slice(2, 8)}`,
        status: "Successful",
        status_code: "TS100",
        provider_reference: `STUB${Date.now()}`,
      })),
      stub: true,
    };
  }

  return intaSendRequest("POST", "/api/v1/send-money/approve/", {
    body: initiateResponse,
  });
}

/**
 * Initiate + auto-approve in one server-side flow.
 * @param {Object} params
 * @returns {Promise<Object>}
 */
async function initiateAndApproveSendMoney(params) {
  const initiated = await initiateSendMoney(params);
  if (params.requiresApproval === "YES") {
    return approveSendMoney(initiated);
  }
  if (initiated.requires_approval === "YES" ||
      initiated.status_code === "BP103") {
    return approveSendMoney(initiated);
  }
  return initiated;
}

/**
 * @param {string} trackingId
 * @returns {Promise<Object>}
 */
async function getSendMoneyStatus(trackingId) {
  if (!trackingId) {
    throw new Error("trackingId is required");
  }

  if (isDisbursementStubMode()) {
    return {
      tracking_id: trackingId,
      status: "Completed",
      status_code: "BC100",
      transactions: [{
        status: "Successful",
        status_code: "TS100",
        transaction_id: `stub_tx_${trackingId.slice(-6)}`,
        provider_reference: `STUB${trackingId.slice(-8)}`,
      }],
      stub: true,
    };
  }

  return intaSendRequest("POST", "/api/v1/send-money/status/", {
    body: { tracking_id: trackingId },
  });
}

/**
 * @param {Object} params
 * @returns {Promise<Object>}
 */
async function validateAccount(params) {
  const {
    account,
    provider,
    accountType = null,
    bankCode = null,
    country = "KE",
  } = params;

  if (isDisbursementStubMode()) {
    return {
      account: String(account),
      name: "Stub Beneficiary",
      status: "valid",
      stub: true,
    };
  }

  /** @type {Record<string, unknown>} */
  const body = {
    account: String(account),
    provider,
    country,
  };
  if (accountType) {
    body.account_type = accountType;
  }
  if (bankCode) {
    body.bank_code = String(bankCode);
  }

  return intaSendRequest("POST", "/api/v1/send-money/validate-accounts/", { body });
}

/**
 * @returns {Promise<Array<{ bank_name: string, bank_code: string }>>}
 */
async function listKenyanBankCodes() {
  if (isDisbursementStubMode()) {
    return [
      { bank_name: "KCB", bank_code: "1" },
      { bank_name: "Equity Bank", bank_code: "68" },
      { bank_name: "Cooperative Bank", bank_code: "11" },
    ];
  }

  const { apiHost } = getIntaSendApiConfig();
  const data = await intaSendRequest("GET", "/api/v1/send-money/bank-codes/ke/");
  return Array.isArray(data) ? data : [];
}

/**
 * @param {Object} tx
 * @returns {Object}
 */
function buildMpesaB2cTransaction(tx) {
  return {
    name: tx.name || "Safari Card Customer",
    account: String(tx.account),
    amount: String(Number(tx.amount).toFixed(2)),
    narrative: tx.narrative || "Safari Card transfer",
    request_reference_id: tx.requestReferenceId || undefined,
  };
}

/**
 * @param {Object} tx
 * @returns {Object}
 */
function buildMpesaB2bTransaction(tx) {
  /** @type {Record<string, unknown>} */
  const row = {
    name: tx.name || "Safari Card Merchant",
    account: String(tx.account),
    account_type: tx.accountType,
    amount: String(Number(tx.amount).toFixed(2)),
    narrative: tx.narrative || "Safari Card payment",
    request_reference_id: tx.requestReferenceId || undefined,
  };
  if (tx.accountType === "PayBill") {
    row.account_reference = String(tx.accountReference || "");
  }
  return row;
}

/**
 * @param {Object} tx
 * @returns {Object}
 */
function buildBankTransaction(tx) {
  return {
    name: tx.name || "Safari Card Beneficiary",
    account: String(tx.account),
    bank_code: String(tx.bankCode),
    amount: String(Number(tx.amount).toFixed(2)),
    narrative: tx.narrative || "Safari Card bank transfer",
    request_reference_id: tx.requestReferenceId || undefined,
  };
}

module.exports = {
  DISBURSEMENT_PROVIDERS,
  initiateSendMoney,
  approveSendMoney,
  initiateAndApproveSendMoney,
  getSendMoneyStatus,
  validateAccount,
  listKenyanBankCodes,
  buildMpesaB2cTransaction,
  buildMpesaB2bTransaction,
  buildBankTransaction,
  getDisbursementCallbackUrl,
};
