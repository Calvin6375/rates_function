/**
 * @fileoverview Poll Avalanche C-Chain for production USDC deposits.
 * Isolated from the Fuji monitor: different RPC, USDC, cursor, and addresses.
 */

const {onSchedule} = require("firebase-functions/v2/scheduler");
const config = require("../config");
const {getTurnkeyFunctionSecrets} = require("../services/crypto/cryptoRailSecrets");
const {processConfirmedMainnetDeposits} = require("../services/crypto/chainMonitorService");
const {getCryptoRailProviderName} = require("../services/crypto/cryptoRailProvider");

exports.monitorCryptoChainMainnet = onSchedule(
    {
      schedule: "* * * * *",
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
      const result = await processConfirmedMainnetDeposits();
      console.log("monitorCryptoChainMainnet complete", result);
    },
);
