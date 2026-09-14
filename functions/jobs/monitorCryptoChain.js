/**
 * @fileoverview Poll Avalanche Fuji for USDC deposits and outbound confirmations.
 */

const {onSchedule} = require("firebase-functions/v2/scheduler");
const config = require("../config");
const {getTurnkeyFunctionSecrets} = require("../services/crypto/cryptoRailSecrets");
const {runChainMonitor} = require("../services/crypto/chainMonitorService");
const {getCryptoRailProviderName} = require("../services/crypto/cryptoRailProvider");

exports.monitorCryptoChain = onSchedule(
    {
      schedule: "* * * * *",
      secrets: getTurnkeyFunctionSecrets(),
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
    },
    async () => {
      if (getCryptoRailProviderName() !== "turnkey") {
        console.log("monitorCryptoChain: skipped (provider is not turnkey)");
        return;
      }
      const result = await runChainMonitor();
      console.log("monitorCryptoChain complete", result);
    },
);

module.exports.runChainMonitor = runChainMonitor;
