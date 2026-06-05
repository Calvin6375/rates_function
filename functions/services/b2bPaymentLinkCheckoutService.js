/**
 * @fileoverview Start B2B hosted payment-link checkout sessions and track payer status.
 * Links are org-wide and reusable; each payer supplies their name at checkout.
 */

const admin = require("../admin");
const config = require("../config");
const { collection, serverTimestamp } = require("../libs/firestore");
const paymentLinkService = require("./paymentLinkService");
const paymentRailService = require("./paymentRailService");

const firestore = admin.firestore();
const B2B_PURPOSE = "b2b_payment_link";

/**
 * @param {Object} payer
 * @param {string} [payer.payerName]
 * @param {string} [payer.firstName]
 * @param {string} [payer.lastName]
 * @returns {{ payerName: string, firstName: string, lastName: string }}
 */
function parsePayerIdentity(payer = {}) {
  let fullName = "";
  if (payer.payerName && String(payer.payerName).trim()) {
    fullName = String(payer.payerName).trim();
  } else if (payer.firstName || payer.lastName) {
    fullName = [payer.firstName, payer.lastName]
        .filter(Boolean)
        .map((part) => String(part).trim())
        .join(" ")
        .trim();
  }
  if (!fullName || fullName.length < 2) {
    throw new Error("Payer name is required (minimum 2 characters)");
  }
  const nameParts = fullName.split(/\s+/).filter(Boolean);
  return {
    payerName: fullName,
    firstName: payer.firstName ? String(payer.firstName).trim() : nameParts[0],
    lastName: payer.lastName ?
      String(payer.lastName).trim() :
      (nameParts.length > 1 ? nameParts.slice(1).join(" ") : "Customer"),
  };
}

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
  if (link.status === "cancelled") {
    throw new Error("Payment link is cancelled");
  }
  if (link.status !== "active" && link.status !== "paid") {
    throw new Error(`Payment link is ${link.status}`);
  }
  return link;
}

/**
 * @param {string} checkoutId
 * @returns {Promise<(Object & { mappingDocId: string })|null>}
 */
async function lookupCheckoutMapping(checkoutId) {
  if (!checkoutId) {
    return null;
  }
  const mappingsCol = firestore.collection(config.collections.invoiceMappings);
  const direct = await mappingsCol.doc(checkoutId).get();
  if (direct.exists) {
    const data = direct.data() || {};
    if (data.purpose === B2B_PURPOSE) {
      if (data.aliasOf) {
        const primary = await mappingsCol.doc(data.aliasOf).get();
        if (primary.exists) {
          return { mappingDocId: primary.id, ...primary.data() };
        }
      }
      return { mappingDocId: direct.id, ...data };
    }
  }
  const byCheckout = await mappingsCol
      .where("purpose", "==", B2B_PURPOSE)
      .where("checkoutId", "==", checkoutId)
      .limit(1)
      .get();
  if (!byCheckout.empty) {
    const doc = byCheckout.docs[0];
    return { mappingDocId: doc.id, ...doc.data() };
  }
  return null;
}

