// eslint-disable-next-line no-unused-vars
const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();

// Import modules
const rates = require("./rates"); // your existing fetchBinanceRates
const arbitrage = require("./arbitrage"); // new arbitrage functions

// Export them
exports.fetchBinanceRates = rates.fetchBinanceRates;
exports.getBinanceRates = rates.getBinanceRates;
exports.fetchArbitrageRates = arbitrage.fetchArbitrageRates;
