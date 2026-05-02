/**
 * @fileoverview Admin Custom Claims management utility
 * Handles setting/unsetting admin claims for Firebase Authentication
 * 
 * SECURITY: Admin claims are stored in Firebase Auth tokens, not Firestore
 * This provides better security than checking Firestore role fields
 */

const admin = require("../admin");

/** Only this account may change platform supported countries via `setSupportedCountries`. */
const SUPER_ADMIN_EMAIL = "calvinrumba8@gmail.com";

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

/**
 * True if Firebase Auth user for uid has the super-admin email (platform owner).
 * @param {string} uid
 * @returns {Promise<boolean>}
 */
async function isSuperAdminUid(uid) {
  if (!uid || typeof uid !== "string") {
    return false;
  }
  try {
    const userRecord = await admin.auth().getUser(uid);
    const email = (userRecord.email || "").trim().toLowerCase();
    return email === SUPER_ADMIN_EMAIL.toLowerCase();
  } catch (error) {
    console.error(`Error checking super admin for ${uid}:`, error.message);
    return false;
  }
}

module.exports = {
  setAdminClaim,
  removeAdminClaim,
  hasAdminClaim,
  verifyAdminFromToken,
  isSuperAdminUid,
};

