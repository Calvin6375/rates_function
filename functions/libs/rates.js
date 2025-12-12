/**
 * @fileoverview Rates business logic module
 * Pure business logic for fetching and managing Binance P2P exchange rates
 * @typedef {Object} RateData
 * @property {number} marketPrice - Market price from Binance
 * @property {number} customerPrice - Customer price (with fee)
 * @property {number} feePercentage - Fee percentage
 * @property {string} currencyPair - Currency pair identifier
 * @property {string} asset - Crypto asset
 * @property {string} fiat - Fiat currency
 * @property {admin.firestore.Timestamp} validUntil - Expiration timestamp
 */

const admin = require("../admin");
const axios = require("axios");
const config = require("../config");

const db = admin.firestore();
const rtdb = admin.database();

/**
 * Cache for fee configuration (per execution)
 * @type {number|null}
 */
let feeCache = null;

/**
 * Get service fee from Firestore config (cached per execution)
 * @returns {Promise<number>} Service fee as decimal (e.g., 0.015 for 1.5%)
 */
async function getServiceFee() {
  if (feeCache !== null) {
    return feeCache;
  }

  try {
    const configSnap = await db.collection(config.collections.config).doc("fees").get();
    if (configSnap.exists && configSnap.data().serviceFee) {
      feeCache = configSnap.data().serviceFee / 100;
      return feeCache;
    }
  } catch (err) {
    console.error("Error fetching service fee config:", err.message);
  }
  feeCache = 0.015; // fallback 1.5%
  return feeCache;
}

/**
 * Reset fee cache (call before new execution)
 */
function resetFeeCache() {
  feeCache = null;
}

/**
 * Fetch Binance P2P rates for a specific currency pair
 * @param {string} fiat - Fiat currency code (KES, NGN, GHS, etc.)
 * @param {string} asset - Crypto asset (default: USDT)
 * @returns {Promise<RateData>} Rate data
 */
async function fetchBinanceRateData(fiat = config.binance.defaultFiat, asset = config.binance.defaultAsset) {
  try {
    const response = await axios.post(
        config.binance.baseUrl,
        {
          asset: asset,
          fiat: fiat,
          tradeType: "BUY",
          page: 1,
          rows: 10,
        },
        {headers: {"Content-Type": "application/json"}},
    );

    if (!response.data.data || response.data.data.length === 0) {
      throw new Error(`No Binance offers found for ${asset}/${fiat}`);
    }

    const marketPrice = parseFloat(response.data.data[0].adv.price);
    const feePercentage = await getServiceFee();
    const customerPrice = marketPrice * (1 + feePercentage);

    // Calculate validUntil (5 minutes from now)
    const validUntil = new Date();
    validUntil.setMinutes(validUntil.getMinutes() + config.rates.cacheValidityMinutes);

    return {
      marketPrice,
      customerPrice,
      feePercentage: feePercentage * 100,
      currencyPair: `${asset}/${fiat}`,
      asset,
      fiat,
      validUntil: admin.firestore.Timestamp.fromDate(validUntil),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
  } catch (err) {
    console.error(`Error fetching Binance rates for ${asset}/${fiat}:`, err.message);
    throw err;
  }
}

/**
 * Write rates to both Firestore and RTDB atomically
 * @param {string} currencyPair - Currency pair identifier (e.g., "USDT/KES")
 * @param {RateData} ratesData - Rate data to write
 * @returns {Promise<void>}
 */
async function writeRatesAtomically(currencyPair, ratesData) {
  const batch = db.batch();
  const now = Date.now();

  // Prepare Firestore document
  const firestoreDoc = {
    ...ratesData,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  // Write to Firestore
  const firestoreRef = db.collection(config.collections.p2pRates).doc("binance");
  batch.set(firestoreRef, firestoreDoc, {merge: true});

  // Prepare RTDB data (using ServerValue.TIMESTAMP)
  const validUntilMs = ratesData.validUntil.toMillis();
  const rtdbData = {
    customerPrice: ratesData.customerPrice,
    marketPrice: ratesData.marketPrice,
    feePercentage: ratesData.feePercentage,
    currencyPair: ratesData.currencyPair,
    asset: ratesData.asset,
    fiat: ratesData.fiat,
    updatedAt: admin.database.ServerValue.TIMESTAMP,
    validUntil: validUntilMs,
  };

  // Commit Firestore batch
  await batch.commit();

  // Write to RTDB
  const rtdbRef = rtdb.ref(`${config.rtdbPaths.rates}/binance/${currencyPair}`);
  await rtdbRef.set(rtdbData);

  // Structured logging
  console.log(JSON.stringify({
    event: "rates_updated",
    source: "binance",
    currencyPair: currencyPair,
    customerPrice: ratesData.customerPrice,
    marketPrice: ratesData.marketPrice,
    feePercentage: ratesData.feePercentage,
    firestore: "success",
    rtdb: "success",
    timestamp: new Date().toISOString(),
  }));
}

/**
 * Get Binance rates logic (shared by scheduled, callable, and HTTP functions)
 * @param {string} fiat - Fiat currency code
 * @param {string} asset - Crypto asset
 * @returns {Promise<RateData & {source: string}>} Rate data with source indicator
 */
async function getBinanceRatesLogic(fiat = config.binance.defaultFiat, asset = config.binance.defaultAsset) {
  const currencyPair = `${asset}/${fiat}`;

  // Reset fee cache for new execution
  resetFeeCache();

  // Try to get from Firestore first
  const doc = await db.collection(config.collections.p2pRates).doc("binance").get();
  if (doc.exists) {
    const data = doc.data();
    // Check if we have data for this currency pair
    if (data.currencyPair === currencyPair || data.fiat === fiat) {
      // Check if still valid
      if (data.validUntil && data.validUntil.toMillis() > Date.now()) {
        return {
          ...data,
          source: "firestore",
        };
      }
    }
  }

  // If not found or expired, fetch fresh data
  const ratesData = await fetchBinanceRateData(fiat, asset);
  await writeRatesAtomically(currencyPair, ratesData);

  return {
    ...ratesData,
    source: "fresh",
  };
}

/**
 * Fetch rates for multiple currency pairs (for scheduled function)
 * @param {Array<{fiat: string, asset: string}>} currencyPairs - Array of currency pairs
 * @returns {Promise<{results: Array, errors: Array}>} Results and errors
 */
async function fetchMultipleRates(currencyPairs) {
  resetFeeCache();

  const results = [];
  const errors = [];

  for (const pair of currencyPairs) {
    try {
      const ratesData = await fetchBinanceRateData(pair.fiat, pair.asset);
      const currencyPair = `${pair.asset}/${pair.fiat}`;
      await writeRatesAtomically(currencyPair, ratesData);
      results.push({currencyPair, status: "success"});
    } catch (err) {
      const currencyPair = `${pair.asset}/${pair.fiat}`;
      errors.push({currencyPair, error: err.message});

      // Structured error logging
      console.error(JSON.stringify({
        event: "rates_update_failed",
        source: "binance",
        currencyPair: currencyPair,
        error: err.message,
        timestamp: new Date().toISOString(),
      }));
    }
  }

  // Summary log
  console.log(JSON.stringify({
    event: "rates_batch_complete",
    source: "binance",
    successful: results.length,
    failed: errors.length,
    results: results,
    errors: errors,
    timestamp: new Date().toISOString(),
  }));

  return {results, errors};
}

module.exports = {
  getServiceFee,
  resetFeeCache,
  fetchBinanceRateData,
  writeRatesAtomically,
  getBinanceRatesLogic,
  fetchMultipleRates,
};

