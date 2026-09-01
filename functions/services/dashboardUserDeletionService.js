/**
 * @fileoverview Dashboard user deletion (platform or partner org admin).
 */

const admin = require("../admin");
const {isSuperAdminUid} = require("../utils/adminClaims");
const {purgeUserAccount} = require("../libs/userAuthDataCleanup");
const {logAdminAction} = require("../utils/transactions");
const b2bMemberService = require("./b2bMemberService");

/**
 * Platform admin (custom claim admin or super-admin email): delete any user,
 * with guards on platform owner and other admin accounts.
 *
 * @param {string} actorUid
 * @param {string} targetUserId
 * @param {{ actorIsSuperAdmin: boolean }} opts
 * @return {Promise<Object>}
 */
async function deleteUserAsPlatformAdmin(actorUid, targetUserId, opts) {
  const actorIsSuperAdmin = opts.actorIsSuperAdmin === true;

  if (!targetUserId || typeof targetUserId !== "string") {
    throw new Error("userId is required");
  }
  if (actorUid === targetUserId) {
    throw new Error("Cannot delete your own account");
  }

  const targetIsSuperAdmin = await isSuperAdminUid(targetUserId);
  if (targetIsSuperAdmin && !actorIsSuperAdmin) {
    throw new Error("Only the platform owner can delete this account");
  }

  let targetRecord = null;
  try {
    targetRecord = await admin.auth().getUser(targetUserId);
  } catch (e) {
    if (e.code !== "auth/user-not-found" && e.code !== "auth/invalid-uid") {
      throw e;
    }
  }

  const claims = targetRecord && targetRecord.customClaims;
  const targetIsAdmin = claims && claims.admin === true;
  if (targetIsAdmin && !actorIsSuperAdmin) {
    throw new Error(
        "Only the platform owner can delete an administrator account",
    );
  }

  const purged = await purgeUserAccount(targetUserId, {
    protectedUids: [actorUid],
  });

  await logAdminAction(
      actorUid,
      targetUserId,
      "deleteUser.platform",
      {hadAuth: !!targetRecord},
      {
        authDeleted: purged.authDeletedUids.length > 0,
        authDeletedUids: purged.authDeletedUids,
        emails: purged.emails,
      },
  );

  return {
    userId: targetUserId,
    authDeleted: purged.authDeletedUids.length > 0,
    authDeletedUids: purged.authDeletedUids,
  };
}

/**
 * Partner org admin: remove member if present, delete Auth + user data.
 * C2B / Safari Tap users are not partner members — still hard-delete them.
 *
 * @param {string} actorUid
 * @param {string} partnerId
 * @param {string} targetUserId
 * @return {Promise<Object>}
 */
async function deleteUserAsPartnerOrgAdmin(actorUid, partnerId, targetUserId) {
  if (!targetUserId || typeof targetUserId !== "string") {
    throw new Error("userId is required");
  }
  if (actorUid === targetUserId) {
    throw new Error("Cannot delete your own account");
  }

  const targetIsSuperAdmin = await isSuperAdminUid(targetUserId);
  if (targetIsSuperAdmin) {
    throw new Error("Cannot delete the platform owner account");
  }

  try {
    await b2bMemberService.removeMember(partnerId, targetUserId);
  } catch (err) {
    const msg = String(err.message || "");
    if (!msg.includes("Member not found")) {
      throw err;
    }
  }

  const purged = await purgeUserAccount(targetUserId, {
    protectedUids: [actorUid],
  });

  await logAdminAction(
      actorUid,
      targetUserId,
      "deleteUser.partnerOrgAdmin",
      {partnerId},
      {
        authDeleted: purged.authDeletedUids.length > 0,
        authDeletedUids: purged.authDeletedUids,
        emails: purged.emails,
      },
  );

  return {
    userId: targetUserId,
    authDeleted: purged.authDeletedUids.length > 0,
    authDeletedUids: purged.authDeletedUids,
  };
}

module.exports = {
  deleteUserAsPlatformAdmin,
  deleteUserAsPartnerOrgAdmin,
};
