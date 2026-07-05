/**
 * @fileoverview Safaricom Daraja B2B settlement rail (stub when credentials absent).
 * Implements settlement payout interface — isolated from funding providers.
 */

const axios = require("axios");
const config = require("../../config");
const { createLogger } = require("../../utils/paymentOpsLogger");
const { SETTLEMENT_RAILS } = require("../../utils/fundingTypes");

const RAIL_ID = SETTLEMENT_RAILS.daraja_b2b;
const logger = createLogger({ service: "darajaRail" });

/**
 * @returns {boolean}
 */
function isStubMode() {
  const mode = String(config.daraja.stubMode || "auto").toLowerCase();
  if (mode === "true" || mode === "1") {
    return true;
  }
  if (mode === "false" || mode === "0") {
    return false;
  }
  return !config.daraja.consumerKey || !config.daraja.consumerSecret;
}

/**
 * @returns {Promise<string|null>}
 */
async function getAccessToken() {
  if (isStubMode()) {
    return "stub_daraja_token";
  }

  const { consumerKey, consumerSecret, baseUrl } = config.daraja;
  if (!consumerKey || !consumerSecret) {
    throw new Error("Daraja credentials not configured");
  }

  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
  const response = await axios.get(
      `${baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
      {
        headers: { Authorization: `Basic ${auth}` },
        timeout: 15000,
      },
  );

  return response.data?.access_token || null;
}

/**
 * Initiate B2B payment to merchant Till / PayBill.
 *
 * @param {Object} params
 * @param {number} params.amountKes
 * @param {string} params.reference
 * @param {Object} params.destination { type: "till"|"paybill"|"bank", tillNumber?, paybill?, account? }
 * @returns {Promise<{ providerReference: string, status: string, raw?: Object }>}
 */
async function initiateB2BPayment(params) {
  const { amountKes, reference, destination } = params;
  const numericAmount = Math.round(Number(amountKes));
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error("Invalid KES settlement amount");
  }

  if (isStubMode()) {
    logger.info("daraja.stub.initiated", { amountKes: numericAmount, reference, destination });
    return {
      providerReference: `stub_daraja_${reference}`,
      status: "processing",
      raw: { stub: true, amountKes: numericAmount, destination },
    };
  }

  const token = await getAccessToken();
  if (!token) {
    throw new Error("Daraja OAuth token unavailable");
  }

  /** @type {Record<string, unknown>} */
  const payload = {
    Initiator: config.daraja.initiatorName,
    SecurityCredential: config.daraja.initiatorPassword,
    CommandID: "BusinessPayBill",
    SenderIdentifierType: "4",
    RecieverIdentifierType: destination.type === "till" ? "2" : "4",
    Amount: String(numericAmount),
    PartyA: config.daraja.shortcode,
    PartyB: destination.paybill || destination.tillNumber,
    AccountReference: destination.account || reference,
    Remarks: "TruePay Tourist Payment",
    QueueTimeOutURL: process.env.DARAJA_TIMEOUT_URL || "",
    ResultURL: process.env.DARAJA_RESULT_URL || "",
  };

  const response = await axios.post(
      `${config.daraja.baseUrl}/mpesa/b2b/v1/paymentrequest`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: 20000,
      },
  );

  const body = response.data || {};
  return {
    providerReference: body.ConversationID || body.OriginatorConversationID || reference,
    status: "processing",
    raw: body,
  };
}

/**
 * @param {string} providerReference
 * @returns {Promise<{ status: string, raw?: Object }>}
 */
async function queryPaymentStatus(providerReference) {
  if (isStubMode()) {
    return { status: "completed", raw: { stub: true, providerReference } };
  }
  return { status: "processing", raw: { providerReference } };
}

/**
 * Normalize Daraja B2B callback payload.
 * @param {Object} payload
 * @returns {{ providerReference: string, status: "success"|"failed"|"pending", resultCode?: string, resultDesc?: string }|null}
 */
function normalizeCallback(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const result = payload.Result || payload.result || payload;
  const providerReference =
    result.ConversationID ||
    result.OriginatorConversationID ||
    payload.ConversationID ||
    null;

  if (!providerReference) {
    return null;
  }

  const resultCode = String(result.ResultCode ?? result.resultCode ?? "");
  let status = "pending";
  if (resultCode === "0") {
    status = "success";
  } else if (resultCode && resultCode !== "1") {
    status = "failed";
  }

  return {
    providerReference: String(providerReference),
    status,
    resultCode,
    resultDesc: result.ResultDesc || result.resultDesc || null,
  };
}

const darajaRail = {
  railId: RAIL_ID,
  isStubMode,
  initiateB2BPayment,
  queryPaymentStatus,
  normalizeCallback,
};

module.exports = darajaRail;
