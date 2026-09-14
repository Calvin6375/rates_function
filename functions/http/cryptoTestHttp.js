/**
 * @fileoverview Admin-only Fuji USDC deposit test callable.
 */

const {onCall, onRequest, HttpsError} = require("firebase-functions/v2/https");
const config = require("../config");
const {isSuperAdmin} = require("../utils/adminClaims");
const {
  testProcessUsdcDeposit,
  DepositValidationError,
} = require("../services/crypto/testProcessUsdcDepositService");

/**
 * Callable: validate a Fuji USDC tx and credit the built-in super-admin ledger.
 */
exports.testProcessUsdcDeposit = onCall(
    {
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
      enforceAppCheck: false,
    },
    async (request) => {
      if (!request.auth?.uid) {
        throw new HttpsError("unauthenticated", "Authentication required");
      }
      const token = request.auth.token || request.auth;
      if (!(await isSuperAdmin(token, request.auth.uid))) {
        throw new HttpsError("permission-denied", "Super-admin access required");
      }

      try {
        return await testProcessUsdcDeposit(request.data?.txHash, {
          userId: request.auth.uid,
        });
      } catch (err) {
        const message = err.message || "USDC deposit test failed";
        if (err instanceof DepositValidationError || err.name === "DepositValidationError") {
          throw new HttpsError("failed-precondition", message);
        }
        throw new HttpsError("unavailable", message);
      }
    },
);

/**
 * Private HTTP runner for the same ledger credit. IAM-authenticated only.
 * Used when a Firebase ID token is not available locally.
 */
exports.runTestProcessUsdcDeposit = onRequest(
    {
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
        const result = await testProcessUsdcDeposit(req.body?.txHash);
        res.status(200).json(result);
      } catch (err) {
        const message = err.message || "USDC deposit test failed";
        const status = (err instanceof DepositValidationError ||
          err.name === "DepositValidationError") ? 400 : 500;
        res.status(status).json({success: false, error: message});
      }
    },
);
