// eslint-disable-next-line no-unused-vars
const functions = require("firebase-functions");
const admin = require("./admin");

// Import modules
const rates = require("./rates"); // your existing fetchBinanceRates
const arbitrage = require("./arbitrage"); // new arbitrage functions
const payments = require("./payments");
const customerWallets = require("./customerWallets"); // customer wallets API
const users = require("./users"); // user triggers
const migrateUsers = require("./migrateUsers"); // user migration functions
const updatePhoneNumbers = require("./updatePhoneNumbers"); // phone number update functions

// Import new architecture modules
const userBootstrap = require("./userBootstrap"); // Auth onCreate trigger
const balanceSync = require("./balanceSync"); // Firestore onUpdate trigger for balance sync
const adminActions = require("./adminActions"); // Admin dashboard functions

// Export existing functions
exports.fetchBinanceRates = rates.fetchBinanceRates; // Scheduled function
exports.fetchBinanceRatesHttp = rates.fetchBinanceRatesHttp; // HTTP endpoint with CORS
exports.getBinanceRates = rates.getBinanceRates; // Callable function
exports.fetchArbitrageRates = arbitrage.fetchArbitrageRates;
exports.getArbitrageRates = arbitrage.getArbitrageRates;
exports.handleTopUpWebhook = payments.handleTopUpWebhook;
exports.createPayment = payments.createPayment; // Callable function to create payment order
exports.api = customerWallets.api; // Customer wallets REST API
exports.onUserCreated = users.onUserCreated; // Firestore trigger for user creation
exports.migrateExistingUsers = migrateUsers.migrateExistingUsers; // Callable function to migrate existing users
exports.migrateUsersHttp = migrateUsers.migrateUsersHttp; // HTTP endpoint to migrate existing users
exports.updatePhoneNumbers = updatePhoneNumbers.updatePhoneNumbers; // Callable function to update phone numbers only
exports.updatePhoneNumbersHttp = updatePhoneNumbers.updatePhoneNumbersHttp; // HTTP endpoint to update phone numbers only

// Export new architecture functions
exports.userBootstrap = userBootstrap.userBootstrap; // Auth onCreate - creates user in Firestore + Realtime DB
exports.syncBalance = balanceSync.syncBalance; // Firestore onUpdate - syncs balance to Realtime DB

// Export admin functions
exports.updateUserProfile = adminActions.updateUserProfile; // Admin: Update user profile
exports.updateUserBalance = adminActions.updateUserBalance; // Admin: Update user balance
exports.getUserData = adminActions.getUserData; // Admin: Get user data
exports.updateKYCStatus = adminActions.updateKYCStatus; // Admin: Update KYC status
exports.syncUserBalanceToRealtime = adminActions.syncUserBalanceToRealtime; // Admin: Manually sync balance to Realtime DB
exports.getCommissionConfig = adminActions.getCommissionConfig; // Admin: Get commission configuration
exports.updateCommissionConfig = adminActions.updateCommissionConfig; // Admin: Update commission configuration
exports.getIntaSendPaymentStatus = adminActions.getIntaSendPaymentStatus; // Admin: Get IntaSend payment status by invoice_id
