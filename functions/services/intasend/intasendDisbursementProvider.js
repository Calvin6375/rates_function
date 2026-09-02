/**
 * @fileoverview IntaSend send-money / disbursement API adapter.
 * Separate from collection checkout in paymentRailService.js.
 */

const {
  intaSendRequest,
  isDisbursementStubMode,
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
function getWalletId() {
  const id = String(process.env.INTASEND_WALLET_ID || "").trim();
  return id || null;
}

/**
 * IntaSend / Safaricom B2C rejects fractional KES more often than B2B.
 * Whole amounts are sent without trailing decimals (10 not 10.00).
 * @param {unknown} amount
 * @param {{ wholeKes?: boolean }} [opts]
 * @returns {string}
 */
function formatDisbursementAmount(amount, opts = {}) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) {
    return "0";
  }
  if (opts.wholeKes) {
    return String(Math.round(n));
  }
  const rounded = Math.round(n * 100) / 100;
  if (Number.isInteger(rounded)) {
    return String(rounded);
  }
  return rounded.toFixed(2);
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
  const walletId = getWalletId();
  if (walletId) {
    body.wallet_id = walletId;
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

  const payload = (initiateResponse && typeof initiateResponse === "object") ?
    {...initiateResponse} :
    {};
  const deviceId = getDeviceId();
  if (deviceId && (payload.device_id == null || payload.device_id === "")) {
    payload.device_id = deviceId;
  }
  return intaSendRequest("POST", "/api/v1/send-money/approve/", {
    body: payload,
  });
}

/**
 * Initiate + auto-approve in one server-side flow.
 * @param {Object} params
 * @returns {Promise<Object>}
 */
