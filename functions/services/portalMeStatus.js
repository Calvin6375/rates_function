/**
 * @fileoverview Merchant + member status for GET /portal/me (header pill).
 * Frontend labels Active / Not active / Suspended from these fields — never omit them
 * on a partner or mid-onboarding session.
 */

const {collection} = require("../libs/firestore");

const STATUS_ACTIVE = "active";
const STATUS_INACTIVE = "inactive";
const STATUS_SUSPENDED = "suspended";

/**
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeMerchantStatus(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (s === STATUS_ACTIVE) {
    return STATUS_ACTIVE;
  }
  if (s === STATUS_SUSPENDED || s === "disabled" || s === "blocked") {
    return STATUS_SUSPENDED;
  }
  return STATUS_INACTIVE;
}

/**
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeMemberStatus(raw) {
  if (raw == null || String(raw).trim() === "") {
    return null;
  }
  return normalizeMerchantStatus(raw);
}

/**
 * Partner object the header can always read (`partner.status` is never missing).
 *
 * @param {Object|null|undefined} partner
 * @param {string|null|undefined} partnerId
 * @returns {{ id: string|null, status: string, statusRaw: string|null, [key: string]: unknown }}
 */
function shapePartnerForPortalMe(partner, partnerId) {
  const id =
    (partner && partner.id) ||
    (partnerId ? String(partnerId) : null) ||
    null;
  const statusRaw =
    partner && partner.status != null && String(partner.status).trim() !== "" ?
      String(partner.status) :
      null;
  const status = normalizeMerchantStatus(statusRaw);
  return {
    ...(partner && typeof partner === "object" ? partner : {}),
    id,
    status,
    statusRaw,
  };
}

/**
 * @param {Object} partnerPayload
 * @returns {{ merchantStatus: string, merchantActive: boolean }}
 */
function merchantFlags(partnerPayload) {
  const merchantStatus = normalizeMerchantStatus(partnerPayload && partnerPayload.status);
  return {
    merchantStatus,
    merchantActive: merchantStatus === STATUS_ACTIVE,
  };
}

/**
 * Signed-in dashboard user status (`users/{uid}.status`).
 *
 * @param {string} uid
 * @returns {Promise<string|null>}
 */
async function readMemberStatus(uid) {
  if (!uid) {
    return null;
  }
  try {
    const snap = await collection("users").doc(uid).get();
    if (!snap.exists) {
      return null;
    }
    return normalizeMemberStatus(snap.data()?.status);
  } catch (err) {
    console.error("portalMeStatus.readMemberStatus:", err.message);
    return null;
  }
}

/**
 * Fields every partner / onboarding `/portal/me` body should include.
 *
 * @param {Object|null|undefined} partner
 * @param {string|null|undefined} partnerId
 * @param {string|null|undefined} memberStatus
 * @returns {Object}
 */
function portalMeStatusFields(partner, partnerId, memberStatus) {
  const shaped = shapePartnerForPortalMe(partner, partnerId);
  return {
    status: memberStatus || null,
    partner: shaped,
    ...merchantFlags(shaped),
  };
}

module.exports = {
  STATUS_ACTIVE,
  STATUS_INACTIVE,
  STATUS_SUSPENDED,
  normalizeMerchantStatus,
  normalizeMemberStatus,
  shapePartnerForPortalMe,
  merchantFlags,
  readMemberStatus,
  portalMeStatusFields,
};
