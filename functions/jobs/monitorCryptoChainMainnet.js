/**
 * @fileoverview Daily mainnet treasury sweep (08:00 Africa/Nairobi).
 * Deposit detection stays on the per-minute monitorCryptoChain job.
 */

const {onSchedule} = require("firebase-functions/v2/scheduler");
const config = require("../config");
const {getTurnkeyFunctionSecrets} = require("../services/crypto/cryptoRailSecrets");
const {getCryptoRailProviderName} = require("../services/crypto/cryptoRailProvider");

exports.monitorCryptoChainMainnet = onSchedule(
    {
      schedule: "0 8 * * *",
      timeZone: "Africa/Nairobi",
      secrets: getTurnkeyFunctionSecrets(),
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
    },
    async () => {
      if (getCryptoRailProviderName() !== "turnkey") {
        console.log("monitorCryptoChainMainnet: skipped (provider is not turnkey)");
        return;
      }
      const treasurySweepService = require("../services/crypto/treasurySweepService");
      const result = await treasurySweepService.runSweepCycle("avalanche");
      console.log("monitorCryptoChainMainnet complete", result);
    },
);
