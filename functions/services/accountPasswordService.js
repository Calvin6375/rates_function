/**
 * @fileoverview Account password change / reset helpers for B2B portal.
 * Change-password verifies the current password via Identity Toolkit, then
 * updates via Admin SDK. Forgot-password sends Firebase PASSWORD_RESET email.
 */

const axios = require("axios");
const admin = require("../admin");
const config = require("../config");

const SIGN_IN_URL = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword";
const SEND_OOB_URL = "https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode";

const MIN_PASSWORD_LENGTH = 8;

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
 * @param {string} email
 * @returns {boolean}
 */
function isValidEmailShape(email) {
  if (!email || email.length > 254) {
    return false;
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * @returns {string}
 */
function requireWebApiKey() {
  // Prefer live env (Secret Manager injects WEB_API_KEY at runtime).
  const key =
    process.env.WEB_API_KEY ||
    process.env.FIREBASE_WEB_API_KEY ||
    config.firebaseWebApiKey;
  if (!key || !String(key).trim()) {
    const err = new Error("Password change is not configured (WEB_API_KEY)");
    err.code = "FAILED_PRECONDITION";
    err.statusCode = 503;
    throw err;
  }
  return String(key).trim();
}

/**
 * @param {string} password
 * @param {string} label
 */
function assertPasswordStrength(password, label = "Password") {
  if (!password || typeof password !== "string") {
    const err = new Error(`${label} is required`);
    err.code = "INVALID_ARGUMENT";
    err.statusCode = 400;
    throw err;
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    const err = new Error(`${label} must be at least ${MIN_PASSWORD_LENGTH} characters`);
    err.code = "WEAK_PASSWORD";
    err.statusCode = 400;
    throw err;
  }
}

/**
 * @param {import("axios").AxiosError} err
 * @returns {string|null}
 */
function identityToolkitMessage(err) {
  return err.response?.data?.error?.message || null;
}

/**
 * Verify email+password against Identity Toolkit (does not mint a session for the client).
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ localId: string, email: string }>}
 */
async function verifyEmailPassword(email, password) {
  const webApiKey = requireWebApiKey();
  try {
    const response = await axios.post(
        `${SIGN_IN_URL}?key=${encodeURIComponent(webApiKey)}`,
        {
          email,
          password,
          returnSecureToken: true,
        },
        {
          timeout: 15000,
          headers: {"Content-Type": "application/json"},
        },
    );
    const data = response.data || {};
    return {
      localId: String(data.localId || ""),
      email: normalizeEmail(data.email || email),
    };
  } catch (err) {
    const apiMessage = identityToolkitMessage(err);
    if (
      apiMessage === "INVALID_PASSWORD" ||
      apiMessage === "INVALID_LOGIN_CREDENTIALS" ||
      apiMessage === "EMAIL_NOT_FOUND"
    ) {
      const e = new Error("Current password is incorrect");
      e.code = "INVALID_CURRENT_PASSWORD";
      e.statusCode = 401;
      throw e;
    }
    if (apiMessage === "USER_DISABLED") {
      const e = new Error("This account has been disabled");
      e.code = "USER_DISABLED";
      e.statusCode = 403;
      throw e;
    }
    if (
      apiMessage === "TOO_MANY_ATTEMPTS_TRY_LATER" ||
      apiMessage === "RESET_PASSWORD_EXCEED_LIMIT"
    ) {
      const e = new Error("Too many attempts. Please try again later.");
      e.code = "RATE_LIMITED";
      e.statusCode = 429;
      throw e;
    }
    console.error("accountPasswordService.verifyEmailPassword:", {
      apiMessage,
      status: err.response?.status,
      message: err.message,
    });
    const e = new Error("Unable to verify current password");
    e.code = "INTERNAL";
    e.statusCode = 500;
    throw e;
  }
}

/**
 * Change password for a signed-in user (Account Settings → Update Password).
 *
 * @param {string} uid
 * @param {Object} input
 * @param {string} input.currentPassword
 * @param {string} input.newPassword
 * @param {string} [input.confirmPassword]
 * @returns {Promise<{ success: true }>}
 */
async function changePassword(uid, input = {}) {
  if (!uid) {
    const err = new Error("Authentication required");
    err.code = "UNAUTHENTICATED";
    err.statusCode = 401;
    throw err;
  }

  const currentPassword = input.currentPassword != null ? String(input.currentPassword) : "";
  const newPassword = input.newPassword != null ? String(input.newPassword) : "";
  const confirmPassword =
    input.confirmPassword != null ? String(input.confirmPassword) : null;

  assertPasswordStrength(currentPassword, "Current password");
  assertPasswordStrength(newPassword, "New password");

  if (confirmPassword != null && confirmPassword !== newPassword) {
    const err = new Error("New password and confirmation do not match");
    err.code = "PASSWORD_MISMATCH";
    err.statusCode = 400;
    throw err;
  }

  if (currentPassword === newPassword) {
    const err = new Error("New password must be different from the current password");
    err.code = "PASSWORD_UNCHANGED";
    err.statusCode = 400;
    throw err;
  }

  let userRecord;
  try {
    userRecord = await admin.auth().getUser(uid);
  } catch (e) {
    if (e.code === "auth/user-not-found") {
      const err = new Error("User not found");
      err.code = "NOT_FOUND";
      err.statusCode = 404;
      throw err;
    }
    throw e;
  }

  const providers = (userRecord.providerData || []).map((p) => p.providerId);
  const hasPassword = providers.includes("password");
  if (!hasPassword) {
    const err = new Error(
        "This account uses Google (or another provider) and has no password. " +
        "Sign in with that provider, or set a password from the forgot-password email flow after linking email/password.",
    );
    err.code = "NO_PASSWORD_PROVIDER";
    err.statusCode = 400;
    throw err;
  }

  const email = normalizeEmail(userRecord.email);
  if (!email) {
    const err = new Error("Account has no email address");
    err.code = "NO_EMAIL";
    err.statusCode = 400;
    throw err;
  }

  const verified = await verifyEmailPassword(email, currentPassword);
  if (verified.localId && verified.localId !== uid) {
    const err = new Error("Current password is incorrect");
    err.code = "INVALID_CURRENT_PASSWORD";
    err.statusCode = 401;
    throw err;
  }

  try {
    await admin.auth().updateUser(uid, {password: newPassword});
  } catch (e) {
    if (e.code === "auth/weak-password" || e.code === "auth/invalid-password") {
      const err = new Error("New password does not meet security requirements");
      err.code = "WEAK_PASSWORD";
      err.statusCode = 400;
      throw err;
    }
    console.error("accountPasswordService.changePassword updateUser:", e.message);
    const err = new Error("Unable to update password");
    err.code = "INTERNAL";
    err.statusCode = 500;
    throw err;
  }

  return {success: true};
}

/**
 * Send Firebase Auth password-reset email (forgot password).
 *
 * @param {Object} input
 * @param {string} input.email
 * @param {string} [input.continueUrl]
 * @returns {Promise<{ success: true }>}
 */
async function requestPasswordResetEmail(input = {}) {
  const email = normalizeEmail(input.email);
  if (!email) {
    const err = new Error("Email is required");
    err.code = "INVALID_ARGUMENT";
    err.statusCode = 400;
    throw err;
  }
  if (!isValidEmailShape(email)) {
    const err = new Error("Invalid email address");
    err.code = "INVALID_ARGUMENT";
    err.statusCode = 400;
    throw err;
  }

  const webApiKey = requireWebApiKey();
  /** @type {{ requestType: string, email: string, continueUrl?: string }} */
  const payload = {
    requestType: "PASSWORD_RESET",
    email,
  };

  if (input.continueUrl && typeof input.continueUrl === "string") {
    const u = input.continueUrl.trim();
    if (u.length > 0 && u.length <= 2048) {
      payload.continueUrl = u;
    }
  } else if (config.b2bDashboardUrl) {
    payload.continueUrl = String(config.b2bDashboardUrl).replace(/\/+$/, "") + "/login";
  }

  try {
    await axios.post(
        `${SEND_OOB_URL}?key=${encodeURIComponent(webApiKey)}`,
        payload,
        {
          timeout: 15000,
          headers: {"Content-Type": "application/json"},
        },
    );
  } catch (err) {
    const apiMessage = identityToolkitMessage(err);
    if (apiMessage === "EMAIL_NOT_FOUND") {
      // Do not reveal whether the email exists.
      return {success: true};
    }
    if (apiMessage === "INVALID_EMAIL") {
      const e = new Error("Invalid email address");
      e.code = "INVALID_ARGUMENT";
      e.statusCode = 400;
      throw e;
    }
    if (
      apiMessage === "RESET_PASSWORD_EXCEED_LIMIT" ||
      apiMessage === "TOO_MANY_ATTEMPTS_TRY_LATER"
    ) {
      const e = new Error("Too many attempts. Please try again later.");
      e.code = "RATE_LIMITED";
      e.statusCode = 429;
      throw e;
    }
    console.error("accountPasswordService.requestPasswordResetEmail:", {
      apiMessage,
      status: err.response?.status,
      message: err.message,
    });
    const e = new Error("Unable to send reset email. Please try again later.");
    e.code = "INTERNAL";
    e.statusCode = 500;
    throw e;
  }

  return {success: true};
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  changePassword,
  requestPasswordResetEmail,
  normalizeEmail,
  verifyEmailPassword,
};
