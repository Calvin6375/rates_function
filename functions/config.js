/**
 * @fileoverview Configuration module for environment variables and feature flags
 * @typedef {Object} Config
 * @property {string} region - Firebase Functions region
 * @property {Object} secrets - Secret configuration
 * @property {Object} features - Feature flags
 */

/**
 * Get environment variable with fallback
 * @param {string} key - Environment variable key
 * @param {string|number|boolean} defaultValue - Default value if not set
 * @returns {string|number|boolean} Environment variable value or default
 */
function getEnv(key, defaultValue = null) {
  return process.env[key] || defaultValue;
}

/**
 * Configuration object
 * @type {Config}
 */
const config = {
  // Firebase Functions region
  region: getEnv("FUNCTIONS_REGION", "us-central1"),

  // Resource configuration
  resources: {
    cpu: 0.25,
    memory: "256MiB",
  },

  // Secret names (actual secrets are managed via Firebase Functions secrets)
  secrets: {
    intaSendSecret: "INTASEND_SECRET",
    intaSendChallenge: "INTASEND_CHALLENGE",
    intaSendSecretKey: "INTASEND_SECRET_KEY",
    intaSendPublishableKey: "INTASEND_PUBLISHABLE_KEY",
  },

  // Feature flags
  features: {
    enableIdempotency: getEnv("ENABLE_IDEMPOTENCY", "true") === "true",
    enableOutbox: getEnv("ENABLE_OUTBOX", "true") === "true",
    enableDetailedLogging: getEnv("ENABLE_DETAILED_LOGGING", "true") === "true",
  },

  // Binance API configuration
  binance: {
    baseUrl: "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search",
    defaultAsset: "USDT",
    defaultFiat: "KES",
    supportedFiats: ["KES", "NGN", "GHS"],
  },

  // Rate cache configuration
  rates: {
    cacheValidityMinutes: 5,
    arbitrageCacheValidityMinutes: 10,
  },

  // Firestore collections
  collections: {
    users: "users",
    orders: "orders",
    transactions: "transactions",
    p2pRates: "p2pRates",
    config: "config",
    adminLogs: "adminLogs",
    customerWallets: "customerWallets",
    outbox: "outbox",
    // Firestore paths for migrated data (previously in RTDB)
    invoiceMappings: "invoiceMappings", // For payment webhook lookups
  },
};

module.exports = config;