async function initiateAndApproveSendMoney(params) {
  const initiated = await initiateSendMoney(params);
  const needsApprove = params.requiresApproval === "YES" ||
    initiated.requires_approval === "YES" ||
    String(initiated.status_code || "").toUpperCase() === "BP103";

  console.log(JSON.stringify({
    event: "intasend.sendMoney.initiated",
    provider: params.provider,
    status: initiated.status || null,
    statusCode: initiated.status_code || null,
    trackingId: initiated.tracking_id || null,
    needsApprove,
    hasDeviceId: Boolean(getDeviceId()),
  }));

  if (!needsApprove) {
    return initiated;
  }

  try {
    return await approveSendMoney(initiated);
  } catch (approveErr) {
    console.error(JSON.stringify({
      event: "intasend.sendMoney.approveFailed",
      provider: params.provider,
      trackingId: initiated.tracking_id || null,
      statusCode: initiated.status_code || null,
      error: approveErr instanceof Error ? approveErr.message : String(approveErr),
      httpStatus: approveErr?.httpStatus || null,
      hasDeviceId: Boolean(getDeviceId()),
    }));
    throw approveErr;
  }
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
 * Static Kenya PesaLink bank codes from IntaSend docs (fallback when API auth fails).
 * @see https://developers.intasend.com/docs/bank
 * @type {Array<{ bank_name: string, bank_code: string }>}
 */
const FALLBACK_KENYA_BANK_CODES = Object.freeze([
  {bank_name: "KCB", bank_code: "1"},
  {bank_name: "Standard Charted Bank KE", bank_code: "2"},
  {bank_name: "Absa Bank Kenya", bank_code: "3"},
  {bank_name: "NCBA", bank_code: "7"},
  {bank_name: "Prime Bank", bank_code: "10"},
  {bank_name: "Cooperative Bank", bank_code: "11"},
  {bank_name: "National Bank", bank_code: "12"},
  {bank_name: "Citibank", bank_code: "16"},
  {bank_name: "Habib Bank AG Zurich", bank_code: "17"},
  {bank_name: "Middle East Bank", bank_code: "18"},
  {bank_name: "Bank of Africa", bank_code: "19"},
  {bank_name: "Consolidated Bank", bank_code: "23"},
  {bank_name: "Credit Bank Ltd", bank_code: "25"},
  {bank_name: "Stanbic Bank", bank_code: "31"},
  {bank_name: "ABC Bank", bank_code: "35"},
  {bank_name: "Spire Bank", bank_code: "49"},
  {bank_name: "Paramount Universal Bank", bank_code: "50"},
  {bank_name: "Kingdom Bank", bank_code: "51"},
  {bank_name: "Guaranty Bank", bank_code: "53"},
  {bank_name: "Victoria Commercial Bank", bank_code: "54"},
  {bank_name: "Guardian Bank", bank_code: "55"},
  {bank_name: "I&M Bank", bank_code: "57"},
  {bank_name: "Housing Finance Company Limited (HFCK)", bank_code: "61"},
  {bank_name: "DTB", bank_code: "63"},
  {bank_name: "Mayfair Bank Limited", bank_code: "65"},
  {bank_name: "Sidian Bank", bank_code: "66"},
  {bank_name: "Equity Bank", bank_code: "68"},
  {bank_name: "Family Bank", bank_code: "70"},
  {bank_name: "Gulf African Bank", bank_code: "72"},
  {bank_name: "First Community Bank", bank_code: "74"},
  {bank_name: "KWFT Bank", bank_code: "78"},
]);

/**
 * @param {unknown} data
 * @returns {Array<{ bank_name: string, bank_code: string }>}
 */
function normalizeBankCodesResponse(data) {
  let rows = [];
  if (Array.isArray(data)) {
    rows = data;
  } else if (data && typeof data === "object") {
    const obj = /** @type {Record<string, unknown>} */ (data);
    if (Array.isArray(obj.results)) rows = obj.results;
    else if (Array.isArray(obj.banks)) rows = obj.banks;
    else if (Array.isArray(obj.data)) rows = obj.data;
  }

  return rows
      .map((row) => {
        if (!row || typeof row !== "object") return null;
        const r = /** @type {Record<string, unknown>} */ (row);
        const bankCode = String(r.bank_code ?? r.bankCode ?? r.code ?? "").trim();
        const bankName = String(r.bank_name ?? r.bankName ?? r.name ?? "").trim();
        if (!bankCode || !bankName) return null;
        return {bank_name: bankName, bank_code: bankCode};
      })
      .filter(Boolean);
}

/**
 * List Kenya bank codes for PesaLink Send Money.
 * Uses IntaSend GET /api/v1/send-money/bank-codes/ke/ (docs allow unauthenticated).
 * Falls back to the published Kenya list if the API returns auth/network errors.
 *
 * @returns {Promise<{ banks: Array<{ bank_name: string, bank_code: string }>, source: string }>}
 */
async function listKenyanBankCodes() {
  if (isDisbursementStubMode()) {
    return {
      banks: FALLBACK_KENYA_BANK_CODES.slice(0, 3),
      source: "stub",
    };
  }

  const paths = [
    "/api/v1/send-money/bank-codes/ke/",
    "/api/v1/send-money/bank-codes/KE/",
  ];

  for (const path of paths) {
    // Prefer no-auth first — OpenAPI marks this route with empty security.
    for (const skipAuth of [true, false]) {
      try {
        const data = await intaSendRequest("GET", path, {skipAuth});
        const banks = normalizeBankCodesResponse(data);
        if (banks.length) {
          return {banks, source: skipAuth ? "intasend_public" : "intasend"};
        }
      } catch (err) {
        console.warn("listKenyanBankCodes:", path, skipAuth ? "noauth" : "auth", err.message);
      }
    }
  }

  console.warn("listKenyanBankCodes: using static Kenya fallback (IntaSend list unavailable)");
  return {banks: [...FALLBACK_KENYA_BANK_CODES], source: "fallback"};
}

/**
 * @param {Object} tx
 * @returns {Object}
 */
function buildMpesaB2cTransaction(tx) {
  const account = String(tx.account || "").replace(/\D/g, "");
  return {
    name: tx.name || "Safari Card Customer",
    account,
    phone_number: account,
    amount: formatDisbursementAmount(tx.amount, {wholeKes: true}),
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
    amount: formatDisbursementAmount(tx.amount),
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
    amount: formatDisbursementAmount(tx.amount),
    narrative: tx.narrative || "Safari Card bank transfer",
    request_reference_id: tx.requestReferenceId || undefined,
  };
}

module.exports = {
  DISBURSEMENT_PROVIDERS,
  FALLBACK_KENYA_BANK_CODES,
  initiateSendMoney,
  approveSendMoney,
  initiateAndApproveSendMoney,
  getSendMoneyStatus,
  validateAccount,
  listKenyanBankCodes,
  normalizeBankCodesResponse,
  buildMpesaB2cTransaction,
  buildMpesaB2bTransaction,
  buildBankTransaction,
  formatDisbursementAmount,
  getDisbursementCallbackUrl,
};
