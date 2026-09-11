/**
 * @fileoverview Portal sandbox test payments: Firestore-backed per-user history and
 * onboarding checklist (`progress.testTransactionDone`). Machine `partnerSandbox` calls
 * can be attributed via `linkToken` (see GET /portal/onboarding).
 */

const crypto = require("crypto");
const {collection, firestore, serverTimestamp} = require("../libs/firestore");
const config = require("../config");
const partnerTestLedgerService = require("./partnerTestLedgerService");
const {serializeOnboardingDoc} = require("./b2bOnboardingService");

const LINK_TOKEN_COL = "sandboxLinkTokens";
const MAX_TRANSACTIONS = 50;

/**
 * @param {string} uid
 * @return {FirebaseFirestore.DocumentReference}
 */
function onboardingRef(uid) {
  return collection("onboarding").doc(uid);
}

/**
 * @return {string}
 */
function generateLinkToken() {
  return `sbxlnk_${crypto.randomBytes(16).toString("base64url")}`;
}

/**
 * Stable token for attributing `partnerSandbox` POST /payments to this dashboard user.
 *
 * @param {string} uid
 * @return {Promise<string>}
 */
async function ensureLinkToken(uid) {
  const ref = onboardingRef(uid);
  const snap = await ref.get();
  const existing =
    snap.exists &&
    snap.data()?.sandbox &&
    typeof snap.data().sandbox.linkToken === "string" ?
      snap.data().sandbox.linkToken.trim() :
      "";
  if (existing) {
    return existing;
  }

  const linkToken = generateLinkToken();
  const batch = firestore.batch();
  batch.set(
      ref,
      {
        sandbox: {linkToken},
        updatedAt: serverTimestamp(),
        ...(snap.exists ? {} : {createdAt: serverTimestamp(), onboardingStatus: "draft"}),
      },
      {merge: true},
  );
  batch.set(firestore.collection(LINK_TOKEN_COL).doc(linkToken), {
    uid,
    createdAt: serverTimestamp(),
  });
  await batch.commit();
  return linkToken;
}

/**
 * @param {string} linkToken
 * @return {Promise<string|null>}
 */
async function resolveUidFromLinkToken(linkToken) {
  const token = String(linkToken || "").trim();
  if (!token) return null;
  const snap = await firestore.collection(LINK_TOKEN_COL).doc(token).get();
  if (!snap.exists) return null;
  const uid = snap.data()?.uid;
  return typeof uid === "string" && uid.trim() ? uid.trim() : null;
}

/**
 * @param {Object} row
 * @param {string} [partnerId]
 * @return {Object}
 */
function normalizeTransactionRow(row, partnerId) {
  const id = String(row.transactionId || row.id || "").trim();
  const now = new Date().toISOString();
  return {
    id,
    transactionId: id,
    type: "b2b_payment",
    partnerId: partnerId || config.b2bSandbox.partnerId,
    amount: Number(row.amount),
    currency: String(row.currency || "KES").toUpperCase(),
    status: "completed",
    metadata: {
      reference: row.reference != null ? String(row.reference) : null,
      sandbox: true,
      ...(row.metadata && typeof row.metadata === "object" ? row.metadata : {}),
    },
    createdAt: row.createdAt || now,
    updatedAt: row.updatedAt || now,
  };
}

/**
 * @param {string} uid
 * @param {Object} txRow
 * @return {Promise<Object>}
 */
async function appendTransaction(uid, txRow) {
  const ref = onboardingRef(uid);
  const snap = await ref.get();
  const raw = snap.exists ? snap.data() : {};
  const existing = Array.isArray(raw.sandbox?.transactions) ?
    raw.sandbox.transactions :
    [];
  const txs = [
    txRow,
    ...existing.filter((t) => t && t.id !== txRow.id),
  ].slice(0, MAX_TRANSACTIONS);

  await ref.set(
      {
        sandbox: {
          ...(raw.sandbox || {}),
          transactions: txs,
        },
        progress: {
          ...(raw.progress || {}),
          testTransactionDone: true,
          testTransactionAt: serverTimestamp(),
          testTransactionId: txRow.id,
        },
        updatedAt: serverTimestamp(),
      },
      {merge: true},
  );
  return txRow;
}

/**
 * Persist a machine sandbox payment for the dashboard user identified by linkToken.
 *
 * @param {string} linkToken
 * @param {Object} payment
 * @return {Promise<Object|null>}
 */
async function recordTestFromPartnerSandbox(linkToken, payment) {
  const uid = await resolveUidFromLinkToken(linkToken);
  if (!uid) return null;
  const recorded = await partnerTestLedgerService.recordCollection(uid, {
    amount: payment.amount,
    currency: payment.currency,
    reference: payment.reference,
    metadata: payment.metadata,
    source: "partnerSandbox",
  });
  await appendTransaction(uid, recorded);
  return recorded;
}

/**
 * Run sandbox payment logic and persist for portal onboarding checklist.
 *
 * @param {string} uid
 * @param {Object} input
 * @param {number} input.amount
 * @param {string} [input.currency]
 * @param {string|null} [input.reference]
 * @param {Object} [input.metadata]
 * @return {Promise<Object>}
 */
async function runPortalSandboxPayment(uid, input) {
  const amount = Number(input.amount);
  const currency = input.currency || "KES";
  const reference = input.reference != null ? String(input.reference) : null;
  const metadata = input.metadata && typeof input.metadata === "object" ?
    input.metadata :
    {};

  const payment = await partnerTestLedgerService.recordCollection(uid, {
    amount,
    currency,
    reference,
    metadata,
    scenario: input.scenario,
    payerName: input.payerName,
    source: "portal",
  });
  await appendTransaction(uid, payment);
  return payment;
}

/**
 * @param {string} uid
 * @param {number} limit
 * @return {Promise<{ transactions: Object[], testTransactionDone: boolean }>}
 */
async function listPortalSandboxTransactions(uid, limit) {
  const ledger = await partnerTestLedgerService.listTransactions(uid, limit);
  const snap = await onboardingRef(uid).get();
  const data = snap.exists ?
    /** @type {Object|null} */ (serializeOnboardingDoc(snap.data())) :
    null;
  const legacy = Array.isArray(data?.sandbox?.transactions) ?
    data.sandbox.transactions :
    [];
  const seen = new Set(ledger.transactions.map((t) => t.id || t.transactionId));
  const merged = [
    ...ledger.transactions,
    ...legacy.filter((t) => t && !seen.has(t.id || t.transactionId)),
  ].slice(0, limit);
  const progressDone = data?.progress?.testTransactionDone === true;
  return {
    transactions: merged,
    testTransactionDone: progressDone || merged.length > 0,
    sandbox: true,
    environment: "test",
  };
}

/**
 * @param {string} uid
 * @return {Promise<{ linkToken: string, testTransactionDone: boolean }>}
 */
async function getSandboxOnboardingExtras(uid) {
  const linkToken = await ensureLinkToken(uid);
  const {testTransactionDone} = await listPortalSandboxTransactions(uid, 1);
  return {linkToken, testTransactionDone};
}

module.exports = {
  ensureLinkToken,
  resolveUidFromLinkToken,
  recordTestFromPartnerSandbox,
  runPortalSandboxPayment,
  listPortalSandboxTransactions,
  getSandboxOnboardingExtras,
};
