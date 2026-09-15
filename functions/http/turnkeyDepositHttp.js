/**
 * @fileoverview Admin-only Turnkey customer deposit-address provisioning.
 */

const {onCall, onRequest, HttpsError} = require("firebase-functions/v2/https");
const config = require("../config");
const {verifyAdminFromToken, isSuperAdmin} = require("../utils/adminClaims");
const {getTurnkeyFunctionSecrets} = require("../services/crypto/cryptoRailSecrets");
const {
  SUPPORTED_NETWORK,
  getOrCreateUserDepositAddress,
  DepositAddressError,
} = require("../services/crypto/turnkey/turnkeyDepositAddressService");

/**
 * @param {Object} auth
 * @returns {Promise<void>}
 */
async function assertAdminCaller(auth) {
  if (!auth?.uid) {
    throw new HttpsError("unauthenticated", "Authentication required");
  }
  const token = auth.token || auth;
  const platformAdmin = verifyAdminFromToken(auth);
  const superAdmin = await isSuperAdmin(token, auth.uid);
  if (!platformAdmin && !superAdmin) {
    throw new HttpsError("permission-denied", "Admin access required");
  }
}

/**
 * @param {unknown} userId
 * @returns {Promise<Object>}
 */
async function createOrGetTurnkeyDepositAddressHandler(userId) {
  return getOrCreateUserDepositAddress(userId, SUPPORTED_NETWORK);
}

/**
 * Callable: create or return a customer's Fuji USDC deposit address.
 */
exports.createOrGetTurnkeyDepositAddress = onCall(
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
        return await createOrGetTurnkeyDepositAddressHandler(request.data?.userId);
      } catch (err) {
        const message = err.message || "Deposit address request failed";
        if (err instanceof DepositAddressError || err.name === "DepositAddressError") {
          const code = err.code === "INVALID_USER" ? "not-found" : "failed-precondition";
          throw new HttpsError(code, message);
        }
        throw new HttpsError("unavailable", message);
      }
    },
);

/**
 * Private HTTP runner for the same get-or-create path.
 */
exports.runCreateOrGetTurnkeyDepositAddress = onRequest(
    {
      secrets: getTurnkeyFunctionSecrets(),
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
      invoker: "private",
    },
    async (req, res) => {
      if (req.method !== "POST") {
        res.status(405).json({success: false, error: "POST required"});
        return;
      }
      try {
        const result = await createOrGetTurnkeyDepositAddressHandler(req.body?.userId);
        res.status(200).json(result);
      } catch (err) {
        const message = err.message || "Deposit address request failed";
        const status = (err instanceof DepositAddressError ||
          err.name === "DepositAddressError") ? 400 : 500;
        res.status(status).json({success: false, error: message, code: err.code || null});
      }
    },
);

exports.assertAdminCaller = assertAdminCaller;
exports.createOrGetTurnkeyDepositAddressHandler = createOrGetTurnkeyDepositAddressHandler;
