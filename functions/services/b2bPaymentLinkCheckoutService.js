/**
 * @fileoverview Start B2B hosted payment-link checkout sessions and track payer status.
 */

const admin = require("../admin");
const config = require("../config");
const { collection, serverTimestamp } = require("../libs/firestore");
const paymentLinkService = require("./paymentLinkService");
const paymentRailService = require("./paymentRailService");

const firestore = admin.firestore();
const B2B_PURPOSE = "b2b_payment_link";

/**
 * @param {string} linkId
 * @param {string} partnerId
 * @returns {Promise<Object>}
 */
async function loadActiveLink(linkId, partnerId) {
  const link = await paymentLinkService.getPublicPaymentLink(linkId, partnerId);
  if (!link) {
    throw new Error("Payment link not found");
  }
  if (link.status === "expired") {
    throw new Error("Payment link has expired");
  }
  if (link.status === "paid") {
    throw new Error("Payment link is already paid");
  }
  if (link.status !== "active") {
    throw new Error(`Payment link is ${link.status}`);
  }
  return link;
}

/**
 * @param {string} linkId
 * @param {string} partnerId
 * @param {Object} [payer]
 * @param {string} [payer.email]
 * @param {string} [payer.phoneNumber]
 * @param {string} [payer.firstName]
 * @param {string} [payer.lastName]
 * @param {string} [payer.country]
 * @param {string} [rail]
 * @returns {Promise<Object>}
 */
async function startCheckout(linkId, partnerId, payer = {}, rail) {
  const link = await loadActiveLink(linkId, partnerId);
  const selectedRail = String(rail || paymentRailService.defaultRail()).toLowerCase();

  const redirectUrl = paymentLinkService.buildHostedSuccessUrl(linkId);

  const apiRef = paymentRailService.sanitizeIntaSendApiRef(
      link.bookingReference || linkId.replace(/^pl_/, "").slice(0, 24),
      linkId,
  );
  const guestName = link.guestName ? String(link.guestName).trim() : "";
  const nameParts = guestName.split(/\s+/).filter(Boolean);
  const firstName = payer.firstName || nameParts[0] || "Guest";
  const lastName = payer.lastName || (nameParts.length > 1 ? nameParts.slice(1).join(" ") : "Customer");

  const commentParts = [];
  if (link.bookingReference) {
    commentParts.push(String(link.bookingReference));
  }
  if (link.description) {
    commentParts.push(String(link.description));
  }

  const session = await paymentRailService.createSession({
    rail: selectedRail,
    amount: link.amount,
    currency: link.currency,
    apiRef,
    redirectUrl,
    email: payer.email || null,
    phoneNumber: payer.phoneNumber || null,
    firstName,
    lastName,
    country: payer.country || null,
    comment: commentParts.length ? commentParts.join(" — ") : null,
  });

  if (selectedRail === paymentRailService.SUPPORTED_RAILS.manual) {
    return {
      linkId,
      partnerId,
      rail: session.rail,
      checkoutUrl: null,
      message: session.message,
    };
  }

  const orderRef = firestore.collection(config.collections.orders).doc();
  const orderId = orderRef.id;
  const checkoutId = session.checkoutId;
  const invoiceId = session.invoiceId || checkoutId;

  const orderData = {
    partnerId,
    linkId,
    orderType: B2B_PURPOSE,
    status: "pending",
    amount: link.amount,
    currency: link.currency,
    invoiceId,
    checkoutId,
    checkoutUrl: session.checkoutUrl,
    rail: session.rail,
    bookingReference: link.bookingReference || null,
    metadata: {
      purpose: B2B_PURPOSE,
      partnerId,
      linkId,
      orderId,
      invoiceId,
      checkoutId,
      checkoutUrl: session.checkoutUrl,
      rail: session.rail,
      bookingReference: link.bookingReference || null,
      guestName: link.guestName || null,
      apiRef,
      createdAt: new Date().toISOString(),
    },
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  await orderRef.set(orderData);

  /** @type {Record<string, unknown>} */
  const mappingData = {
    purpose: B2B_PURPOSE,
    partnerId,
    linkId,
    orderId,
    amount: link.amount,
    currency: link.currency,
    checkoutId,
    invoiceId,
    checkoutUrl: session.checkoutUrl,
    rail: session.rail,
    status: "pending",
    bookingReference: link.bookingReference || null,
    createdAt: serverTimestamp(),
  };

  const mappingsCol = firestore.collection(config.collections.invoiceMappings);
  await mappingsCol.doc(checkoutId).set(mappingData);
  if (invoiceId !== checkoutId) {
    await mappingsCol.doc(invoiceId).set({ ...mappingData, aliasOf: checkoutId });
  }

  await collection("paymentLinks").doc(linkId).update({
    lastCheckoutAt: serverTimestamp(),
    lastCheckoutRail: session.rail,
    lastCheckoutId: checkoutId,
    updatedAt: serverTimestamp(),
  });

  return {
    linkId,
    partnerId,
    orderId,
    rail: session.rail,
    checkoutUrl: session.checkoutUrl,
    checkoutId,
    invoiceId,
    redirectUrl,
  };
}

/**
 * @param {string} linkId
 * @param {string|null} [partnerId] - when omitted, resolves from stored link (public status by linkId)
 * @returns {Promise<Object|null>}
 */
async function getPublicLinkStatus(linkId, partnerId = null) {
  const doc = await collection("paymentLinks").doc(linkId).get();
  if (!doc.exists) {
    return null;
  }
  const d = doc.data() || {};
  if (partnerId && d.partnerId !== partnerId) {
    return null;
  }
  const status = paymentLinkService.effectiveStatus(d);
  return {
    linkId: doc.id,
    partnerId: d.partnerId,
    partnerName: d.partnerName ?? null,
    status,
    amount: Number(d.amount),
    currency: d.currency,
    bookingReference: d.bookingReference ?? null,
    guestName: d.guestName ?? null,
    paidAt: d.paidAt?.toDate?.()?.toISOString?.() ?? null,
    transactionId: d.transactionId ?? null,
    invoiceId: d.invoiceId ?? null,
  };
}

module.exports = {
  B2B_PURPOSE,
  startCheckout,
  getPublicLinkStatus,
  loadActiveLink,
};
