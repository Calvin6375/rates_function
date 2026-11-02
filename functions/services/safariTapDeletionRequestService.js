/**
 * @fileoverview Safari Tap user asks to delete their account.
 * Stores the request and notifies the super admin. Does not delete.
 */

const admin = require("../admin");
const config = require("../config");
const {
  notifySafariTapDeletionRequestAdmins,
} = require("../utils/notifications");

const PARTNER_DASHBOARD = "PartnerDashboard";

/**
 * @param {Object} profile
 * @param {Object|null} authRecord
 * @return {boolean}
 */
function isSafariTapConsumer(profile, authRecord) {
  const claims = authRecord && authRecord.customClaims ?
    authRecord.customClaims :
    {};
  if (claims.admin === true || claims.userType === "admin") return false;
  if (typeof claims.partnerId === "string" && claims.partnerId.trim()) {
    return false;
  }
  const channel = String(profile.channel || "").trim().toUpperCase();
  const institution = String(profile.institution || "").trim();
  if (channel === "B2B" || institution === PARTNER_DASHBOARD) return false;
  return true;
}

/**
 * Signed-in Safari Tap user requests account deletion.
 *
 * @param {string} uid
 * @return {Promise<Object>}
 */
async function requestAccountDeletion(uid) {
  if (!uid || typeof uid !== "string") {
    const err = new Error("Authentication required");
    err.statusCode = 401;
    throw err;
  }

  const userRef = admin.firestore()
      .collection(config.collections.users)
      .doc(uid);
  const snap = await userRef.get();
  const profile = snap.exists ? snap.data() || {} : {};

  let authRecord = null;
  try {
    authRecord = await admin.auth().getUser(uid);
  } catch (e) {
    if (e.code !== "auth/user-not-found" && e.code !== "auth/invalid-uid") {
      throw e;
    }
  }

  if (!snap.exists && !authRecord) {
    const err = new Error("Account not found");
    err.statusCode = 404;
    err.code = "NOT_FOUND";
    throw err;
  }

  if (!isSafariTapConsumer(profile, authRecord)) {
    const err = new Error("Only a Safari Tap account can request deletion");
    err.statusCode = 403;
    err.code = "FORBIDDEN";
    throw err;
  }

  if (profile.deletionRequested === true) {
    return {
      deletionRequested: true,
      alreadyRequested: true,
      notificationId: null,
      message: "Deletion request already sent. A platform admin will review.",
    };
  }

  await userRef.set(
      {
        deletionRequested: true,
        deletionRequestedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      {merge: true},
  );

  const authName = authRecord && authRecord.displayName;
  const authEmail = authRecord && authRecord.email;
  const authPhone = authRecord && authRecord.phoneNumber;
  const first = profile.firstName ? String(profile.firstName).trim() : "";
  const last = profile.lastName ? String(profile.lastName).trim() : "";
  const fullName = [first, last].filter(Boolean).join(" ");
  const notified = await notifySafariTapDeletionRequestAdmins({
    userId: uid,
    userName: profile.name || fullName || authName || "",
    email: profile.email || authEmail || null,
    phoneNumber: profile.phoneNumber || authPhone || null,
  });

  return {
    deletionRequested: true,
    alreadyRequested: false,
    notificationId: notified.notificationId,
    message: "Deletion request sent. A platform admin will review.",
  };
}

module.exports = {
  requestAccountDeletion,
  isSafariTapConsumer,
};
