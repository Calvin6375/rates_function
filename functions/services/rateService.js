/**
 * @fileoverview Rate service: fetch USDT rates from Binance P2P with service fee applied.
 * Delegates to libs/rates.js for backward compatibility.
 */

const config = require("../config");
const ratesLib = require("../libs/rates");

/**
 * Get Binance P2P rates (with service fee). Uses existing logic and Firestore cache.
 *
 * @param {string} [fiat=config.binance.defaultFiat] - Fiat currency (KES, NGN, GHS)
 * @param {string} [asset=config.binance.defaultAsset] - Crypto asset (USDT)
 * @returns {Promise<Object>} Rate data including marketPrice, customerPrice, feePercentage, etc.
 */
async function getRates(fiat, asset) {
  const f = fiat || config.binance.defaultFiat;
  const a = asset || config.binance.defaultAsset;
  return ratesLib.getBinanceRatesLogic(f, a);
}

module.exports = {
  getRates,
};
