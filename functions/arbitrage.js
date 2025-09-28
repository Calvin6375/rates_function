const {onSchedule} = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const axios = require("axios");

const db = admin.firestore();

/**
 * Helper: Get arbitrage fee from Firestore config
 */
async function getArbitrageFee() {
  try {
    const configSnap = await db.collection("config").doc("fees").get();
    if (configSnap.exists && configSnap.data().arbitrageFee) {
      return configSnap.data().arbitrageFee / 100; // convert to decimal
    }
  } catch (err) {
    console.error("Error fetching fee config:", err.message);
  }
  return 0.015; // fallback = 1.5%
}

/**
 * Arbitrage function (USD → USDT → KES)
 */

exports.fetchArbitrageRates = onSchedule("*/10 * * * *", async (event) => {
  try {
    // --- 1. Fetch US Market (USD → USDT)
    const usResponse = await axios.post(
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

    if (!usResponse.data.data || usResponse.data.data.length === 0) {
      throw new Error("No Binance USD offers found");
    }

    const usRate =
      parseFloat(usResponse.data.data[0].adv.price); // ~1.000 USD/USDT

    // --- 2. Fetch Kenya Market (KES → USDT)
    const keResponse = await axios.post(
        "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search",
        {
          asset: "USDT",
          fiat: "KES",
          tradeType: "SELL", // selling USDT for KES
          page: 1,
          rows: 5,
        },
        {headers: {"Content-Type": "application/json"}},
    );

    if (!keResponse.data.data || keResponse.data.data.length === 0) {
      throw new Error("No Binance KES offers found");
    }

    const keRate =
      parseFloat(keResponse.data.data[0].adv.price); // ~129 KES/USDT

    // --- 3. Arbitrage Calculation
    const usdAmount = 1000; // reference amount for calc
    const usdtBought = usdAmount / usRate;
    const kesReceived = usdtBought * keRate;

    // --- 4. Fetch fee from Firestore (or fallback)
    const feePercentage = await getArbitrageFee();

    const customerPayout = kesReceived * (1 - feePercentage);
    const profit = kesReceived - customerPayout;

    const arbitrageDoc = {
      usRate,
      keRate,
      usdAmount,
      usdtBought,
      kesReceived,
      feePercentage: feePercentage * 100,
      customerPayout,
      profit,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // --- 5. Save to Firestore
    await db.collection("p2pRates").doc("arbitrage").set(arbitrageDoc);

    console.log("Arbitrage updated:", arbitrageDoc);
    return null;
  } catch (err) {
    console.error("Error fetching arbitrage rates:", err.message);
    return null;
  }
});
