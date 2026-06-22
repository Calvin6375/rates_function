/**
 * @fileoverview Platform admin deletion of B2B partner organizations.
 */

const admin = require("../admin");
const { collection, serverTimestamp } = require("../libs/firestore");
const { clearPartnerClaims } = require("../utils/customClaimsMerge");
const partnerService = require("./partnerService");
const paymentLinkService = require("./paymentLinkService");

const MEMBERS_SUB = "members";
const ONBOARDING_COL = "onboarding";

/**
 * Remove partner access fields from users/{uid} after org deletion.
 *
 * @param {string} uid
 * @return {Promise<void>}
 */
async function clearUserDocPartnerFields(uid) {
  const ref = collection("users").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    return;
  }
  await ref.update({
    partnerId: admin.firestore.FieldValue.delete(),
    partnerRole: admin.firestore.FieldValue.delete(),
    userType: admin.firestore.FieldValue.delete(),
    role: admin.firestore.FieldValue.delete(),
    updatedAt: serverTimestamp(),
  });
}

/**
 * Delete all payment links owned by a partner.
 *
 * @param {string} partnerId
 * @return {Promise<number>}
 */
async function deletePartnerPaymentLinks(partnerId) {
  let deleted = 0;
  let cursor = null;
  do {
    const page = await paymentLinkService.listPaymentLinksForPartner(
        partnerId,
        100,
        cursor,
    );
    for (const link of page.paymentLinks) {
      await paymentLinkService.deletePaymentLink(link.linkId, {partnerId});
      deleted += 1;
    }
    cursor = page.nextPageCursor;
  } while (cursor);
  return deleted;
}

/**
 * Platform admin: delete a partner org, clear member claims, and remove payment links.
 * Transactions and settlements for the partner are retained for audit.
 *
 * @param {string} partnerId
 * @return {Promise<Object>}
 */
async function deletePartnerAsPlatformAdmin(partnerId) {
  if (!partnerId || typeof partnerId !== "string") {
    throw new Error("partnerId is required");
  }

  const partner = await partnerService.getPartner(partnerId);
  if (!partner) {
    throw new Error("Partner not found");
  }

  const membersSnap = await collection("partners")
      .doc(partnerId)
      .collection(MEMBERS_SUB)
      .get();
  /** @type {Set<string>} */
  const memberUids = new Set(membersSnap.docs.map((doc) => doc.id));
  if (partner.orgAdminUid && typeof partner.orgAdminUid === "string") {
    memberUids.add(partner.orgAdminUid);
  }

  for (const uid of memberUids) {
    try {
      await clearPartnerClaims(uid);
    } catch (clearErr) {
      console.warn(
          "deletePartnerAsPlatformAdmin clearPartnerClaims:",
          uid,
          clearErr.message,
      );
    }
    try {
      await clearUserDocPartnerFields(uid);
    } catch (userErr) {
      console.warn(
          "deletePartnerAsPlatformAdmin clearUserDocPartnerFields:",
          uid,
          userErr.message,
      );
    }
  }

  if (partner.orgAdminUid && typeof partner.orgAdminUid === "string") {
    await collection(ONBOARDING_COL).doc(partner.orgAdminUid).set(
        {
          registeredPartnerId: admin.firestore.FieldValue.delete(),
          updatedAt: serverTimestamp(),
        },
        {merge: true},
    );
  }

  const paymentLinksDeleted = await deletePartnerPaymentLinks(partnerId);

  const partnerRef = collection("partners").doc(partnerId);
  await admin.firestore().recursiveDelete(partnerRef);

  return {
    partnerId,
    partnerName: partner.name || null,
    membersCleared: memberUids.size,
    paymentLinksDeleted,
  };
}

module.exports = {
  deletePartnerAsPlatformAdmin,
};
