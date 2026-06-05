/**
 * @fileoverview B2B hosted payment links — create/list for platform admin and partner org admin.
 * Payer checkout reads via GET /b2bPortal/public/payment-links/:linkId?partner=
 */

const crypto = require("crypto");
const admin = require("../admin");
const config = require("../config");
const { collection, serverTimestamp } = require("../libs/firestore");
const partnerService = require("./partnerService");

const VALID_CURRENCIES = ["USD", "KES", "USDT", "NGN", "GHS"];
const VALID_STATUSES = ["active", "cancelled", "paid"];
const MAX_LIST = 100;

/**
 * Canonical base URL for payer links (GET /b2bPortal/l/:linkId).
 * Set PAYMENT_LINK_BASE_URL when pay.truepay.africa DNS is live; otherwise defaults to this Cloud Function.
 *
 * @returns {string}
 */
function paymentLinkBaseUrl() {
  const explicit = process.env.PAYMENT_LINK_BASE_URL;
  if (explicit && String(explicit).trim()) {
    return String(explicit).trim().replace(/\/$/, "");
  }
  const region = config.region || "us-central1";
  const project =
    process.env.GCLOUD_PROJECT ||
    process.env.GCP_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    "truepay-72060";
  return `https://${region}-${project}.cloudfunctions.net/b2bPortal`;
}

/**
 * @param {unknown} body
 * @returns {number}
 */
function parseExpiryHours(body) {
  if (!body || typeof body !== "object") {
    return null;
  }
  if (body.noExpiry === true || body.expiryHours === null) {
    return null;
  }
  if (body.expiryHours != null) {
    const h = Number(body.expiryHours);
    if (Number.isFinite(h) && h > 0 && h <= 8760) {
      return h;
    }
    if (h === 0) {
      return null;
    }
  }
  const raw = body.linkExpiry ?? body.expiry;
  if (raw == null) {
    return null;
  }
  if (typeof raw === "number" && raw > 0 && raw <= 8760) {
    return raw;
  }
  if (typeof raw === "string") {
    const m = raw.trim().match(/^(\d+)\s*(hour|hours|hr|h|day|days|week|weeks)?$/i);
    if (m) {
      const n = parseInt(m[1], 10);
      const unit = (m[2] || "hour").toLowerCase();
      if (unit.startsWith("day")) {
        return n * 24;
      }
      if (unit.startsWith("week")) {
        return n * 24 * 7;
      }
      return n;
    }
  }
  return null;
}

/**
 * @returns {string}
 */
