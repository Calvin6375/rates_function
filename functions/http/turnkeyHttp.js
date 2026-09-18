/**
 * @fileoverview Admin-only Turnkey connectivity probe. Does not create wallets
 * or sign transactions. Secrets stay server-side.
 */

const {onCall, HttpsError} = require("firebase-functions/v2/https");
const config = require("../config");
const {verifyAdminFromToken, isSuperAdmin, isPlatformAdmin} = require("../utils/adminClaims");
const {getTurnkeyFunctionSecrets} = require("../services/crypto/cryptoRailSecrets");
const {CODES} = require("../services/crypto/cryptoErrors");
const {
  testTurnkeyConnection,
  getTurnkeyTreasuryWallet,
  getTurnkeyTreasuryBalances,
} = require("../services/crypto/turnkey/turnkeyClient");

/**
 * Any platform admin. Used by Turnkey connectivity / wallet lookup.
 * @param {Object|null|undefined} auth
 */
async function assertAdminCaller(auth) {
  if (!auth?.uid) {
    throw new HttpsError("unauthenticated", "Authentication required");
  }
  const token = auth.token || auth;
  if (verifyAdminFromToken(auth)) {
    return;
  }
  if (await isSuperAdmin(token, auth.uid)) {
    return;
  }
  if (await isPlatformAdmin(token, auth.uid)) {
    return;
  }
  throw new HttpsError("permission-denied", "Admin access required");
}

/**
 * Super-admin only. Master-admin email counts; finance/ops/support do not.
 * @param {Object|null|undefined} auth
 */
async function assertSuperAdminCaller(auth) {
  if (!auth?.uid) {
    throw new HttpsError("unauthenticated", "Authentication required");
  }
  const token = auth.token || auth;
  if (await isSuperAdmin(token, auth.uid)) {
    return;
  }
  throw new HttpsError("permission-denied", "Super admin access required");
}

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
      await assertAdminCaller(request.auth);

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
      await assertAdminCaller(request.auth);

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
 * @param {Object} request
 * @returns {Promise<Object>}
 */
async function handleGetTurnkeyTreasuryBalances(request) {
  await assertSuperAdminCaller(request.auth);
  try {
    return await getTurnkeyTreasuryBalances({
      network: request.data && request.data.network,
    });
  } catch (err) {
    const message = err.message || "Turnkey treasury balance lookup failed";
    if (err.code === CODES.UNSUPPORTED_NETWORK) {
      throw new HttpsError("invalid-argument", "Unsupported network");
    }
    if (err.code === "TREASURY_CONFIG_INVALID" || message.includes("does not match the configured")) {
      throw new HttpsError("failed-precondition", "Treasury configuration is invalid");
    }
    if (message.includes("incomplete")) {
      throw new HttpsError("failed-precondition", message);
    }
    throw new HttpsError("unavailable", "Unable to retrieve live treasury balance");
  }
}

/**
 * Callable: read-only on-chain USDC/AVAX balances for the Turnkey treasury.
 * Super-admin only. Does not sign, send, or write Firestore.
 * Body: `{ network: "avalanche" | "avalanche-fuji" }` (default Fuji).
 */
exports.getTurnkeyTreasuryBalances = onCall(
    {
      secrets: getTurnkeyFunctionSecrets(),
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
      enforceAppCheck: false,
    },
    handleGetTurnkeyTreasuryBalances,
);

exports.assertAdminCaller = assertAdminCaller;
exports.assertSuperAdminCaller = assertSuperAdminCaller;
exports.handleGetTurnkeyTreasuryBalances = handleGetTurnkeyTreasuryBalances;
