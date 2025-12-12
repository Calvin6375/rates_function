/**
 * @fileoverview HTTP handlers for rates endpoints
 * Thin controllers that delegate to business logic in libs/rates.js
 */

const {onSchedule} = require("firebase-functions/v2/scheduler");
const {onCall, onRequest, HttpsError} = require("firebase-functions/v2/https");
const config = require("../config");
const ratesLib = require("../libs/rates");

/**
 * Scheduled function: Fetch Binance P2P rates
 * Supports multiple currency pairs (KES, NGN, GHS, etc.)
 */
exports.fetchBinanceRates = onSchedule(
    {
      schedule: "0 0 * * *",
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
    },
    async () => {
      const currencyPairs = [
        {fiat: "KES", asset: "USDT"},
        {fiat: "NGN", asset: "USDT"},
        {fiat: "GHS", asset: "USDT"},
        // Add more pairs as needed
      ];

      const {results, errors} = await ratesLib.fetchMultipleRates(currencyPairs);

      return null;
    },
);

/**
 * Callable function: Get Binance rates for a specific currency pair
 * @param {Object} request - Request with optional fiat and asset
 */
exports.getBinanceRates = onCall(
    {
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
    },
    async (request) => {
      try {
        const fiat = request.data?.fiat || config.binance.defaultFiat;
        const asset = request.data?.asset || config.binance.defaultAsset;
        return await ratesLib.getBinanceRatesLogic(fiat, asset);
      } catch (err) {
        // Enhanced error logging with more context
        console.error("Error in getBinanceRates:", {
          error: err.message,
          stack: err.stack,
          fiat: request.data?.fiat || config.binance.defaultFiat,
          asset: request.data?.asset || config.binance.defaultAsset,
          errorType: err.constructor.name,
          response: err.response?.data,
          statusCode: err.response?.status,
        });

        // Provide more specific error messages
        let errorMessage = "Failed to fetch rates";
        
        if (err.message.includes("No Binance offers found")) {
          errorMessage = `No exchange rate available for ${request.data?.asset || config.binance.defaultAsset}/${request.data?.fiat || config.binance.defaultFiat}. Please try again later.`;
        } else if (err.response?.status === 429) {
          errorMessage = "Rate limit exceeded. Please try again in a moment.";
        } else if (err.code === "ENOTFOUND" || err.code === "ETIMEDOUT") {
          errorMessage = "Network error. Please check your connection and try again.";
        } else if (err.message) {
          errorMessage = `Failed to fetch rates: ${err.message}`;
        }

        throw new HttpsError("internal", errorMessage);
      }
    },
);

/**
 * HTTP endpoint: Get Binance rates with CORS support
 * GET /fetchBinanceRatesHttp?fiat=KES&asset=USDT
 */
exports.fetchBinanceRatesHttp = onRequest(
    {
      cors: true,
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
    },
    async (req, res) => {
      // Handle CORS preflight
      if (req.method === "OPTIONS") {
        res.set("Access-Control-Allow-Origin", "*");
        res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
        res.status(204).send("");
        return;
      }

      try {
        const fiat = req.query.fiat || req.body?.fiat || config.binance.defaultFiat;
        const asset = req.query.asset || req.body?.asset || config.binance.defaultAsset;

        const result = await ratesLib.getBinanceRatesLogic(fiat, asset);

        // Set CORS headers
        res.set("Access-Control-Allow-Origin", "*");
        res.set("Content-Type", "application/json");
        res.status(200).json(result);
      } catch (err) {
        console.error("Error in fetchBinanceRates HTTP endpoint:", err.message);
        res.set("Access-Control-Allow-Origin", "*");
        res.status(500).json({
          error: "internal",
          message: `Failed to fetch rates: ${err.message}`,
        });
      }
    },
);

