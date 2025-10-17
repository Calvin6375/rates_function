const {onSchedule} = require("firebase-functions/v2/scheduler");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const admin = require("./admin");
const axios = require("axios");

const db = admin.firestore();

/**
 * Helper: Get service fee from Firestore config
 */
async function getServiceFee() {
  try {
    const configSnap = await db.collection("config").doc("fees").get();
    if (configSnap.exists && configSnap.data().serviceFee) {
      return configSnap.data().serviceFee / 100;
    }
  } catch (err) {
    console.error("Error fetching service fee config:", err.message);
  }
  return 0.015; // fallback
}

/**
 * Fetch Binance KES rates with service fee applied
 */
exports.fetchBinanceRates = onSchedule("*/5 * * * *", async () => {
  try {
    const response = await axios.post(
        // eslint-disable-next-line indent
      "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search",
        {
          asset: "USDT",
          fiat: "KES",
          tradeType: "BUY",
          page: 1,
          rows: 10,
        },
        {headers: {"Content-Type": "application/json"}},
    );

    if (!response.data.data || response.data.data.length === 0) {
      throw new Error("No Binance offers found");
    }

    const marketPrice = parseFloat(response.data.data[0].adv.price);
    const feePercentage = await getServiceFee();
    const customerPrice = marketPrice * (1 + feePercentage);

    const ratesDoc = {
      marketPrice,
      customerPrice,
      feePercentage: feePercentage * 100,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.collection("p2pRates").doc("binance").set(ratesDoc);

    console.log("Rates updated:", ratesDoc);
    return null;
  } catch (err) {
    console.error("Error fetching Binance rates:", err.message);
    return null;
  }
});

exports.getBinanceRates = onCall(async () => {
  try {
    const doc = await db.collection("p2pRates").doc("binance").get();
    if (!doc.exists) {
      throw new HttpsError(
          "not-found",
          "Rates not available yet");
    }
    return doc.data();
  } catch (err) {
    console.error("Error getting rates:", err.message);
    throw new HttpsError("internal", "Failed to fetch rates");
  }
});
