/**
 * @fileoverview Arbitrage business logic module
 * Pure business logic for calculating arbitrage rates
 * @typedef {Object} ArbitrageData
 * @property {number} usdRate - USD/USDT rate
 * @property {number} localRate - Local fiat/USDT rate
 * @property {number} usdAmount - Reference USD amount
 * @property {number} usdtBought - USDT bought with USD
 * @property {number} localReceived - Local fiat received
 * @property {number} feePercentage - Fee percentage
 * @property {number} customerPayout - Customer payout after fee
 * @property {number} profit - Profit amount
 * @property {string} currencyPair - Currency pair identifier
 * @property {string} fiat - Fiat currency
 * @property {admin.firestore.Timestamp} validUntil - Expiration timestamp
 */

const admin = require("../admin");
const axios = require("axios");
const config = require("../config");

const db = admin.firestore();

/**
 * Cache for fee configuration (per execution)
 * @type {number|null}
 */
let feeCache = null;

/**
 * Get arbitrage fee from Firestore config (cached per execution)
 * @returns {Promise<number>} Arbitrage fee as decimal (e.g., 0.015 for 1.5%)
 */
async function getArbitrageFee() {
  if (feeCache !== null) {
    return feeCache;
  }

  try {
    const configSnap = await db.collection(config.collections.config).doc("fees").get();
    if (configSnap.exists && configSnap.data().arbitrageFee) {
      feeCache = configSnap.data().arbitrageFee / 100; // convert to decimal
      return feeCache;
    }
  } catch (err) {
    console.error("Error fetching arbitrage fee config:", err.message);
  }
  feeCache = 0.015; // fallback = 1.5%
  return feeCache;
}

/**
 * Reset fee cache (call before new execution)
 */
function resetFeeCache() {
  feeCache = null;
}

/**
 * Fetch USD to USDT rate from Binance
 * @returns {Promise<number>} USD/USDT rate
 */
async function fetchUSDRate() {
  try {
    const response = await axios.post(
        config.binance.baseUrl,
        {
          asset: "USDT",
          fiat: "USD",
          tradeType: "BUY",
          page: 1,
          rows: 5,
        },
        {headers: {"Content-Type": "application/json"}},
    );

    if (!response.data.data || response.data.data.length === 0) {
      throw new Error("No Binance USD offers found");
    }

    return parseFloat(response.data.data[0].adv.price);
  } catch (err) {
    console.error("Error fetching USD rate:", err.message);
    throw err;
  }
}

/**
 * Fetch local fiat to USDT rate from Binance
 * @param {string} fiat - Fiat currency code (KES, NGN, GHS, etc.)
 * @returns {Promise<number>} Local fiat/USDT rate
 */
async function fetchLocalRate(fiat) {
  try {
    const response = await axios.post(
        config.binance.baseUrl,
        {
          asset: "USDT",
          fiat: fiat,
          tradeType: "SELL", // selling USDT for local fiat
          page: 1,
          rows: 5,
        },
        {headers: {"Content-Type": "application/json"}},
    );

    if (!response.data.data || response.data.data.length === 0) {
      throw new Error(`No Binance ${fiat} offers found`);
    }

    return parseFloat(response.data.data[0].adv.price);
  } catch (err) {
    console.error(`Error fetching ${fiat} rate:`, err.message);
    throw err;
  }
}

/**
 * Calculate arbitrage for a specific currency pair
 * @param {string} fiat - Fiat currency code (KES, NGN, GHS, etc.)
 * @param {number} usdAmount - Reference USD amount (default: 1000)
 * @returns {Promise<ArbitrageData>} Arbitrage calculation results
 */
