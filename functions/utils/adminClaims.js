/**
 * @fileoverview Admin Custom Claims management utility
 * Handles setting/unsetting admin claims for Firebase Authentication
 * 
 * SECURITY: Admin claims are stored in Firebase Auth tokens, not Firestore
 * This provides better security than checking Firestore role fields
 */

const admin = require("../admin");

/**
 * Set admin claim for a user
 * @param {string} userId - User ID
 * @returns {Promise<void>}
 */
async function setAdminClaim(userId) {
  try {
    await admin.auth().setCustomUserClaims(userId, {admin: true});
    console.log(`✅ Set admin claim for user: ${userId}`);
  } catch (error) {
    console.error(`❌ Error setting admin claim for ${userId}:`, error.message);
    throw error;
  }
}

/**
 * Remove admin claim from a user
 * @param {string} userId - User ID
 * @returns {Promise<void>}
 */
async function removeAdminClaim(userId) {
  try {
    await admin.auth().setCustomUserClaims(userId, {admin: false});
    console.log(`✅ Removed admin claim for user: ${userId}`);
  } catch (error) {
    console.error(`❌ Error removing admin claim for ${userId}:`, error.message);
    throw error;
  }
}

/**
 * Check if user has admin claim
 * @param {string} userId - User ID
 * @returns {Promise<boolean>} True if user has admin claim
 */
async function hasAdminClaim(userId) {
  try {
    const userRecord = await admin.auth().getUser(userId);
    return userRecord.customClaims?.admin === true;
  } catch (error) {
    console.error(`❌ Error checking admin claim for ${userId}:`, error.message);
    return false;
  }
}

/**
 * Verify admin from auth token (for use in functions)
 * @param {Object} auth - Firebase Auth object from request context
 * @returns {boolean} True if user has admin claim
 */
function verifyAdminFromToken(auth) {
  if (!auth || !auth.token) {
    return false;
  }
  return auth.token.admin === true;
}

module.exports = {
  setAdminClaim,
  removeAdminClaim,
  hasAdminClaim,
  verifyAdminFromToken,
};

