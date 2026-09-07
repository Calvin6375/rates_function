/**
 * @fileoverview Resolve Paystack checkout email from Firestore profile, Auth token, then client.
 */

const admin = require("../admin");
const config = require("../config");
const {pickPaystackCustomerEmail} = require("./paystackEmail");

/**
 * @param {string} userId
 * @returns {Promise<string|null>}
 */
async function getUserProfileEmail(userId) {
  if (!userId) return null;
  try {
    const snap = await admin.firestore()
        .collection(config.collections.users)
        .doc(String(userId))
        .get();
    if (!snap.exists) return null;
    const email = snap.data()?.email;
    return email ? String(email) : null;
  } catch (err) {
    console.warn("getUserProfileEmail:", err.message);
    return null;
  }
}

/**
 * @param {string} userId
 * @param {{ clientEmail?: unknown, tokenEmail?: unknown, profileEmail?: unknown }} [extras]
 * @returns {Promise<{ email: string, usedFallback: boolean, corrected: boolean, source: string }>}
 */
async function resolveFundingCustomerEmail(userId, extras = {}) {
  const profileEmail = extras.profileEmail !== undefined ?
    extras.profileEmail :
    await getUserProfileEmail(userId);
  return pickPaystackCustomerEmail([
    profileEmail,
    extras.tokenEmail,
    extras.clientEmail,
  ]);
}

module.exports = {
  getUserProfileEmail,
  resolveFundingCustomerEmail,
};
