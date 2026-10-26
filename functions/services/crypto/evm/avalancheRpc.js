/**
 * @fileoverview Avalanche C-Chain read failover.
 * The public api.avax.network endpoint rate-limits broad log scans.
 * Reads try the configured URL, then a small set of alternate public RPCs.
 */

const {ethers} = require("ethers");

const DEFAULT_FALLBACK_URLS = Object.freeze([
  "https://avalanche-c-chain-rpc.publicnode.com",
  "https://1rpc.io/avax/c",
]);

/**
 * @param {string} primaryUrl
 * @return {string[]}
 */
function listAvalancheRpcUrls(primaryUrl) {
  const configured = String(process.env.AVALANCHE_RPC_FALLBACK_URLS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  const urls = [
    String(primaryUrl || "").trim(),
    ...configured,
    ...DEFAULT_FALLBACK_URLS,
  ];
  const seen = new Set();
  return urls.filter((url) => {
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

/**
 * @param {Error|Object|null|undefined} err
 * @return {boolean}
 */
function isFailoverRpcError(err) {
  if (!err || err.code === "INVALID_ADDRESS") return false;
  const code = String(err.code || "");
  if (code === "SERVER_ERROR" || code === "TIMEOUT") return true;
  if (code === "NETWORK_ERROR") return true;
  const message = `${err.message || ""} ${err.shortMessage || ""}`;
  return /429|1015|rate limit|too many requests|exceeded maximum retry/i
      .test(message) ||
    /timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|bad response/i.test(message);
}

/**
 * One retry inside ethers, then the caller switches URL.
 * ethers otherwise retries HTTP 429 up to 12 times on the same host.
 * @param {string} rpcUrl
 * @param {number} chainId
 * @return {Object}
 */
function createThrottledProvider(rpcUrl, chainId) {
  const request = new ethers.FetchRequest(rpcUrl);
  request.timeout = 12000;
  request.setThrottleParams({maxAttempts: 2, slotInterval: 500});
  request.retryFunc = async () => false;
  return new ethers.JsonRpcProvider(request, chainId, {
    staticNetwork: true,
    batchMaxCount: 1,
  });
}

/**
 * @param {number} ms
 * @return {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  DEFAULT_FALLBACK_URLS,
  listAvalancheRpcUrls,
  isFailoverRpcError,
  createThrottledProvider,
  sleep,
};
