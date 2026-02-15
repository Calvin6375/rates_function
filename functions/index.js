/**
 * @fileoverview Main entry point for Firebase Cloud Functions
 * Exports all functions - no business logic here, only exports
 */

// Import HTTP handlers
const ratesHttp = require("./http/ratesHttp");
const arbitrageHttp = require("./http/arbitrageHttp");
const paymentsHttp = require("./http/paymentsHttp");
const customerWalletsHttp = require("./http/customerWalletsHttp");
const adminHttp = require("./http/adminHttp");
const migrateUsersHttp = require("./http/migrateUsersHttp");
const updatePhoneNumbersHttp = require("./http/updatePhoneNumbersHttp");
const transactionsHttp = require("./http/transactionsHttp");
const notificationsHttp = require("./http/notificationsHttp");

// Import triggers
const usersTrigger = require("./triggers/usersTrigger");
const userBootstrap = require("./triggers/userBootstrap");

// Export rates functions
exports.fetchBinanceRates = ratesHttp.fetchBinanceRates;
exports.fetchBinanceRatesHttp = ratesHttp.fetchBinanceRatesHttp;
exports.getBinanceRates = ratesHttp.getBinanceRates;

// Export arbitrage functions
exports.fetchArbitrageRates = arbitrageHttp.fetchArbitrageRates;
exports.getArbitrageRates = arbitrageHttp.getArbitrageRates;

// Export payment functions
exports.handleTopUpWebhook = paymentsHttp.handleTopUpWebhook;
exports.createPayment = paymentsHttp.createPayment;
exports.handlePaymentWebhook = paymentsHttp.handlePaymentWebhook;
exports.createSwapOrder = paymentsHttp.createSwapOrder;
exports.createSendMoneyOrder = paymentsHttp.createSendMoneyOrder;

// Export customer wallets REST API
exports.api = customerWalletsHttp.api;

// Export transactions REST API
exports.transactionsApi = transactionsHttp.transactionsApi;

// Export notifications REST API
exports.notificationsApi = notificationsHttp.notificationsApi;

// Export user triggers
exports.onUserCreated = usersTrigger.onUserCreated;
exports.userBootstrap = userBootstrap.userBootstrap;

// Export migration functions
exports.migrateExistingUsers = migrateUsersHttp.migrateExistingUsers;
exports.migrateUsersHttp = migrateUsersHttp.migrateUsersHttp;
exports.updatePhoneNumbers = updatePhoneNumbersHttp.updatePhoneNumbers;
exports.updatePhoneNumbersHttp = updatePhoneNumbersHttp.updatePhoneNumbersHttp;

// Import admin claims handlers
const adminClaimsHttp = require("./http/adminClaimsHttp");

// Export admin functions
exports.updateUserProfile = adminHttp.updateUserProfile;
exports.updateUserBalance = adminHttp.updateUserBalance;
exports.getUserData = adminHttp.getUserData;
exports.updateKYCStatus = adminHttp.updateKYCStatus;
exports.syncUserBalanceToRealtime = adminHttp.syncUserBalanceToRealtime; // Deprecated but kept for compatibility
exports.getCommissionConfig = adminHttp.getCommissionConfig;
exports.updateCommissionConfig = adminHttp.updateCommissionConfig;
exports.getIntaSendPaymentStatus = adminHttp.getIntaSendPaymentStatus;

// Export admin claims management functions
exports.setAdminClaim = adminClaimsHttp.setAdminClaim;
exports.removeAdminClaim = adminClaimsHttp.removeAdminClaim;
