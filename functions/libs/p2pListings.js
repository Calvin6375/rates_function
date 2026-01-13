/**
 * @fileoverview P2P Listings business logic module
 * Pure business logic for fetching P2P listings from Binance
 */

const axios = require("axios");
const config = require("../config");

/**
 * Fetch P2P listings from Binance API
 * @param {Object} params - Request parameters
 * @param {string} params.asset - Cryptocurrency asset code (e.g., "USDT", "BTC", "ETH")
 * @param {string} params.fiat - Fiat currency code (e.g., "KES", "USD", "EUR")
 * @param {boolean} params.merchantCheck - Whether to filter for verified merchants only
 * @param {number} params.page - Page number for pagination (default: 1)
 * @param {number} params.rows - Number of results per page (default: 20)
 * @param {string} params.tradeType - "BUY" or "SELL"
 * @param {Array<string>} [params.payTypes] - Optional array of payment method types
 * @returns {Promise<Object>} Binance API response
 */
async function fetchP2PListings(params) {
  const {
    asset = config.binance.defaultAsset,
    fiat = config.binance.defaultFiat,
    merchantCheck = false,
    page = 1,
    rows = 20,
    tradeType = "BUY",
    payTypes = [],
  } = params;

  // Validate required parameters
  if (!asset || !fiat || !tradeType) {
    throw new Error("Missing required parameters: asset, fiat, and tradeType are required");
  }

  if (tradeType !== "BUY" && tradeType !== "SELL") {
    throw new Error("tradeType must be either 'BUY' or 'SELL'");
  }

  // Build request body for Binance API
  const requestBody = {
    asset: asset,
    fiat: fiat,
    merchantCheck: merchantCheck,
    page: page,
    rows: rows,
    tradeType: tradeType,
  };

  // Add payTypes if provided
  if (payTypes && payTypes.length > 0) {
    requestBody.payTypes = payTypes;
  }

  try {
    const response = await axios.post(
        config.binance.baseUrl,
        requestBody,
        {
          headers: {
            "Content-Type": "application/json",
          },
          timeout: 10000, // 10 second timeout
        },
    );

    // Check if response is successful
    if (response.status !== 200) {
      throw new Error(`Binance API returned status ${response.status}`);
    }

    // Return the Binance response directly
    return response.data;
  } catch (err) {
    // Enhanced error handling
    if (err.response) {
      // Binance API returned an error response
      const status = err.response.status;
      const statusText = err.response.statusText;

      if (status === 403) {
        throw new Error("Binance API blocked the request. This may be due to rate limiting or geographic restrictions.");
      } else if (status === 429) {
        throw new Error("Rate limit exceeded. Please try again in a moment.");
      } else if (status >= 500) {
        throw new Error(`Binance API server error: ${statusText}`);
      } else {
        throw new Error(`Binance API error: ${status} ${statusText}`);
      }
    } else if (err.request) {
      // Request was made but no response received
      if (err.code === "ETIMEDOUT" || err.code === "ECONNABORTED") {
        throw new Error("Request timeout. Binance API did not respond in time.");
      } else if (err.code === "ENOTFOUND" || err.code === "ECONNREFUSED") {
        throw new Error("Network error. Could not connect to Binance API.");
      } else {
        throw new Error(`Network error: ${err.message}`);
      }
    } else {
      // Error setting up the request
      throw new Error(`Request setup error: ${err.message}`);
    }
  }
}

module.exports = {
  fetchP2PListings,
};

