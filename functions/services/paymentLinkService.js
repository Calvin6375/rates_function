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
const VALID_STATUSES = ["active", "cancelled"];
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
  if (body && typeof body === "object") {
    if (body.expiryHours != null) {
      const h = Number(body.expiryHours);
      if (Number.isFinite(h) && h > 0 && h <= 8760) {
        return h;
      }
    }
    const raw = body.linkExpiry ?? body.expiry;
    if (raw != null && typeof raw === "number" && raw > 0 && raw <= 8760) {
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
  }
  return 24;
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
 * @param {Object} data
 * @returns {string}
 */
function effectiveStatus(data) {
  const status = data.status || "active";
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
    guestName: d.guestName ?? null,
    description: d.description ?? null,
    status,
    expiresAt: d.expiresAt?.toDate?.()?.toISOString() ?? null,
    createdAt: d.createdAt?.toDate?.()?.toISOString() ?? null,
    createdByUid: d.createdByUid ?? null,
    updatedAt: d.updatedAt?.toDate?.()?.toISOString() ?? null,
    updatedByUid: d.updatedByUid ?? null,
  };
  if (opts.includeUrl !== false && partnerId && linkId) {
    out.url = buildHostedUrl(linkId, partnerId);
  }
  return out;
}

/**
 * @param {Object} body
 * @returns {{ amount: number, currency: string, bookingReference: string, guestName: string|null, description: string|null, expiryHours: number }}
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
  const guestName = body?.guestName ? String(body.guestName).trim() : null;
  const description = body?.description ? String(body.description).trim() : null;
  const expiryHours = parseExpiryHours(body || {});
  return {
    amount,
    currency,
    bookingReference,
    guestName,
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
  const expiresAt = new Date(Date.now() + parsed.expiryHours * 60 * 60 * 1000);
  const ref = collection("paymentLinks").doc(linkId);
  await ref.set({
    partnerId,
    partnerName: partner.name || null,
    amount: parsed.amount,
    currency: parsed.currency,
    bookingReference: parsed.bookingReference,
    guestName: parsed.guestName,
    description: parsed.description,
    status: "active",
    expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
    createdAt: serverTimestamp(),
    createdByUid: actorUid,
  });
  const snap = await ref.get();
  return serializePaymentLink(snap);
}

/**
 * @param {string} partnerId
 * @param {number} [limit=50]
 * @returns {Promise<Object[]>}
 */
async function listPaymentLinksForPartner(partnerId, limit = 50) {
  const lim = Math.min(Math.max(parseInt(String(limit), 10) || 50, 1), MAX_LIST);
  const snap = await collection("paymentLinks")
      .where("partnerId", "==", partnerId)
      .orderBy("createdAt", "desc")
      .limit(lim)
      .get();
  return snap.docs.map((doc) => serializePaymentLink(doc));
}

/**
 * @param {number} [limit=50]
 * @param {string|null} [partnerIdFilter]
 * @returns {Promise<Object[]>}
 */
async function listPaymentLinks(limit = 50, partnerIdFilter = null) {
  const lim = Math.min(Math.max(parseInt(String(limit), 10) || 50, 1), MAX_LIST);
  let q = collection("paymentLinks").orderBy("createdAt", "desc").limit(lim);
  if (partnerIdFilter) {
    q = collection("paymentLinks")
        .where("partnerId", "==", partnerIdFilter)
        .orderBy("createdAt", "desc")
        .limit(lim);
  }
  const snap = await q.get();
  return snap.docs.map((doc) => serializePaymentLink(doc));
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
async function deletePaymentLink(linkId) {
  if (!linkId) {
    throw new Error("linkId is required");
  }
  const ref = collection("paymentLinks").doc(linkId);
  const doc = await ref.get();
  if (!doc.exists) {
    throw new Error("Payment link not found");
  }
  const d = doc.data() || {};
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
  if (existing.status === "paid") {
    throw new Error("Cannot edit a paid payment link");
  }

  const b = body && typeof body === "object" ? body : {};
  /** @type {Record<string, unknown>} */
  const updates = {};

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

  if (b.guestName !== undefined) {
    updates.guestName = b.guestName ? String(b.guestName).trim() : null;
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
    guestName: d.guestName ?? null,
    description: d.description ?? null,
    status,
    expiresAt: d.expiresAt?.toDate?.()?.toISOString() ?? null,
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
  paymentLinkBaseUrl,
  VALID_CURRENCIES,
  VALID_STATUSES,
};
