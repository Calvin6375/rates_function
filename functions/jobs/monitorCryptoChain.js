/**
 * @fileoverview Avalanche USDC monitor started by a deposit topup.
 * A new pending intent queues one scan at 5 minutes and one at 10 minutes.
 * Each scan is its own task, so the trigger stays under the 540s limit.
 */

const {onDocumentWritten} = require("firebase-functions/v2/firestore");
const {onTaskDispatched} = require("firebase-functions/v2/tasks");
const {getFunctions} = require("firebase-admin/functions");
const config = require("../config");
const {getTurnkeyFunctionSecrets} = require("../services/crypto/cryptoRailSecrets");
const {runChainMonitor} = require("../services/crypto/chainMonitorService");
const {getCryptoRailProviderName} = require("../services/crypto/cryptoRailProvider");

require("../admin");

const FIRST_RUN_SECONDS = 5 * 60;
const SECOND_RUN_SECONDS = 10 * 60;
const TASK_FUNCTION = "runCryptoChainMonitor";

/**
 * @param {Object} [opts]
 * @returns {Promise<Object>}
 */
async function runScheduledChainMonitor(opts) {
  if (getCryptoRailProviderName() !== "turnkey") {
    console.log("monitorCryptoChain: skipped (provider is not turnkey)");
    return {skipped: true, reason: "provider-not-turnkey"};
  }
  const result = await runChainMonitor(opts || {});
  console.log("monitorCryptoChain complete", result);
  return result;
}

/**
 * @param {Object} event
 * @returns {Object|null}
 */
function pendingTopupIntent(event) {
  const after = event && event.data && event.data.after && event.data.after.exists ?
    event.data.after.data() :
    null;
  const before = event && event.data && event.data.before && event.data.before.exists ?
    event.data.before.data() :
    null;
  if (!after || after.status !== "pending") return null;
  if (before && before.status === "pending") return null;
  return {
    intentId: event.params && event.params.intentId,
    address: after.depositAddressLower || after.depositAddress || "",
    network: after.network || "avalanche",
  };
}

/**
 * @param {string} intentId
 * @param {string} mark
 * @returns {string}
 */
function monitorTaskId(intentId, mark) {
  const safe = String(intentId || "intent").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 480);
  return `${safe}_${mark}`;
}

/**
 * @param {Error} err
 * @returns {boolean}
 */
function isDuplicateTaskError(err) {
  const message = String(err && (err.message || err) || "");
  return err && (err.code === 6 || /already exists/i.test(message));
}

/**
 * @param {Object} payload
 * @param {Object} options
 * @returns {Promise<void>}
 */
async function enqueueMonitorTask(payload, options) {
  const queue = getFunctions().taskQueue(TASK_FUNCTION);
  await queue.enqueue(payload, options);
}

/**
 * Queue the 5-minute scan and the 10-minute scan, then stop.
 * @param {Object} intent
 * @param {Object} [options]
 * @returns {Promise<Object>}
 */
async function enqueueTopupMonitorRuns(intent, options = {}) {
  const enqueue = options.enqueue || enqueueMonitorTask;
  const marks = [
    {mark: "5m", delaySeconds: FIRST_RUN_SECONDS},
    {mark: "10m", delaySeconds: SECOND_RUN_SECONDS},
  ];
  const queued = [];
  for (const item of marks) {
    try {
      await enqueue({
        address: intent.address,
        network: intent.network,
        intentId: intent.intentId,
        mark: item.mark,
      }, {
        scheduleDelaySeconds: item.delaySeconds,
        id: monitorTaskId(intent.intentId, item.mark),
      });
      queued.push({mark: item.mark, delaySeconds: item.delaySeconds});
    } catch (err) {
      if (!isDuplicateTaskError(err)) throw err;
      queued.push({mark: item.mark, delaySeconds: item.delaySeconds, duplicate: true});
    }
  }
  return {stopped: true, queued};
}

/**
 * @param {Object} event
 * @param {Object} [options]
 * @returns {Promise<Object>}
 */
async function handleTopupIntentEvent(event, options = {}) {
  const intent = pendingTopupIntent(event);
  if (!intent || !intent.address) {
    return {skipped: true, reason: "not-a-new-topup"};
  }
  const result = await enqueueTopupMonitorRuns(intent, options);
  console.log("monitorCryptoChain topup scans queued", {
    intentId: intent.intentId,
    queued: result.queued,
  });
  return result;
}

/**
 * @param {Object} request
 * @returns {Promise<Object>}
 */
async function handleMonitorTask(request) {
  const data = request && request.data || {};
  return runScheduledChainMonitor({
    address: data.address,
    network: data.network,
  });
}

const functionOptions = {
  secrets: getTurnkeyFunctionSecrets(),
  region: config.region,
  cpu: config.resources.cpu,
  memory: config.resources.memory,
};

exports.monitorCryptoChain = onDocumentWritten(
    {
      ...functionOptions,
      document: `${config.collections.cryptoDepositIntents}/{intentId}`,
      timeoutSeconds: 60,
    },
    async (event) => {
      await handleTopupIntentEvent(event);
    },
);

exports.runCryptoChainMonitor = onTaskDispatched(
    {
      ...functionOptions,
      timeoutSeconds: 180,
      retryConfig: {
        maxAttempts: 3,
        minBackoffSeconds: 30,
      },
      rateLimits: {
        maxConcurrentDispatches: 5,
      },
    },
    async (request) => {
      await handleMonitorTask(request);
    },
);

module.exports.runScheduledChainMonitor = runScheduledChainMonitor;
module.exports.pendingTopupIntent = pendingTopupIntent;
module.exports.enqueueTopupMonitorRuns = enqueueTopupMonitorRuns;
module.exports.handleTopupIntentEvent = handleTopupIntentEvent;
module.exports.handleMonitorTask = handleMonitorTask;
module.exports.FIRST_RUN_SECONDS = FIRST_RUN_SECONDS;
module.exports.SECOND_RUN_SECONDS = SECOND_RUN_SECONDS;
