/**
 * @fileoverview Merge Firebase Auth custom claims without dropping existing keys.
 */

const admin = require("../admin");

/**
 * Read current custom claims for a user
 * @param {string} uid
 * @returns {Promise<Record<string, unknown>>}
 */
async function getCustomClaims(uid) {
  const user = await admin.auth().getUser(uid);
  return { ...(user.customClaims || {}) };
}

/**
 * Merge patches into existing custom claims. Use null as patch value to delete a key.
 * @param {string} uid
 * @param {Record<string, unknown|null>} patch
 * @returns {Promise<Record<string, unknown>>} The new claims object applied
 */
async function mergeCustomUserClaims(uid, patch) {
  const current = await getCustomClaims(uid);
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[key];
    } else if (value !== undefined) {
      next[key] = value;
    }
  }
  await admin.auth().setCustomUserClaims(uid, next);
  return next;
}

/**
 * Remove B2B partner claims only; preserves other claims (e.g. admin).
 * @param {string} uid
 * @returns {Promise<void>}
 */
async function clearPartnerClaims(uid) {
  await mergeCustomUserClaims(uid, {
    partnerId: null,
    partnerRole: null,
  });
}

module.exports = {
  getCustomClaims,
  mergeCustomUserClaims,
  clearPartnerClaims,
};
