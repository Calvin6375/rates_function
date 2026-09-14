/**
 * @fileoverview Admin-only Turnkey connectivity probe. Does not create wallets
 * or sign transactions. Secrets stay server-side.
 */

const {onCall, HttpsError} = require("firebase-functions/v2/https");
const config = require("../config");
const {verifyAdminFromToken} = require("../utils/adminClaims");
const {getTurnkeyFunctionSecrets} = require("../services/crypto/cryptoRailSecrets");
const {
  testTurnkeyConnection,
  getTurnkeyTreasuryWallet,
  getTurnkeyTreasuryBalances,
} = require("../services/crypto/turnkey/turnkeyClient");

/**
 * Callable: verify Firebase → Turnkey SDK → API key auth.
 * Admin-only. Response never includes credentials or organization ids.
 */
exports.testTurnkeyConnection = onCall(
    {
      secrets: getTurnkeyFunctionSecrets(),
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
      enforceAppCheck: false,
    },
    async (request) => {
      if (!request.auth?.uid) {
        throw new HttpsError("unauthenticated", "Authentication required");
      }
      if (!verifyAdminFromToken(request.auth)) {
        throw new HttpsError("permission-denied", "Admin access required");
      }

      try {
        return await testTurnkeyConnection();
      } catch (err) {
        const message = err.message || "Turnkey connection test failed";
        if (message.includes("incomplete")) {
          throw new HttpsError("failed-precondition", message);
        }
        throw new HttpsError("unavailable", message);
      }
    },
);

/**
 * Callable: read-only lookup of Company Wallet "TruePay Treasury Dev".
 * Admin-only. Does not create wallets, sign, or return credentials.
 */
exports.getTurnkeyTreasuryWallet = onCall(
    {
      secrets: getTurnkeyFunctionSecrets(),
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
      enforceAppCheck: false,
    },
    async (request) => {
      if (!request.auth?.uid) {
        throw new HttpsError("unauthenticated", "Authentication required");
      }
      if (!verifyAdminFromToken(request.auth)) {
        throw new HttpsError("permission-denied", "Admin access required");
      }

      try {
        return await getTurnkeyTreasuryWallet();
      } catch (err) {
        const message = err.message || "Turnkey treasury wallet lookup failed";
        if (message.includes("incomplete")) {
          throw new HttpsError("failed-precondition", message);
        }
        throw new HttpsError("unavailable", message);
      }
    },
);

/**
 * Callable: read-only USDC/USDT balances for TruePay Treasury Dev.
 * Admin-only. Does not sign, send, or write Firestore.
 */
exports.getTurnkeyTreasuryBalances = onCall(
    {
      secrets: getTurnkeyFunctionSecrets(),
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
      enforceAppCheck: false,
    },
    async (request) => {
      if (!request.auth?.uid) {
        throw new HttpsError("unauthenticated", "Authentication required");
      }
      if (!verifyAdminFromToken(request.auth)) {
        throw new HttpsError("permission-denied", "Admin access required");
      }

      try {
        return await getTurnkeyTreasuryBalances();
      } catch (err) {
        const message = err.message || "Turnkey treasury balance lookup failed";
        if (message.includes("incomplete")) {
          throw new HttpsError("failed-precondition", message);
        }
        throw new HttpsError("unavailable", message);
      }
    },
);
