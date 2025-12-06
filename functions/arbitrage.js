const {onSchedule} = require("firebase-functions/v2/scheduler");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const admin = require("./admin");
const axios = require("axios");

const db = admin.firestore();
const rtdb = admin.database();

/**
 * Cache for fee configuration (per execution)
 */
let feeCache = null;

/**
 * Helper: Get arbitrage fee from Firestore config (cached per execution)
 */
async function getArbitrageFee() {
  if (feeCache !== null) {
    return feeCache;
  }

  try {
    const configSnap = await db.collection("config").doc("fees").get();
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
 * Fetch USD to USDT rate from Binance
 * @returns {Promise<number>} USD/USDT rate
 */
async function fetchUSDRate() {
  try {
    const response = await axios.post(
        "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search",
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
        "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search",
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
 * @returns {Promise<Object>} Arbitrage calculation results
 */
async function calculateArbitrage(fiat = "KES", usdAmount = 1000) {
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
    validUntil.setMinutes(validUntil.getMinutes() + 10);

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
 * Write arbitrage rates to both Firestore and RTDB atomically
 * @param {string} currencyPair - Currency pair identifier (e.g., "USD/KES")
 * @param {Object} arbitrageData - Arbitrage data to write
 */
async function writeArbitrageAtomically(currencyPair, arbitrageData) {
  const batch = db.batch();

  // Prepare Firestore document
  const firestoreDoc = {
    ...arbitrageData,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  // Write to Firestore
  const firestoreRef = db.collection("p2pRates").doc("arbitrage");
  batch.set(firestoreRef, firestoreDoc, {merge: true});

  // Prepare RTDB data (using ServerValue.TIMESTAMP)
  const validUntilMs = arbitrageData.validUntil.toMillis();
  const rtdbData = {
    usdRate: arbitrageData.usdRate,
    localRate: arbitrageData.localRate,
    usdAmount: arbitrageData.usdAmount,
    usdtBought: arbitrageData.usdtBought,
    localReceived: arbitrageData.localReceived,
    customerPayout: arbitrageData.customerPayout,
    profit: arbitrageData.profit,
    feePercentage: arbitrageData.feePercentage,
    currencyPair: arbitrageData.currencyPair,
    fiat: arbitrageData.fiat,
    updatedAt: admin.database.ServerValue.TIMESTAMP,
    validUntil: validUntilMs,
  };

  // Commit Firestore batch
  await batch.commit();

  // Write to RTDB
  const rtdbRef = rtdb.ref(`wallet/rates/arbitrage/${currencyPair}`);
  await rtdbRef.set(rtdbData);

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
    rtdb: "success",
    timestamp: new Date().toISOString(),
  }));
}

/**
 * Scheduled function: Fetch arbitrage rates for multiple currency pairs
 */
exports.fetchArbitrageRates = onSchedule(
    {
      schedule: "0 0 * * *",
      region: "us-central1",
      cpu: 0.25,
      memory: "256MiB",
    },
    async () => {
  // Reset fee cache for new execution
  feeCache = null;

  const fiatCurrencies = ["KES", "NGN", "GHS"]; // Add more as needed
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

  return null;
});

/**
 * Callable function: Get arbitrage rates for a specific currency pair
 * @param {Object} request - Request data with optional fiat
 */
exports.getArbitrageRates = onCall(
    {
      region: "us-central1",
      cpu: 0.25,
      memory: "256MiB",
    },
    async (request) => {
  try {
    const fiat = request.data?.fiat || "KES";
    const currencyPair = `USD/${fiat}`;

    // Reset fee cache for new execution
    feeCache = null;

    // Try to get from Firestore first
    const doc = await db.collection("p2pRates").doc("arbitrage").get();
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
  } catch (err) {
    console.error("Error in getArbitrageRates:", err.message);
    throw new HttpsError("internal", `Failed to fetch arbitrage rates: ${err.message}`);
  }
});
