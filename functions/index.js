// eslint-disable-next-line no-unused-vars
const functions = require("firebase-functions");
const admin = require("./admin");

// Import modules
const rates = require("./rates"); // your existing fetchBinanceRates
const arbitrage = require("./arbitrage"); // new arbitrage functions
const payments = require("./payments");

// Export them
exports.fetchBinanceRates = rates.fetchBinanceRates; // Scheduled function
exports.fetchBinanceRatesHttp = rates.fetchBinanceRatesHttp; // HTTP endpoint with CORS
exports.getBinanceRates = rates.getBinanceRates; // Callable function
exports.fetchArbitrageRates = arbitrage.fetchArbitrageRates;
exports.getArbitrageRates = arbitrage.getArbitrageRates;
exports.handleTopUpWebhook = payments.handleTopUpWebhook;
