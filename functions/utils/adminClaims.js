/**
 * @fileoverview Admin custom claims — delegates to accessControl (TruePay IAM).
 */

const {
  SUPER_ADMIN_EMAIL,
  ADMIN_ROLE_SUPER,
  setAdminAccessClaims,
  clearAdminAccessClaims,
  isSuperAdminEmailUid,
  isSuperAdmin,
  isPlatformAdmin,
  verifyAdminFromAuth,
  getCustomClaims,
} = require("./accessControl");

/**
 * Grant platform super-admin (legacy name preserved for callables).
 *
 * @param {string} userId
 * @returns {Promise<void>}
 */
async function setAdminClaim(userId) {
  await setAdminAccessClaims(userId, ADMIN_ROLE_SUPER, null);
}

/**
 * @param {string} userId
 * @returns {Promise<void>}
 */
async function removeAdminClaim(userId) {
  await clearAdminAccessClaims(userId);
}

/**
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
async function hasAdminClaim(userId) {
  try {
    const claims = await getCustomClaims(userId);
    return claims.userType === "admin" || claims.admin === true;
  } catch (error) {
    console.error(`Error checking admin claim for ${userId}:`, error.message);
    return false;
  }
}

function verifyAdminFromToken(auth) {
  return verifyAdminFromAuth(auth);
}

async function isSuperAdminUid(uid) {
  return isSuperAdminEmailUid(uid);
}

module.exports = {
  SUPER_ADMIN_EMAIL,
  setAdminClaim,
  removeAdminClaim,
  hasAdminClaim,
  verifyAdminFromToken,
  isSuperAdminUid,
  isSuperAdmin,
  isPlatformAdmin,
  setAdminAccessClaims,
  clearAdminAccessClaims,
  ADMIN_ROLE_SUPER,
};
