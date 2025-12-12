/**
 * @fileoverview HTTP handlers for arbitrage endpoints
 * Thin controllers that delegate to business logic in libs/arbitrage.js
 */

const {onSchedule} = require("firebase-functions/v2/scheduler");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const config = require("../config");
const arbitrageLib = require("../libs/arbitrage");

/**
 * Scheduled function: Fetch arbitrage rates for multiple currency pairs
 */
exports.fetchArbitrageRates = onSchedule(
    {
      schedule: "0 0 * * *",
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
    },
    async () => {
      const fiatCurrencies = config.binance.supportedFiats; // ["KES", "NGN", "GHS"]
      const {results, errors} = await arbitrageLib.fetchMultipleArbitrageRates(fiatCurrencies);

      return null;
    },
);

/**
 * Callable function: Get arbitrage rates for a specific currency pair
 * @param {Object} request - Request with optional fiat
 */
exports.getArbitrageRates = onCall(
    {
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
    },
    async (request) => {
      try {
        const fiat = request.data?.fiat || config.binance.defaultFiat;
        return await arbitrageLib.getArbitrageRatesLogic(fiat);
      } catch (err) {
        console.error("Error in getArbitrageRates:", err.message);
        throw new HttpsError("internal", `Failed to fetch arbitrage rates: ${err.message}`);
      }
    },
);

