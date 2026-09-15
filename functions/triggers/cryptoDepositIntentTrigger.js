/**
 * @fileoverview Starts a short-lived USDC deposit watch when an intent becomes pending.
 */

const {onDocumentWritten} = require("firebase-functions/v2/firestore");
const config = require("../config");
const {getTurnkeyFunctionSecrets} = require("../services/crypto/cryptoRailSecrets");
const {
  runDepositWatchLoop,
} = require("../services/crypto/turnkey/cryptoDepositMonitoringService");

exports.watchCryptoDepositIntent = onDocumentWritten(
    {
      document: `${config.collections.cryptoDepositIntents}/{intentId}`,
      secrets: getTurnkeyFunctionSecrets(),
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
      timeoutSeconds: 80,
    },
    async (event) => {
      const after = event.data && event.data.after && event.data.after.exists ?
        event.data.after.data() :
        null;
      const before = event.data && event.data.before && event.data.before.exists ?
        event.data.before.data() :
        null;
      if (!after || after.status !== "pending") {
        return;
      }
      if (before && before.status === "pending") {
        return;
      }
      const result = await runDepositWatchLoop(event.params.intentId);
      console.log("crypto deposit watch finished", {
        intentId: event.params.intentId,
        status: result.status,
        polls: result.polls,
      });
    },
);