function generateLinkId() {
  return `pl_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
}

/**
 * @param {string} linkId
 * @param {string} partnerId
 * @returns {string}
 */
function buildHostedUrl(linkId, partnerId) {
  const base = paymentLinkBaseUrl();
  return `${base}/l/${encodeURIComponent(linkId)}?partner=${encodeURIComponent(partnerId)}`;
}

/**
 * Path-only post-payment URL for IntaSend redirect_url (no query string — IntaSend rejects & and ?).
 *
 * @param {string} linkId
 * @returns {string}
 */
function buildHostedSuccessUrl(linkId) {
  const explicit = process.env.B2B_CHECKOUT_REDIRECT_URL;
  if (explicit && String(explicit).trim()) {
    return String(explicit).trim()
        .replace(/\{linkId\}/g, linkId)
        .replace(/\/$/, "");
  }
  const base = paymentLinkBaseUrl();
  return `${base}/l/${linkId}/success`;
}

/**
 * @param {Object} data
 * @returns {string}
 */
function effectiveStatus(data) {
  const status = data.status || "active";
  if (status === "paid") {
    return "active";
  }
  if (status === "cancelled") {
    return status;
  }
  if (status !== "active") {
    return status;
  }
  const exp = data.expiresAt?.toDate?.() ||
    (data.expiresAt ? new Date(data.expiresAt) : null);
  if (exp && exp.getTime() < Date.now()) {
    return "expired";
  }
  return "active";
}

/**
 * @param {FirebaseFirestore.DocumentSnapshot} doc
 * @param {{ includeUrl?: boolean }} [opts]
 * @returns {Object}
 */
function serializePaymentLink(doc, opts = {}) {
  const d = doc.data() || {};
  const linkId = doc.id;
  const partnerId = d.partnerId;
  const status = effectiveStatus(d);
  /** @type {Record<string, unknown>} */
  const out = {
    id: linkId,
    linkId,
    partnerId,
    partnerName: d.partnerName ?? null,
    amount: Number(d.amount),
    currency: d.currency,
    bookingReference: d.bookingReference,
    description: d.description ?? null,
    status,
    expiresAt: d.expiresAt?.toDate?.()?.toISOString() ?? null,
    createdAt: d.createdAt?.toDate?.()?.toISOString() ?? null,
    createdByUid: d.createdByUid ?? null,
    updatedAt: d.updatedAt?.toDate?.()?.toISOString() ?? null,
    paymentCount: Number(d.paymentCount || 0),
    lastPaidAt: d.lastPaidAt?.toDate?.()?.toISOString() ?? null,
    lastPayerName: d.lastPayerName ?? null,
    lastTransactionId: d.lastTransactionId ?? null,
    invoiceId: d.invoiceId ?? null,
    lastCheckoutRail: d.lastCheckoutRail ?? null,
  };
  if (opts.includeUrl !== false && partnerId && linkId) {
    out.url = buildHostedUrl(linkId, partnerId);
  }
  return out;
}

/**
 * @param {Object} body
 * @returns {{ amount: number, currency: string, bookingReference: string, description: string|null, expiryHours: number }}
 */
function validateCreateBody(body) {
  const amount = Number(body?.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Invalid amount. Amount must be a positive number.");
  }
  const currency = String(body?.currency || "USD").trim().toUpperCase();
  if (!VALID_CURRENCIES.includes(currency)) {
    throw new Error(`Invalid currency. Must be one of: ${VALID_CURRENCIES.join(", ")}`);
  }
  const bookingReference = String(
      body?.bookingReference ?? body?.bookingRef ?? "",
  ).trim();
  if (!bookingReference) {
    throw new Error("bookingReference is required");
  }
  if (body?.guestName !== undefined && body?.guestName !== null && String(body.guestName).trim()) {
    throw new Error(
        "guestName is no longer supported on payment links. Payers enter their name at checkout.",
    );
  }
  const description = body?.description ? String(body.description).trim() : null;
  const expiryHours = parseExpiryHours(body || {});
  return {
    amount,
    currency,
    bookingReference,
    description,
    expiryHours,
  };
}

/**
 * @param {string} partnerId
 * @param {string} actorUid
 * @param {Object} body
 * @returns {Promise<Object>}
 */
async function createPaymentLink(partnerId, actorUid, body) {
  const partner = await partnerService.getPartner(partnerId);
  if (!partner) {
    throw new Error("Partner not found");
  }
  const parsed = validateCreateBody(body);
  const linkId = generateLinkId();
  /** @type {Record<string, unknown>} */
  const linkDoc = {
    partnerId,
    partnerName: partner.name || null,
    amount: parsed.amount,
    currency: parsed.currency,
    bookingReference: parsed.bookingReference,
    description: parsed.description,
    status: "active",
    paymentCount: 0,
    createdAt: serverTimestamp(),
    createdByUid: actorUid,
  };
  if (parsed.expiryHours != null) {
    linkDoc.expiresAt = admin.firestore.Timestamp.fromDate(
        new Date(Date.now() + parsed.expiryHours * 60 * 60 * 1000),
    );
  }
  const ref = collection("paymentLinks").doc(linkId);
  await ref.set(linkDoc);
  const snap = await ref.get();
  return serializePaymentLink(snap);
}

/**
 * @param {string} partnerId
 * @param {number} [limit=50]
 * @param {string|null} [startAfterId]
 * @returns {Promise<{ paymentLinks: Object[], nextPageCursor: string|null }>}
 */
async function listPaymentLinksForPartner(partnerId, limit = 50, startAfterId = null) {
  const lim = Math.min(Math.max(parseInt(String(limit), 10) || 50, 1), MAX_LIST);
  let q = collection("paymentLinks")
      .where("partnerId", "==", partnerId)
      .orderBy("createdAt", "desc")
      .limit(lim);
  if (startAfterId) {
    const cursor = await collection("paymentLinks").doc(String(startAfterId)).get();
    if (cursor.exists) {
      q = q.startAfter(cursor);
    }
  }
  const snap = await q.get();
  const paymentLinks = snap.docs.map((doc) => serializePaymentLink(doc));
  const lastDoc = snap.docs.length === lim ? snap.docs[snap.docs.length - 1] : null;
  return {
    paymentLinks,
    nextPageCursor: lastDoc ? lastDoc.id : null,
  };
}

/**
 * @param {number} [limit=50]
 * @param {string|null} [partnerIdFilter]
 * @param {string|null} [startAfterId]
 * @returns {Promise<{ paymentLinks: Object[], nextPageCursor: string|null }>}
 */
async function listPaymentLinks(limit = 50, partnerIdFilter = null, startAfterId = null) {
  const lim = Math.min(Math.max(parseInt(String(limit), 10) || 50, 1), MAX_LIST);
  let q = collection("paymentLinks").orderBy("createdAt", "desc").limit(lim);
  if (partnerIdFilter) {
    q = collection("paymentLinks")
        .where("partnerId", "==", partnerIdFilter)
        .orderBy("createdAt", "desc")
        .limit(lim);
  }
  if (startAfterId) {
    const cursor = await collection("paymentLinks").doc(String(startAfterId)).get();
    if (cursor.exists) {
      q = q.startAfter(cursor);
    }
  }
  const snap = await q.get();
  const paymentLinks = snap.docs.map((doc) => serializePaymentLink(doc));
  const lastDoc = snap.docs.length === lim ? snap.docs[snap.docs.length - 1] : null;
  return {
    paymentLinks,
    nextPageCursor: lastDoc ? lastDoc.id : null,
  };
}

/**
 * @param {string} linkId
 * @returns {Promise<Object|null>}
 */
async function getPaymentLink(linkId) {
  if (!linkId) {
    return null;
  }
  const doc = await collection("paymentLinks").doc(linkId).get();
  if (!doc.exists) {
    return null;
  }
  return serializePaymentLink(doc);
}

/**
 * Hard-delete a payment link (platform super admin).
 *
 * @param {string} linkId
 * @returns {Promise<{ linkId: string, partnerId: string, partnerName: string|null }>}
 */
async function deletePaymentLink(linkId, options = {}) {
  if (!linkId) {
    throw new Error("linkId is required");
  }
  const expectedPartnerId = options.partnerId || null;
  const ref = collection("paymentLinks").doc(linkId);
  const doc = await ref.get();
  if (!doc.exists) {
    throw new Error("Payment link not found");
  }
  const d = doc.data() || {};
  if (expectedPartnerId && d.partnerId !== expectedPartnerId) {
    throw new Error("Payment link not found");
  }
  const summary = {
    linkId: doc.id,
    partnerId: d.partnerId,
    partnerName: d.partnerName ?? null,
    bookingReference: d.bookingReference ?? null,
    amount: d.amount != null ? Number(d.amount) : null,
    currency: d.currency ?? null,
  };
  await ref.delete();
  return summary;
}

/**
 * Partial update of a payment link. URL / QR stay the same (same linkId + partnerId).
 *
 * @param {string} linkId
 * @param {string} actorUid
 * @param {Object} body
 * @param {{ partnerId?: string|null }} [options] - when set, link must belong to this partner
 * @returns {Promise<Object>}
 */
async function updatePaymentLink(linkId, actorUid, body, options = {}) {
  if (!linkId) {
    throw new Error("linkId is required");
  }
  const expectedPartnerId = options.partnerId || null;
  const ref = collection("paymentLinks").doc(linkId);
  const doc = await ref.get();
  if (!doc.exists) {
    throw new Error("Payment link not found");
  }
  const existing = doc.data() || {};
  if (expectedPartnerId && existing.partnerId !== expectedPartnerId) {
    throw new Error("Payment link not found");
  }
  if (existing.status === "cancelled") {
    throw new Error("Cannot edit a cancelled payment link");
  }

  const b = body && typeof body === "object" ? body : {};
  /** @type {Record<string, unknown>} */
  const updates = {};

  if (b.guestName !== undefined) {
    throw new Error(
        "guestName is no longer supported on payment links. Payers enter their name at checkout.",
    );
  }

  if (b.amount !== undefined) {
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("Invalid amount. Amount must be a positive number.");
    }
    updates.amount = amount;
  }

  if (b.currency !== undefined) {
    const currency = String(b.currency).trim().toUpperCase();
    if (!VALID_CURRENCIES.includes(currency)) {
      throw new Error(`Invalid currency. Must be one of: ${VALID_CURRENCIES.join(", ")}`);
    }
    updates.currency = currency;
  }

  if (b.bookingReference !== undefined || b.bookingRef !== undefined) {
    const bookingReference = String(b.bookingReference ?? b.bookingRef ?? "").trim();
    if (!bookingReference) {
      throw new Error("bookingReference cannot be empty");
    }
    updates.bookingReference = bookingReference;
  }

  if (b.description !== undefined) {
    updates.description = b.description ? String(b.description).trim() : null;
  }

  if (b.status !== undefined) {
    const status = String(b.status).trim().toLowerCase();
    if (!VALID_STATUSES.includes(status)) {
      throw new Error(`Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`);
    }
    updates.status = status;
  }

  const hasExpiryInput =
    b.linkExpiry !== undefined ||
    b.expiryHours !== undefined ||
    b.expiresAt !== undefined;

  if (hasExpiryInput) {
    if (b.expiresAt !== undefined && b.expiresAt !== null) {
      const d = new Date(b.expiresAt);
      if (Number.isNaN(d.getTime())) {
        throw new Error("Invalid expiresAt");
      }
      updates.expiresAt = admin.firestore.Timestamp.fromDate(d);
    } else {
      const hours = parseExpiryHours(b);
      updates.expiresAt = admin.firestore.Timestamp.fromDate(
          new Date(Date.now() + hours * 60 * 60 * 1000),
      );
    }
    const nextStatus = updates.status ?? existing.status ?? "active";
    if (
      nextStatus !== "cancelled" &&
      effectiveStatus(existing) === "expired"
    ) {
      updates.status = "active";
    }
  }

  if (Object.keys(updates).length === 0) {
    throw new Error("No valid fields to update");
  }

  updates.updatedAt = serverTimestamp();
  updates.updatedByUid = actorUid;

  await ref.update(updates);
  const after = await ref.get();
  return serializePaymentLink(after);
}

/**
 * Public payer read — validates partner query param matches stored link.
 *
 * @param {string} linkId
 * @param {string} partnerId
 * @returns {Promise<Object|null>}
 */
async function getPublicPaymentLink(linkId, partnerId) {
  if (!linkId || !partnerId) {
    return null;
  }
  const doc = await collection("paymentLinks").doc(linkId).get();
  if (!doc.exists) {
    return null;
  }
  const d = doc.data() || {};
  if (d.partnerId !== partnerId) {
    return null;
  }
  const status = effectiveStatus(d);
  return {
    id: doc.id,
    linkId: doc.id,
    partnerId: d.partnerId,
    partnerName: d.partnerName ?? null,
    amount: Number(d.amount),
    currency: d.currency,
    bookingReference: d.bookingReference,
    description: d.description ?? null,
    status,
    expiresAt: d.expiresAt?.toDate?.()?.toISOString() ?? null,
    paymentCount: Number(d.paymentCount || 0),
    lastPaidAt: d.lastPaidAt?.toDate?.()?.toISOString() ?? null,
    lastPayerName: d.lastPayerName ?? null,
  };
}

module.exports = {
  createPaymentLink,
  listPaymentLinksForPartner,
  listPaymentLinks,
  getPaymentLink,
  updatePaymentLink,
  deletePaymentLink,
  getPublicPaymentLink,
  buildHostedUrl,
  buildHostedSuccessUrl,
  paymentLinkBaseUrl,
  effectiveStatus,
  VALID_CURRENCIES,
  VALID_STATUSES,
};
