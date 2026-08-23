/**
 * @fileoverview IntaSend send-money (disbursement) webhook processing.
 * Separate from collection webhook in webhookApi.js / payments.js.
 */

const admin = require("../../admin");
const config = require("../../config");
const { collection, serverTimestamp } = require("../../libs/firestore");
const paymentsLib = require("../../libs/payments");
const safariCardPayoutService = require("./safariCardPayoutService");

const RECEIPTS_COL = config.collections.webhookReceipts;

/**
 * @param {string} eventKey
 * @returns {Promise<boolean>}
 */
async function isDuplicateWebhook(eventKey) {
  const ref = collection(RECEIPTS_COL).doc(`intasend_disbursement_${eventKey}`);
  const doc = await ref.get();
  return doc.exists && doc.data()?.processed === true;
}

/**
 * @param {string} eventKey
 * @param {Object} payload
 * @returns {Promise<void>}
 */
async function markWebhookProcessed(eventKey, payload) {
  await collection(RECEIPTS_COL).doc(`intasend_disbursement_${eventKey}`).set({
    provider: "intasend_disbursement",
    eventKey,
    trackingId: payload.tracking_id || null,
    status: payload.status || null,
    statusCode: payload.status_code || null,
    processed: true,
    processedAt: serverTimestamp(),
    receivedAt: serverTimestamp(),
  }, { merge: true });
}

/**
 * @param {Object} payload
 * @returns {string}
 */
function buildEventKey(payload) {
  const trackingId = payload.tracking_id || "unknown";
  const statusCode = payload.status_code || payload.status || "event";
  const tx = Array.isArray(payload.transactions) ? payload.transactions[0] : null;
  const txCode = tx?.status_code || tx?.transaction_id || "";
  return `${trackingId}_${statusCode}_${txCode}`;
}

/**
 * @param {Object} payload
 * @returns {Promise<{ success: boolean, duplicate?: boolean, payout?: Object|null }>}
 */
async function processDisbursementWebhook(payload) {
  if (!payload || typeof payload !== "object") {
    return { success: false, error: "Invalid payload" };
  }

  const eventKey = buildEventKey(payload);
  if (await isDuplicateWebhook(eventKey)) {
    return { success: true, duplicate: true };
  }

  const result = await safariCardPayoutService.applyProviderStatusUpdate(payload);
  await markWebhookProcessed(eventKey, payload);

  return {
    success: true,
    handled: result.handled,
    payout: result.payout || null,
    duplicate: result.duplicate || false,
  };
}

/**
 * Verify IntaSend webhook using existing shared HMAC/challenge helpers.
 * @param {Object} req
 * @param {string|null} secret
 * @param {string|null} challenge
 * @returns {boolean}
 */
function verifyDisbursementWebhook(req, secret, challenge) {
  const payload = req.body || {};
  const receivedChallenge =
    req.get("x-intasend-challenge") || req.query?.challenge || payload.challenge || null;
  const challengeOk = !!challenge && receivedChallenge === challenge;

  let signatureOk = false;
  if (secret) {
    signatureOk = paymentsLib.verifySignature(secret, req);
  }

  return signatureOk || challengeOk;
}

module.exports = {
  processDisbursementWebhook,
  verifyDisbursementWebhook,
  buildEventKey,
};
