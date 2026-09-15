/**
 * @fileoverview Admin/private runner for Circle → Turnkey deposit-address migration.
 */

const {onRequest, HttpsError, onCall} = require("firebase-functions/v2/https");
const config = require("../config");
const {verifyAdminFromToken, isSuperAdmin} = require("../utils/adminClaims");
const {getTurnkeyFunctionSecrets} = require("../services/crypto/cryptoRailSecrets");
const {
  migrateCircleWalletsToTurnkey,
  CircleWalletMigrationError,
} = require("../services/crypto/turnkey/migrateCircleWalletsToTurnkeyService");

/**
 * @param {Object} auth
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
 * @param {Object} [data]
 */
async function migrateCircleWalletsHandler(data = {}) {
  return migrateCircleWalletsToTurnkey({
    apply: data.apply === true,
    userId: data.userId,
    limit: data.limit,
  });
}

exports.migrateCircleWalletsToTurnkey = onCall(
    {
      secrets: getTurnkeyFunctionSecrets(),
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
      timeoutSeconds: 300,
      enforceAppCheck: false,
    },
    async (request) => {
      await assertAdminCaller(request.auth);
      try {
        return await migrateCircleWalletsHandler(request.data || {});
      } catch (err) {
        const message = err.message || "Circle wallet migration failed";
        if (err instanceof CircleWalletMigrationError) {
          throw new HttpsError("failed-precondition", message);
        }
        throw new HttpsError("unavailable", message);
      }
    },
);

exports.runMigrateCircleWalletsToTurnkey = onRequest(
    {
      secrets: getTurnkeyFunctionSecrets(),
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
      timeoutSeconds: 300,
      invoker: "private",
    },
    async (req, res) => {
      if (req.method !== "POST") {
        res.status(405).json({success: false, error: "POST required"});
        return;
      }
      try {
        const result = await migrateCircleWalletsHandler(req.body || {});
        res.status(200).json(result);
      } catch (err) {
        res.status(500).json({
          success: false,
          error: err.message || "Circle wallet migration failed",
        });
      }
    },
);
