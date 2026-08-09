/**
 * @fileoverview B2B Send — saved recipients (merchants) per partner.
 */

const config = require("../config");
const {collection, serverTimestamp} = require("../libs/firestore");

const COL = config.collections.partnerRecipients;

const DELIVERY_METHODS = Object.freeze({
  bank_transfer: "bank_transfer",
});

/**
 * @returns {string}
 */
function generateRecipientId() {
  return `rcpt_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
}

/**
 * @param {FirebaseFirestore.DocumentData|null|undefined} data
 * @param {string} id
 * @returns {Object}
 */
function serializeRecipient(id, data) {
  return {
    id,
    partnerId: data.partnerId || null,
    displayName: data.displayName || null,
    currency: data.currency || null,
    deliveryMethod: data.deliveryMethod || DELIVERY_METHODS.bank_transfer,
    bankName: data.bankName || null,
    accountName: data.accountName || null,
    accountNumber: data.accountNumber || null,
    country: data.country || null,
    metadata: data.metadata && typeof data.metadata === "object" ? data.metadata : {},
    status: data.status || "active",
    createdAt: data.createdAt?.toDate?.()?.toISOString?.() ?? null,
    updatedAt: data.updatedAt?.toDate?.()?.toISOString?.() ?? null,
  };
}

/**
 * @param {Object} body
 * @returns {Object}
 */
function normalizeRecipientInput(body = {}) {
  const displayName = body.displayName != null ?
    String(body.displayName).trim() :
    (body.name != null ? String(body.name).trim() : "");
  const currency = body.currency != null ? String(body.currency).trim().toUpperCase() : "";
  const deliveryMethod = body.deliveryMethod != null ?
    String(body.deliveryMethod).trim().toLowerCase() :
    DELIVERY_METHODS.bank_transfer;
  const bankName = body.bankName != null ? String(body.bankName).trim() : "";
  const accountName = body.accountName != null ? String(body.accountName).trim() : "";
  const accountNumber = body.accountNumber != null ?
    String(body.accountNumber).trim().replace(/\s+/g, "") :
    (body.iban != null ? String(body.iban).trim().replace(/\s+/g, "") : "");
  const country = body.country != null ?
    String(body.country).trim().toUpperCase() :
    (currency === "AED" ? "AE" : null);
  const metadata = body.metadata && typeof body.metadata === "object" ? body.metadata : {};

  if (!displayName) {
    const err = new Error("displayName is required");
    err.statusCode = 400;
    err.code = "INVALID_ARGUMENT";
    throw err;
  }
  if (!currency || currency.length !== 3) {
    const err = new Error("currency must be a 3-letter code (e.g. AED)");
    err.statusCode = 400;
    err.code = "INVALID_ARGUMENT";
    throw err;
  }
  if (deliveryMethod !== DELIVERY_METHODS.bank_transfer) {
    const err = new Error(`Unsupported deliveryMethod "${deliveryMethod}"`);
    err.statusCode = 400;
    err.code = "INVALID_ARGUMENT";
    throw err;
  }
  if (!bankName || !accountName || !accountNumber) {
    const err = new Error("bankName, accountName, and accountNumber (IBAN) are required");
    err.statusCode = 400;
    err.code = "INVALID_ARGUMENT";
    throw err;
  }

  return {
    displayName,
    currency,
    deliveryMethod,
    bankName,
    accountName,
    accountNumber,
    country,
    metadata,
  };
}

/**
 * @param {string} partnerId
 * @param {Object} body
 * @param {string} actorUid
 * @returns {Promise<Object>}
 */
async function createRecipient(partnerId, body, actorUid) {
  if (!partnerId) {
    const err = new Error("partnerId is required");
    err.statusCode = 400;
    throw err;
  }
  const input = normalizeRecipientInput(body);
  const id = generateRecipientId();
  const data = {
    id,
    partnerId: String(partnerId),
    ...input,
    status: "active",
    createdByUid: actorUid || null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  await collection(COL).doc(id).set(data);
  return serializeRecipient(id, data);
}

/**
 * @param {string} partnerId
 * @param {string} recipientId
 * @returns {Promise<Object|null>}
 */
async function getRecipient(partnerId, recipientId) {
  const doc = await collection(COL).doc(String(recipientId)).get();
  if (!doc.exists) return null;
  const data = doc.data() || {};
  if (String(data.partnerId) !== String(partnerId)) return null;
  if (data.status === "deleted") return null;
  return serializeRecipient(doc.id, data);
}

/**
 * @param {string} partnerId
 * @param {{ currency?: string|null, limit?: number }} [opts]
 * @returns {Promise<{ recipients: Object[] }>}
 */
async function listRecipients(partnerId, opts = {}) {
  const lim = Math.min(Math.max(Number(opts.limit) || 50, 1), 100);
  const currency = opts.currency ? String(opts.currency).toUpperCase() : null;
  // Simple partnerId query; filter currency/status in memory (avoids composite index).
  const snap = await collection(COL)
      .where("partnerId", "==", String(partnerId))
      .limit(200)
      .get();

  let recipients = snap.docs
      .map((d) => serializeRecipient(d.id, d.data() || {}))
      .filter((r) => r.status === "active");

  if (currency) {
    recipients = recipients.filter((r) => r.currency === currency);
  }

  recipients.sort((a, b) => {
    const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
    const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
    return tb - ta;
  });

  return {recipients: recipients.slice(0, lim)};
}

/**
 * @param {string} partnerId
 * @param {string} recipientId
 * @param {Object} body
 * @param {string} actorUid
 * @returns {Promise<Object>}
 */
async function updateRecipient(partnerId, recipientId, body, actorUid) {
  const existing = await getRecipient(partnerId, recipientId);
  if (!existing) {
    const err = new Error("Recipient not found");
    err.statusCode = 404;
    err.code = "NOT_FOUND";
    throw err;
  }

  const merged = {
    displayName: body.displayName ?? existing.displayName,
    name: body.displayName ?? existing.displayName,
    currency: body.currency ?? existing.currency,
    deliveryMethod: body.deliveryMethod ?? existing.deliveryMethod,
    bankName: body.bankName ?? existing.bankName,
    accountName: body.accountName ?? existing.accountName,
    accountNumber: body.accountNumber ?? existing.accountNumber,
    iban: body.accountNumber ?? existing.accountNumber,
    country: body.country ?? existing.country,
    metadata: body.metadata ?? existing.metadata,
  };
  const input = normalizeRecipientInput(merged);
  const patch = {
    ...input,
    updatedByUid: actorUid || null,
    updatedAt: serverTimestamp(),
  };
  await collection(COL).doc(String(recipientId)).set(patch, {merge: true});
  return getRecipient(partnerId, recipientId);
}

/**
 * Soft-delete a recipient.
 *
 * @param {string} partnerId
 * @param {string} recipientId
 * @returns {Promise<{ deleted: true, id: string }>}
 */
async function deleteRecipient(partnerId, recipientId) {
  const existing = await getRecipient(partnerId, recipientId);
  if (!existing) {
    const err = new Error("Recipient not found");
    err.statusCode = 404;
    err.code = "NOT_FOUND";
    throw err;
  }
  await collection(COL).doc(String(recipientId)).set(
      {
        status: "deleted",
        updatedAt: serverTimestamp(),
      },
      {merge: true},
  );
  return {deleted: true, id: String(recipientId)};
}

module.exports = {
  DELIVERY_METHODS,
  createRecipient,
  getRecipient,
  listRecipients,
  updateRecipient,
  deleteRecipient,
  serializeRecipient,
  normalizeRecipientInput,
};
