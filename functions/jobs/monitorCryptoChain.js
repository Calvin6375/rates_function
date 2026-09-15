/**
 * @fileoverview Poll Avalanche C-Chain mainnet for USDC deposits and
 * outbound confirmations. Fuji is no longer scanned by this job.
 */

const {onSchedule} = require("firebase-functions/v2/scheduler");
const config = require("../config");
const {getTurnkeyFunctionSecrets} = require("../services/crypto/cryptoRailSecrets");
const {runChainMonitor} = require("../services/crypto/chainMonitorService");
const {getCryptoRailProviderName} = require("../services/crypto/cryptoRailProvider");

/**
 * Provider guard used by the scheduled job. Do not bypass this check.
 * @returns {Promise<Object>}
 */
async function runScheduledChainMonitor() {
  if (getCryptoRailProviderName() !== "turnkey") {
    console.log("monitorCryptoChain: skipped (provider is not turnkey)");
    return {skipped: true, reason: "provider-not-turnkey"};
  }
  const result = await runChainMonitor();
  console.log("monitorCryptoChain complete", result);
  return result;
}

exports.monitorCryptoChain = onSchedule(
    {
      schedule: "* * * * *",
      secrets: getTurnkeyFunctionSecrets(),
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
    },
    async () => {
      await runScheduledChainMonitor();
    },
);

module.exports.runChainMonitor = runChainMonitor;
module.exports.runScheduledChainMonitor = runScheduledChainMonitor;
