const {onSchedule} = require("firebase-functions/v2/scheduler");
const {onCall, onRequest, HttpsError} = require("firebase-functions/v2/https");
const admin = require("./admin");
const axios = require("axios");

const db = admin.firestore();
const rtdb = admin.database();

/**
 * Cache for fee configuration (per execution)
 */
let feeCache = null;

/**
 * Helper: Get service fee from Firestore config (cached per execution)
 */
async function getServiceFee() {
  if (feeCache !== null) {
    return feeCache;
  }

  try {
    const configSnap = await db.collection("config").doc("fees").get();
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
 * Fetch Binance P2P rates for a specific currency pair
 * @param {string} fiat - Fiat currency code (KES, NGN, GHS, etc.)
 * @param {string} asset - Crypto asset (default: USDT)
 * @returns {Promise<Object>} Rate data
 */
async function fetchBinanceRateData(fiat = "KES", asset = "USDT") {
  try {
    const response = await axios.post(
        "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search",
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
    validUntil.setMinutes(validUntil.getMinutes() + 5);

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
 * @param {Object} ratesData - Rate data to write
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
  const firestoreRef = db.collection("p2pRates").doc("binance");
  batch.set(firestoreRef, firestoreDoc, {merge: true});

  // Prepare RTDB data (using ServerValue.TIMESTAMP)
  const validUntilMs = now + (5 * 60 * 1000); // 5 minutes from now
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
  const rtdbRef = rtdb.ref(`wallet/rates/binance/${currencyPair}`);
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
 * Scheduled function: Fetch Binance P2P rates
 * Supports multiple currency pairs (KES, NGN, GHS, etc.)
 */
exports.fetchBinanceRates = onSchedule("0 0 * * *", async () => {
  // Reset fee cache for new execution
  feeCache = null;

  const currencyPairs = [
    {fiat: "KES", asset: "USDT"},
    {fiat: "NGN", asset: "USDT"},
    {fiat: "GHS", asset: "USDT"},
    // Add more pairs as needed
  ];

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

  return null;
});

/**
 * Shared logic for getting Binance rates
 * @param {string} fiat - Fiat currency code
 * @param {string} asset - Crypto asset
 * @returns {Promise<Object>} Rate data
 */
async function getBinanceRatesLogic(fiat = "KES", asset = "USDT") {
  const currencyPair = `${asset}/${fiat}`;

  // Reset fee cache for new execution
  feeCache = null;

  // Try to get from Firestore first
  const doc = await db.collection("p2pRates").doc("binance").get();
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
 * Callable function: Get Binance rates for a specific currency pair
 * @param {Object} data - Request data with optional fiat and asset
 * @param {Object} context - Call context
 */
exports.getBinanceRates = onCall(async (request) => {
  try {
    const fiat = request.data?.fiat || "KES";
    const asset = request.data?.asset || "USDT";
    return await getBinanceRatesLogic(fiat, asset);
  } catch (err) {
    console.error("Error in getBinanceRates:", err.message);
    throw new HttpsError("internal", `Failed to fetch rates: ${err.message}`);
  }
});

/**
 * HTTP endpoint: Get Binance rates with CORS support
 * GET /fetchBinanceRatesHttp?fiat=KES&asset=USDT
 */
exports.fetchBinanceRatesHttp = onRequest(
    {
      cors: true,
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
        const fiat = req.query.fiat || req.body?.fiat || "KES";
        const asset = req.query.asset || req.body?.asset || "USDT";

        const result = await getBinanceRatesLogic(fiat, asset);

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