async function calculateArbitrage(fiat = config.binance.defaultFiat, usdAmount = 1000) {
  try {
    // Fetch rates
    const usdRate = await fetchUSDRate(); // USD/USDT rate
    const localRate = await fetchLocalRate(fiat); // Local fiat/USDT rate

    // Calculate arbitrage
    const usdtBought = usdAmount / usdRate;
    const localReceived = usdtBought * localRate;

    // Get fee percentage
    const feePercentage = await getArbitrageFee();
    const customerPayout = localReceived * (1 - feePercentage);
    const profit = localReceived - customerPayout;

    // Calculate validUntil (10 minutes from now, matching schedule)
    const validUntil = new Date();
    validUntil.setMinutes(validUntil.getMinutes() + config.rates.arbitrageCacheValidityMinutes);

    return {
      usdRate,
      localRate,
      usdAmount,
      usdtBought,
      localReceived,
      feePercentage: feePercentage * 100,
      customerPayout,
      profit,
      currencyPair: `USD/${fiat}`,
      fiat,
      validUntil: admin.firestore.Timestamp.fromDate(validUntil),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
  } catch (err) {
    console.error(`Error calculating arbitrage for ${fiat}:`, err.message);
    throw err;
  }
}

/**
 * Write arbitrage rates to Firestore (singleton document)
 * @param {string} currencyPair - Currency pair identifier (e.g., "USD/KES")
 * @param {ArbitrageData} arbitrageData - Arbitrage data to write
 * @returns {Promise<void>}
 */
async function writeArbitrageAtomically(currencyPair, arbitrageData) {
  // Prepare Firestore document
  const firestoreDoc = {
    ...arbitrageData,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  // Write to Firestore singleton document
  // Clients should listen to: /p2pRates/arbitrage
  const firestoreRef = db.collection(config.collections.p2pRates).doc("arbitrage");
  await firestoreRef.set(firestoreDoc, {merge: true});

  // Structured logging
  console.log(JSON.stringify({
    event: "arbitrage_updated",
    source: "binance",
    currencyPair: currencyPair,
    usdRate: arbitrageData.usdRate,
    localRate: arbitrageData.localRate,
    customerPayout: arbitrageData.customerPayout,
    profit: arbitrageData.profit,
    feePercentage: arbitrageData.feePercentage,
    firestore: "success",
    timestamp: new Date().toISOString(),
  }));
}

/**
 * Get arbitrage rates logic (shared by scheduled and callable functions)
 * @param {string} fiat - Fiat currency code
 * @returns {Promise<ArbitrageData & {source: string}>} Arbitrage data with source indicator
 */
async function getArbitrageRatesLogic(fiat = config.binance.defaultFiat) {
  const currencyPair = `USD/${fiat}`;

  // Reset fee cache for new execution
  resetFeeCache();

  // Try to get from Firestore first
  const doc = await db.collection(config.collections.p2pRates).doc("arbitrage").get();
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
  const arbitrageData = await calculateArbitrage(fiat);
  await writeArbitrageAtomically(currencyPair, arbitrageData);

  return {
    ...arbitrageData,
    source: "fresh",
  };
}

/**
 * Fetch arbitrage rates for multiple currency pairs (for scheduled function)
 * @param {Array<string>} fiatCurrencies - Array of fiat currency codes
 * @returns {Promise<{results: Array, errors: Array}>} Results and errors
 */
async function fetchMultipleArbitrageRates(fiatCurrencies) {
  resetFeeCache();

  const results = [];
  const errors = [];

  for (const fiat of fiatCurrencies) {
    try {
      const arbitrageData = await calculateArbitrage(fiat);
      const currencyPair = `USD/${fiat}`;
      await writeArbitrageAtomically(currencyPair, arbitrageData);
      results.push({currencyPair, status: "success"});
    } catch (err) {
      const currencyPair = `USD/${fiat}`;
      errors.push({currencyPair, error: err.message});

      // Structured error logging
      console.error(JSON.stringify({
        event: "arbitrage_update_failed",
        source: "binance",
        currencyPair: currencyPair,
        error: err.message,
        timestamp: new Date().toISOString(),
      }));
    }
  }

  // Summary log
  console.log(JSON.stringify({
    event: "arbitrage_batch_complete",
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
  getArbitrageFee,
  resetFeeCache,
  fetchUSDRate,
  fetchLocalRate,
  calculateArbitrage,
  writeArbitrageAtomically,
  getArbitrageRatesLogic,
  fetchMultipleArbitrageRates,
};

