/**
 * @fileoverview Customer app authentication callables (password reset, etc.)
 */

const {onCall, HttpsError} = require("firebase-functions/v2/https");
const axios = require("axios");
const config = require("../config");

const SEND_OOB_URL = "https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode";

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
 * Callable: send Firebase Auth password-reset email (Identity Toolkit PASSWORD_RESET).
 * Unauthenticated. Mirrors client `sendPasswordResetEmail` behavior for unknown emails.
 *
 * Request data:
 * - `email` (string, required)
 * - `continueUrl` (string, optional) — must be allowed in Firebase Console → Auth → Authorized domains
 * - `canHandleCodeInApp` (boolean, optional) — set true for mobile deep-link handling
 *
 * Requires `FIREBASE_WEB_API_KEY` on the function (same value as in your client Firebase config).
 */
exports.requestPasswordReset = onCall(
    {
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
      enforceAppCheck: false,
    },
    async (request) => {
      const email = normalizeEmail(request.data && request.data.email);
      if (!email) {
        throw new HttpsError("invalid-argument", "Email is required");
      }
      if (!isValidEmailShape(email)) {
        throw new HttpsError("invalid-argument", "Invalid email address");
      }

      const webApiKey = config.firebaseWebApiKey;
      if (!webApiKey) {
        console.error("requestPasswordReset: FIREBASE_WEB_API_KEY is not set");
        throw new HttpsError(
            "failed-precondition",
            "Password reset is not configured on the server.",
        );
      }

      /** @type {{ requestType: string, email: string, continueUrl?: string, canHandleCodeInApp?: boolean }} */
      const payload = {
        requestType: "PASSWORD_RESET",
        email,
      };

      const body = request.data || {};
      if (body.continueUrl && typeof body.continueUrl === "string") {
        const u = body.continueUrl.trim();
        if (u.length > 0 && u.length <= 2048) {
          payload.continueUrl = u;
        }
      }
      if (body.canHandleCodeInApp === true) {
        payload.canHandleCodeInApp = true;
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
        const apiMessage =
          err.response &&
          err.response.data &&
          err.response.data.error &&
          err.response.data.error.message;

        if (apiMessage === "EMAIL_NOT_FOUND") {
          return {success: true};
        }
        if (apiMessage === "INVALID_EMAIL") {
          throw new HttpsError("invalid-argument", "Invalid email address");
        }
        if (
          apiMessage === "RESET_PASSWORD_EXCEED_LIMIT" ||
          apiMessage === "TOO_MANY_ATTEMPTS_TRY_LATER"
        ) {
          throw new HttpsError(
              "resource-exhausted",
              "Too many attempts. Please try again later.",
          );
        }

        console.error("requestPasswordReset: Identity Toolkit error", {
          apiMessage,
          status: err.response && err.response.status,
          message: err.message,
        });
        throw new HttpsError(
            "internal",
            "Unable to send reset email. Please try again later.",
        );
      }

      return {success: true};
    },
);
