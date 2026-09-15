/**
 * @fileoverview Admin-only manual Fuji USDC deposit scanner.
 */

const {onCall, onRequest, HttpsError} = require("firebase-functions/v2/https");
const config = require("../config");
const {assertAdminCaller} = require("./turnkeyDepositHttp");
const {
  scanUsdcDeposits,
  DepositScanError,
} = require("../services/crypto/turnkey/turnkeyDepositScannerService");

/**
 * @param {Object} [data]
 * @returns {Promise<Object>}
 */
async function scanTurnkeyUsdcDepositsHandler(data = {}) {
  return scanUsdcDeposits({
    fromBlock: data.fromBlock,
    toBlock: data.toBlock,
    network: data.network,
    asset: data.asset,
  });
}

/**
 * Callable: scan a Fuji USDC Transfer block range and credit known deposit addresses.
 */
exports.scanTurnkeyUsdcDeposits = onCall(
    {
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
      enforceAppCheck: false,
    },
    async (request) => {
      await assertAdminCaller(request.auth);
      try {
        return await scanTurnkeyUsdcDepositsHandler(request.data || {});
      } catch (err) {
        const message = err.message || "USDC deposit scan failed";
        if (err instanceof DepositScanError || err.name === "DepositScanError") {
          throw new HttpsError("invalid-argument", message);
        }
        throw new HttpsError("unavailable", message);
      }
    },
);

/**
 * Private HTTP runner for the same manual scan path.
 */
exports.runScanTurnkeyUsdcDeposits = onRequest(
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
        const result = await scanTurnkeyUsdcDepositsHandler(req.body || {});
        res.status(200).json(result);
      } catch (err) {
        const message = err.message || "USDC deposit scan failed";
        const status = (err instanceof DepositScanError ||
          err.name === "DepositScanError") ? 400 : 500;
        res.status(status).json({success: false, error: message, code: err.code || null});
      }
    },
);

exports.scanTurnkeyUsdcDepositsHandler = scanTurnkeyUsdcDepositsHandler;
