/**
 * @fileoverview Auth helpers: Firebase ID token verification and partner API key verification.
 */

const admin = require("../admin");
const { collection } = require("./firestore");

/**
 * Verify Firebase ID token from Authorization: Bearer <token>
 * @param {string} token - JWT ID token
 * @returns {Promise<{ uid: string, [key: string]: any }>} Decoded token
 */
async function verifyIdToken(token) {
  if (!token || !token.trim()) {
    throw new Error("Missing or empty token");
  }
  return admin.auth().verifyIdToken(token.trim());
}

/**
 * Verify request has valid Firebase Auth and return uid
 * @param {Object} req - Express request (req.headers.authorization)
 * @returns {Promise<{ success: boolean, userId?: string, error?: string, decodedToken?: Object }>}
 */
async function verifyFirebaseAuth(req) {
  try {
    const authHeader = req.headers?.authorization;
    const bearerMatch = typeof authHeader === "string" ?
      authHeader.match(/^Bearer\s+(.+)$/i) :
      null;
    if (!bearerMatch) {
      return { success: false, error: "Missing or invalid Authorization header" };
    }
    const token = bearerMatch[1];
    const decodedToken = await verifyIdToken(token);
    return {
      success: true,
      userId: decodedToken.uid,
      decodedToken,
    };
  } catch (err) {
    return {
      success: false,
      error: err.message || "Invalid or expired token",
    };
  }
}

/**
 * Verify partner API key from X-API-KEY header and return partner doc
 * @param {string} apiKey - Raw API key from header
 * @returns {Promise<{ success: boolean, partner?: Object, partnerId?: string, error?: string }>}
 */
async function verifyPartnerApiKey(apiKey) {
  if (!apiKey || !apiKey.trim()) {
    return { success: false, error: "Missing X-API-KEY" };
  }
  const trimmed = apiKey.trim();
  try {
    const partnersRef = collection("partners");
    const snapshot = await partnersRef.where("apiKey", "==", trimmed).limit(1).get();
    if (snapshot.empty) {
      return { success: false, error: "Invalid API key" };
    }
    const doc = snapshot.docs[0];
    const data = doc.data();
    const st = data.status;
    if (
      st === "suspended" ||
      st === "inactive" ||
      st === "pending_review" ||
      st === "pending_kyc"
    ) {
      return {
        success: false,
        error:
          st === "pending_review" || st === "pending_kyc"
            ? "Partner account is pending activation"
            : "Partner account is not active",
      };
    }
    return {
      success: true,
      partnerId: doc.id,
      partner: { id: doc.id, ...data },
    };
  } catch (err) {
    return { success: false, error: err.message || "API key verification failed" };
  }
}

/**
 * Verify request has valid X-API-KEY and return partner
 * @param {Object} req - Express request (req.headers['x-api-key'])
 * @returns {Promise<{ success: boolean, partnerId?: string, partner?: Object, error?: string }>}
 */
async function verifyPartnerRequest(req) {
  const apiKey = req.headers?.["x-api-key"] || req.headers?.["X-API-KEY"];
  return verifyPartnerApiKey(apiKey);
}

module.exports = {
  verifyIdToken,
  verifyFirebaseAuth,
  verifyPartnerApiKey,
  verifyPartnerRequest,
};
