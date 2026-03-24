/**
 * @fileoverview Rate updater job: fetch Binance P2P rates, store in Firestore, optionally cache in Realtime DB.
 * Can be invoked by the existing scheduled function (ratesHttp.fetchBinanceRates) or run on demand.
 */

const config = require("../config");
const rateService = require("../services/rateService");

/**
 * Run the rate updater: fetch rates for configured pairs and optionally cache to RTDB.
 *
 * @param {Array<{fiat: string, asset: string}>} [currencyPairs] - Defaults to config.binance.supportedFiats × USDT
 * @param {boolean} [cacheToRealtime=true] - Whether to write latest rate to Realtime DB for frontend
 * @returns {Promise<{ results: Array, errors: Array }>}
 */
async function runRateUpdater(currencyPairs, cacheToRealtime = true) {
  const pairs = currencyPairs || config.binance.supportedFiats.map((fiat) => ({
    fiat,
    asset: config.binance.defaultAsset,
  }));
  const { results, errors } = await rateService.fetchAndStoreRates(pairs);
  if (cacheToRealtime && results.length > 0) {
    try {
      await rateService.cacheRatesToRealtime();
    } catch (e) {
      console.warn("rateUpdater: cache to Realtime DB failed (non-fatal):", e.message);
    }
  }
  return { results, errors };
}

module.exports = {
  runRateUpdater,
};