/**
 * @param {string} linkId
 * @param {string} partnerId
 * @param {Object} [payer]
 * @param {string} [payer.payerName]
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
  const identity = parsePayerIdentity(payer);

  const redirectUrl = paymentLinkService.buildHostedSuccessUrl(linkId);

  const apiRef = paymentRailService.sanitizeIntaSendApiRef(
      link.bookingReference || linkId.replace(/^pl_/, "").slice(0, 24),
      linkId,
  );

  const commentParts = [];
  if (link.bookingReference) {
    commentParts.push(String(link.bookingReference));
  }
  if (identity.payerName) {
    commentParts.push(identity.payerName);
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
    firstName: identity.firstName,
    lastName: identity.lastName,
    country: payer.country || null,
    comment: commentParts.length ? commentParts.join(" — ") : null,
  });

  if (selectedRail === paymentRailService.SUPPORTED_RAILS.manual) {
    return {
      linkId,
      partnerId,
      rail: session.rail,
      checkoutUrl: null,
      payerName: identity.payerName,
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
    payerName: identity.payerName,
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
      payerName: identity.payerName,
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
    payerName: identity.payerName,
    apiRef,
    createdAt: serverTimestamp(),
  };

  const mappingsCol = firestore.collection(config.collections.invoiceMappings);
  await mappingsCol.doc(checkoutId).set(mappingData);
  const aliasIds = paymentRailService.collectCheckoutIdentifierIds(
      session.raw || {},
      session.checkoutUrl,
  );
  for (const aliasId of aliasIds) {
    if (!aliasId || aliasId === checkoutId) {
      continue;
    }
    await mappingsCol.doc(String(aliasId)).set({
      ...mappingData,
      aliasOf: checkoutId,
    });
  }

  await collection("paymentLinks").doc(linkId).update({
    lastCheckoutAt: serverTimestamp(),
    lastCheckoutRail: session.rail,
    lastCheckoutId: checkoutId,
    updatedAt: serverTimestamp(),
    ...(link.status === "paid" ? { status: "active" } : {}),
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
    payerName: identity.payerName,
  };
}

/**
 * @param {string} linkId
 * @param {string|null} [partnerId] - when omitted, resolves from stored link (public status by linkId)
 * @param {string|null} [checkoutId] - when set, returns status for a specific checkout session
 * @returns {Promise<Object|null>}
 */
async function getPublicLinkStatus(linkId, partnerId = null, checkoutId = null) {
  const doc = await collection("paymentLinks").doc(linkId).get();
  if (!doc.exists) {
    return null;
  }
  const d = doc.data() || {};
  if (partnerId && d.partnerId !== partnerId) {
    return null;
  }

  if (checkoutId) {
    try {
      const reconcile = require("./b2bCheckoutReconcileService");
      await reconcile.tryReconcileCheckoutSession(checkoutId);
    } catch (err) {
      console.warn("getPublicLinkStatus reconcile:", err.message);
    }
    const mapping = await lookupCheckoutMapping(checkoutId);
    if (!mapping || mapping.linkId !== linkId) {
      return null;
    }
    const sessionPaid = mapping.status === "completed";
    return {
      linkId: doc.id,
      partnerId: d.partnerId,
      partnerName: d.partnerName ?? null,
      checkoutId,
      status: sessionPaid ? "paid" : "pending",
      amount: Number(mapping.amount ?? d.amount),
      currency: mapping.currency ?? d.currency,
      bookingReference: mapping.bookingReference ?? d.bookingReference ?? null,
      payerName: mapping.payerName ?? null,
      paidAt: mapping.completedAt?.toDate?.()?.toISOString?.() ?? null,
      transactionId: mapping.transactionId ?? null,
      invoiceId: mapping.invoiceId ?? mapping.checkoutId ?? checkoutId,
    };
  }

  const status = paymentLinkService.effectiveStatus(d);
  const normalizedStatus = status === "paid" ? "active" : status;
  return {
    linkId: doc.id,
    partnerId: d.partnerId,
    partnerName: d.partnerName ?? null,
    status: normalizedStatus,
    amount: Number(d.amount),
    currency: d.currency,
    bookingReference: d.bookingReference ?? null,
    paymentCount: Number(d.paymentCount || 0),
    lastPaidAt: d.lastPaidAt?.toDate?.()?.toISOString?.() ?? null,
    lastPayerName: d.lastPayerName ?? null,
    expiresAt: d.expiresAt?.toDate?.()?.toISOString() ?? null,
  };
}

module.exports = {
  B2B_PURPOSE,
  parsePayerIdentity,
  startCheckout,
  getPublicLinkStatus,
  loadActiveLink,
  lookupCheckoutMapping,
};
