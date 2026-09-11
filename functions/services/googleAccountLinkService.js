/**
 * @fileoverview Link a Google account to an existing Firebase user (same email)
 * so B2B login-with-Google lands on the email/password signup uid.
 *
 * Public entry: completeGoogleLogin(googleIdToken) → custom token.
 */

const axios = require("axios");
const admin = require("../admin");
const config = require("../config");

const TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";
const TOKENINFO_V3_URL = "https://www.googleapis.com/oauth2/v3/tokeninfo";
const GOOGLE_ISSUERS = new Set([
  "accounts.google.com",
  "https://accounts.google.com",
]);

/**
 * @param {string} message
 * @param {string} code
 * @param {number} statusCode
 * @returns {Error}
 */
function httpError(message, code, statusCode) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

/**
 * @param {unknown} email
 * @returns {string}
 */
function normalizeEmail(email) {
  if (!email || typeof email !== "string") {
    return "";
  }
  return email.trim().toLowerCase();
}

/**
 * @returns {string[]}
 */
function allowedAudiences() {
  const raw =
    process.env.GOOGLE_OAUTH_CLIENT_IDS ||
    process.env.GOOGLE_OAUTH_CLIENT_ID ||
    config.googleOauthClientIds;
  if (!raw || typeof raw !== "string") {
    return [];
  }
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isTruthyFlag(value) {
  return value === true || value === "true";
}

/**
 * GIS / FedCM sometimes send a JWT, sometimes a JSON object/string with `id_token`.
 *
 * @param {unknown} raw
 * @returns {string}
 */
function extractGoogleIdToken(raw) {
  if (raw == null) {
    return "";
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const obj = /** @type {Record<string, unknown>} */ (raw);
    return extractGoogleIdToken(
        obj.idToken || obj.id_token || obj.credential || obj.googleIdToken || obj.token,
    );
  }
  if (typeof raw !== "string") {
    return "";
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("{")) {
    try {
      return extractGoogleIdToken(JSON.parse(trimmed));
    } catch (_e) {
      return "";
    }
  }
  return trimmed;
}

/**
 * Verify a Google ID token (GIS / OAuth) — not a Firebase ID token.
 *
 * @param {string} idToken
 * @returns {Promise<{
 *   sub: string,
 *   email: string,
 *   emailVerified: boolean,
 *   name: string|null,
 *   picture: string|null,
 * }>}
 */
async function verifyGoogleIdToken(idToken) {
  const jwt = extractGoogleIdToken(idToken);
  if (!jwt) {
    throw httpError("Google idToken is required", "INVALID_ARGUMENT", 400);
  }
  let data;
  try {
    // POST keeps long GIS JWTs out of the query string (GET can 414 / truncate).
    const form = new URLSearchParams({id_token: jwt}).toString();
    try {
      const response = await axios.post(TOKENINFO_V3_URL, form, {
        timeout: 15000,
        headers: {"Content-Type": "application/x-www-form-urlencoded"},
      });
      data = response.data || {};
    } catch (postErr) {
      const postStatus = postErr.response?.status;
      if (postStatus === 400 || postStatus === 401) {
        throw postErr;
      }
      const response = await axios.get(TOKENINFO_URL, {
        params: {id_token: jwt},
        timeout: 15000,
      });
      data = response.data || {};
    }
  } catch (err) {
    const status = err.response?.status;
    if (status === 400 || status === 401) {
      throw httpError("Google idToken is invalid or expired", "INVALID_GOOGLE_TOKEN", 401);
    }
    console.error("googleAccountLinkService.verifyGoogleIdToken:", err.message);
    throw httpError("Unable to verify Google token", "GOOGLE_TOKEN_VERIFY_FAILED", 502);
  }

  const iss = typeof data.iss === "string" ? data.iss : "";
  if (!GOOGLE_ISSUERS.has(iss)) {
    throw httpError("Google idToken issuer is not Google", "INVALID_GOOGLE_TOKEN", 401);
  }

  const audiences = allowedAudiences();
  const aud = typeof data.aud === "string" ? data.aud : "";
  if (audiences.length > 0 && !audiences.includes(aud)) {
    throw httpError(
        "Google idToken audience does not match this app",
        "INVALID_GOOGLE_AUDIENCE",
        401,
    );
  }

  const email = normalizeEmail(data.email);
  if (!email) {
    throw httpError("Google account has no email", "GOOGLE_EMAIL_MISSING", 400);
  }
  if (!isTruthyFlag(data.email_verified)) {
    throw httpError(
        "Google email is not verified",
        "GOOGLE_EMAIL_NOT_VERIFIED",
        403,
    );
  }

  const sub = typeof data.sub === "string" ? data.sub.trim() : "";
  if (!sub) {
    throw httpError("Google idToken is missing subject", "INVALID_GOOGLE_TOKEN", 401);
  }

  return {
    sub,
    email,
    emailVerified: true,
    name: typeof data.name === "string" && data.name.trim() ? data.name.trim() : null,
    picture:
      typeof data.picture === "string" && data.picture.trim() ?
        data.picture.trim() :
        null,
  };
}

/**
 * @param {string} uid
 * @returns {Promise<{ uid: string, email: string, customToken: string, linked: boolean, created: boolean }>}
 */
async function mintCustomToken(uid, email, linked, created) {
  const customToken = await admin.auth().createCustomToken(uid);
  return {uid, email, customToken, linked, created};
}

/**
 * @param {import("firebase-admin").auth.UserRecord} user
 * @returns {import("firebase-admin").auth.UserInfo|undefined}
 */
function googleProvider(user) {
  return (user.providerData || []).find((p) => p.providerId === "google.com");
}

/**
 * @param {import("firebase-admin").auth.UserRecord} user
 * @returns {boolean}
 */
function hasPasswordProvider(user) {
  return (user.providerData || []).some((p) => p.providerId === "password");
}

/**
 * Attach google.com to an existing Auth user when emails match.
 *
 * @param {import("firebase-admin").auth.UserRecord} user
 * @param {{ sub: string, email: string, name: string|null, picture: string|null }} googleUser
 * @returns {Promise<{ uid: string, email: string, customToken: string, linked: boolean, created: boolean }>}
 */
async function linkExistingUser(user, googleUser) {
  if (user.disabled) {
    throw httpError("This account has been disabled", "USER_DISABLED", 403);
  }

  const existingGoogle = googleProvider(user);
  if (existingGoogle && existingGoogle.uid && existingGoogle.uid !== googleUser.sub) {
    throw httpError(
        "This email is already linked to a different Google account",
        "GOOGLE_PROVIDER_CONFLICT",
        409,
    );
  }

  // Unverified password signup cannot be claimed via Google (account takeover).
  if (
    !existingGoogle &&
    hasPasswordProvider(user) &&
    user.emailVerified !== true
  ) {
    throw httpError(
        "Verify this email before signing in with Google",
        "EMAIL_NOT_VERIFIED",
        403,
    );
  }

  // Already has google.com (uid may be missing on older records) — do not re-link.
  const alreadyLinked = Boolean(existingGoogle);
  const updates = {};
  if (!alreadyLinked) {
    updates.providerToLink = {
      providerId: "google.com",
      uid: googleUser.sub,
      email: googleUser.email,
      ...(googleUser.name ? {displayName: googleUser.name} : {}),
      ...(googleUser.picture ? {photoURL: googleUser.picture} : {}),
    };
  }
  if (user.emailVerified !== true) {
    updates.emailVerified = true;
  }
  if (googleUser.name && !user.displayName) {
    updates.displayName = googleUser.name;
  }
  if (Object.keys(updates).length > 0) {
    await admin.auth().updateUser(user.uid, updates);
  }

  return mintCustomToken(
      user.uid,
      googleUser.email,
      !alreadyLinked,
      false,
  );
}

/**
 * First-time Google login: create Auth user with google.com (no email/password yet).
 *
 * @param {{ sub: string, email: string, name: string|null, picture: string|null }} googleUser
 * @returns {Promise<{ uid: string, email: string, customToken: string, linked: boolean, created: boolean }>}
 */
async function createGoogleUser(googleUser) {
  const created = await admin.auth().createUser({
    email: googleUser.email,
    emailVerified: true,
    ...(googleUser.name ? {displayName: googleUser.name} : {}),
    ...(googleUser.picture ? {photoURL: googleUser.picture} : {}),
  });
  await admin.auth().updateUser(created.uid, {
    providerToLink: {
      providerId: "google.com",
      uid: googleUser.sub,
      email: googleUser.email,
      ...(googleUser.name ? {displayName: googleUser.name} : {}),
      ...(googleUser.picture ? {photoURL: googleUser.picture} : {}),
    },
  });
  return mintCustomToken(created.uid, googleUser.email, true, true);
}

/**
 * Exchange a Google ID token for a Firebase custom token on the canonical uid.
 *
 * @param {string} googleIdToken
 * @returns {Promise<{
 *   uid: string,
 *   email: string,
 *   customToken: string,
 *   linked: boolean,
 *   created: boolean,
 * }>}
 */
async function completeGoogleLogin(googleIdToken) {
  const googleUser = await verifyGoogleIdToken(googleIdToken);

  let existing = null;
  try {
    existing = await admin.auth().getUserByEmail(googleUser.email);
  } catch (err) {
    if (err.code !== "auth/user-not-found") {
      throw err;
    }
  }

  if (existing) {
    return linkExistingUser(existing, googleUser);
  }
  return createGoogleUser(googleUser);
}

module.exports = {
  completeGoogleLogin,
  verifyGoogleIdToken,
  extractGoogleIdToken,
  normalizeEmail,
};
