/**
 * @fileoverview P2P Listings business logic module
 * Pure business logic for fetching P2P listings from Binance
 */

const axios = require("axios");
const config = require("../config");

/**
 * Fetch P2P listings from Binance API
 * 
 * CRITICAL: The tradeType parameter MUST be forwarded exactly as received from the frontend.
 * The frontend makes two parallel calls:
 * - USA: tradeType: "SELL" (people selling USDT for USD) - to find where to BUY USDT
 * - Kenya: tradeType: "BUY" (people buying USDT with KES) - to find where to SELL USDT
 * Do NOT swap or modify the tradeType parameter - forward it directly to Binance.
 * 
 * @param {Object} params - Request parameters
 * @param {string} params.asset - Cryptocurrency asset code (e.g., "USDT", "BTC", "ETH")
 * @param {string} params.fiat - Fiat currency code (e.g., "KES", "USD", "EUR")
 * @param {boolean} params.merchantCheck - Whether to filter for verified merchants only
 * @param {number} params.page - Page number for pagination (default: 1)
 * @param {number} params.rows - Number of results per page (default: 20)
 * @param {string} params.tradeType - "BUY" or "SELL" (REQUIRED - must be forwarded exactly as received)
 * @param {Array<string>} [params.payTypes] - Optional array of payment method types
 * @returns {Promise<Object>} Binance API response
 */
async function fetchP2PListings(params) {
  // Extract parameters - tradeType has NO default value (it's required)
  const {
    asset = config.binance.defaultAsset,
    fiat = config.binance.defaultFiat,
    merchantCheck = false,
    page = 1,
    rows = 20,
    tradeType, // NO DEFAULT - must be provided exactly as received
    payTypes = [],
  } = params;

  // Validate required parameters
  if (!asset || !fiat || !tradeType) {
    throw new Error("Missing required parameters: asset, fiat, and tradeType are required");
  }

  // Validate tradeType value
  if (tradeType !== "BUY" && tradeType !== "SELL") {
    throw new Error("tradeType must be either 'BUY' or 'SELL'");
  }

  // Build request body for Binance API
  // CRITICAL: Forward tradeType exactly as received - do NOT modify or swap it
  const requestBody = {
    asset: asset,
    fiat: fiat,
    merchantCheck: merchantCheck,
    page: page,
    rows: rows,
    tradeType: tradeType, // Forwarded exactly as received from frontend
  };

  // Add payTypes if provided
  if (payTypes && payTypes.length > 0) {
    requestBody.payTypes = payTypes;
  }

  try {
    // Log the tradeType being forwarded for debugging
    console.log("Forwarding request to Binance P2P API:", {
      asset,
      fiat,
      tradeType, // Log to verify it's being forwarded correctly
      page,
      rows,
    });

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

    // CRITICAL FIX: Binance returns tradeType from advertiser's perspective,
    // but frontend expects the tradeType it requested. We need to normalize
    // the response so all adv.tradeType values match what was requested.
    if (response.data && response.data.data && Array.isArray(response.data.data)) {
      // Transform the response to set all tradeType values to match the request
      response.data.data = response.data.data.map((item) => {
        if (item.adv) {
          // Override the tradeType in the response to match what was requested
          item.adv.tradeType = tradeType;
        }
        return item;
      });

      // Log the transformation for debugging
      const responseTradeTypes = response.data.data
          .map((item) => item.adv?.tradeType)
          .filter((type) => type !== undefined);
      
      if (responseTradeTypes.length > 0) {
        const uniqueTradeTypes = [...new Set(responseTradeTypes)];
        console.log("Response normalized - tradeType set to requested value:", {
          requestedTradeType: tradeType,
          normalizedTradeTypes: uniqueTradeTypes,
          totalResults: response.data.data.length,
        });
      }
    }

    // Return the normalized Binance response
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

