/**
 * @fileoverview Main entry point for Firebase Cloud Functions
 * Exports all functions - no business logic here, only exports
 */

// Import HTTP handlers
const ratesHttp = require("./http/ratesHttp");
const arbitrageHttp = require("./http/arbitrageHttp");
const paymentsHttp = require("./http/paymentsHttp");
const webhookApi = require("./http/webhookApi");
const partnerApi = require("./http/partnerApi");
const partnerSandboxHttp = require("./http/partnerSandboxHttp");
const customerWalletsHttp = require("./http/customerWalletsHttp");
const adminHttp = require("./http/adminHttp");
const migrateUsersHttp = require("./http/migrateUsersHttp");
const updatePhoneNumbersHttp = require("./http/updatePhoneNumbersHttp");
const transactionsHttp = require("./http/transactionsHttp");
const notificationsHttp = require("./http/notificationsHttp");
const b2bPortalHttp = require("./http/b2bPortalHttp");
const customerAuthHttp = require("./http/customerAuthHttp");

// Import triggers
const usersTrigger = require("./triggers/usersTrigger");
const userBootstrap = require("./triggers/userBootstrap");
const authUserCleanup = require("./triggers/authUserCleanup");

// Export rates functions
exports.fetchBinanceRates = ratesHttp.fetchBinanceRates;
exports.fetchBinanceRatesHttp = ratesHttp.fetchBinanceRatesHttp;
exports.getBinanceRates = ratesHttp.getBinanceRates;

// Export arbitrage functions
exports.fetchArbitrageRates = arbitrageHttp.fetchArbitrageRates;
exports.getArbitrageRates = arbitrageHttp.getArbitrageRates;

// Export payment functions (callables: paymentsHttp; webhooks: webhookApi)
exports.handleTopUpWebhook = webhookApi.handleTopUpWebhook;
exports.handleTransFiTopUpWebhook = webhookApi.handleTransFiTopUpWebhook;
exports.createPayment = paymentsHttp.createPayment;
exports.createDirectTopup = paymentsHttp.createDirectTopup;
exports.createDirectPayout = paymentsHttp.createDirectPayout;
exports.handlePaymentWebhook = paymentsHttp.handlePaymentWebhook;
exports.createSwapOrder = paymentsHttp.createSwapOrder;
exports.createSendMoneyOrder = paymentsHttp.createSendMoneyOrder;

// Export customer wallets REST API
exports.api = customerWalletsHttp.api;

// Export B2B Partner API (X-API-KEY auth)
exports.partner = partnerApi.partner;

// B2B Partner API sandbox (static public X-API-KEY; in-memory mocks — see B2B_SANDBOX.md)
exports.partnerSandbox = partnerSandboxHttp.partnerSandbox;

// B2B portal: platform admin + partner org admin / members (Firebase Bearer auth)
exports.b2bPortal = b2bPortalHttp.b2bPortal;

// Export transactions REST API
exports.transactionsApi = transactionsHttp.transactionsApi;

// Export notifications REST API
exports.notificationsApi = notificationsHttp.notificationsApi;

// Export user triggers
exports.onUserCreated = usersTrigger.onUserCreated;
exports.userBootstrap = userBootstrap.userBootstrap;
exports.onAuthUserDeleted = authUserCleanup.onAuthUserDeleted;

// Customer app: password reset email (Identity Toolkit; requires FIREBASE_WEB_API_KEY)
exports.requestPasswordReset = customerAuthHttp.requestPasswordReset;

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
exports.setSupportedCountries = adminHttp.setSupportedCountries;
exports.pruneOrphanFirestoreUsers = adminHttp.pruneOrphanFirestoreUsers;

// Export admin claims management functions
exports.setAdminClaim = adminClaimsHttp.setAdminClaim;
exports.removeAdminClaim = adminClaimsHttp.removeAdminClaim;
