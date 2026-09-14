/**
 * @fileoverview Provider-aware scheduled reconciliation (Circle or Turnkey/Fuji).
 */

const {onSchedule} = require("firebase-functions/v2/scheduler");
const config = require("../config");
const {getCryptoFunctionSecrets} = require("../services/crypto/cryptoRailSecrets");
const {
  runCryptoLedgerReconciliation,
} = require("../services/crypto/reconcileCryptoLedgerService");

exports.reconcileCryptoLedger = onSchedule(
    {
      schedule: "0 */6 * * *",
      secrets: getCryptoFunctionSecrets(),
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
    },
    async () => {
      const result = await runCryptoLedgerReconciliation();
      console.log("reconcileCryptoLedger complete", result);
    },
);

module.exports.runCryptoLedgerReconciliation = runCryptoLedgerReconciliation;
