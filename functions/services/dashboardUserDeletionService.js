/**
 * @fileoverview Dashboard user deletion (platform or partner org admin).
 */

const admin = require("../admin");
const {clearPartnerClaims} = require("../utils/customClaimsMerge");
const {isSuperAdminUid} = require("../utils/adminClaims");
const {deleteUserDataAcrossStores} = require("../libs/userAuthDataCleanup");
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
    if (e.code !== "auth/user-not-found") {
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

  let authDeleted = false;
  if (targetRecord) {
    try {
      await clearPartnerClaims(targetUserId);
    } catch (clearErr) {
      console.warn(
          "deleteUserAsPlatformAdmin clearPartnerClaims:",
          clearErr.message,
      );
    }
    await admin.auth().deleteUser(targetUserId);
    authDeleted = true;
  }

  await deleteUserDataAcrossStores(targetUserId, {
    requireUsersDocRemoved: true,
  });

  await logAdminAction(
      actorUid,
      targetUserId,
      "deleteUser.platform",
      {hadAuth: !!targetRecord},
      {authDeleted},
  );

  return {userId: targetUserId, authDeleted};
}

/**
 * Partner org admin: remove member, delete Auth + user data.
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

  await b2bMemberService.removeMember(partnerId, targetUserId);

  let authDeleted = false;
  try {
    await admin.auth().deleteUser(targetUserId);
    authDeleted = true;
  } catch (e) {
    if (e.code !== "auth/user-not-found") {
      throw e;
    }
  }

  await deleteUserDataAcrossStores(targetUserId, {
    requireUsersDocRemoved: true,
  });

  await logAdminAction(
      actorUid,
      targetUserId,
      "deleteUser.partnerOrgAdmin",
      {partnerId},
      {authDeleted},
  );

  return {userId: targetUserId, authDeleted};
}

module.exports = {
  deleteUserAsPlatformAdmin,
  deleteUserAsPartnerOrgAdmin,
};
