/**
 * @fileoverview Rate service: fetch USDT rates from Binance P2P, apply fee, cache in Firestore and Realtime DB.
 * Delegates to existing libs/rates.js for backward compatibility; adds optional RTDB cache for frontend.
 */

const config = require("../config");
const ratesLib = require("../libs/rates");
const { ref } = require("../libs/realtime");

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

/**
 * Fetch fresh rates from Binance and write to Firestore (p2pRates/binance).
 * Used by scheduled job or HTTP trigger.
 *
 * @param {Array<{fiat: string, asset: string}>} [currencyPairs] - Defaults to supported fiats × USDT
 * @returns {Promise<{ results: Array, errors: Array }>}
 */
async function fetchAndStoreRates(currencyPairs) {
  const pairs = currencyPairs || config.binance.supportedFiats.map((fiat) => ({ fiat, asset: config.binance.defaultAsset }));
  return ratesLib.fetchMultipleRates(pairs);
}

/**
 * Get service fee (from config/fees or default).
 *
 * @returns {Promise<number>} Fee as decimal (e.g. 0.015)
 */
async function getServiceFee() {
  return ratesLib.getServiceFee();
}

/**
 * Cache current Firestore rates to Realtime DB at wallet/rates for frontend.
 * Call after fetchAndStoreRates if you want RTDB to have latest.
 *
 * @param {Object} [rateData] - If provided, write this; otherwise read from Firestore and write
 */
async function cacheRatesToRealtime(rateData) {
  const admin = require("../admin");
  const db = admin.firestore();
  const data = rateData || (await db.collection(config.collections.p2pRates).doc("binance").get()).data();
  if (!data) return;
  const r = ref("wallet/rates");
  await r.set({
    binance: {
      marketPrice: data.marketPrice,
      customerPrice: data.customerPrice,
      feePercentage: data.feePercentage,
      currencyPair: data.currencyPair,
      asset: data.asset,
      fiat: data.fiat,
      validUntil: data.validUntil?.toMillis?.() ?? null,
      updatedAt: data.updatedAt?.toMillis?.() ?? null,
    },
  });
}

module.exports = {
  getRates,
  fetchAndStoreRates,
  getServiceFee,
  cacheRatesToRealtime,
};
