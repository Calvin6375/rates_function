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
    transfiWebhookSecret: "TRANSFI_WEBHOOK_SECRET",
    circleApiKey: "CIRCLE_API_KEY",
    circleEntitySecret: "CIRCLE_ENTITY_SECRET",
  },

  /**
   * Firebase Web API key (Console → Project settings → General).
   * Used by `requestPasswordReset` to call Identity Toolkit `sendOobCode` server-side.
   */
  firebaseWebApiKey: getEnv("FIREBASE_WEB_API_KEY") || null,

  // Feature flags
  features: {
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

  /**
   * B2B `partnerSandbox` HTTP function only: static public test key and virtual partner id.
   * Override `B2B_SANDBOX_PUBLIC_API_KEY` in production if you want a non-default secret.
   */
  b2bSandbox: {
    apiKey:
      getEnv("B2B_SANDBOX_PUBLIC_API_KEY") ||
      getEnv("B2B_SANDBOX_API_KEY") ||
      "KalvoB2B-Sandbox-public-test-key-2026",
    partnerId: getEnv("B2B_SANDBOX_PARTNER_ID", "__b2b_sandbox__"),
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
    // Firestore paths for migrated data (previously in RTDB)
    invoiceMappings: "invoiceMappings", // For payment webhook lookups
    // B2B and ledger (new architecture)
    /** B2B portal self-serve wizard + checklist (doc id = Firebase Auth uid) */
    onboarding: "onboarding",
    partners: "partners",
    settlements: "settlements",
    ledgerEntries: "ledger_entries",
    transactionRecords: "transactionRecords", // Unified transaction log for engine + ledger
    wallets: "wallets", // Partner wallets; user balances stay in users
    safariCoinWallets: "safariCoinWallets",
    paymentLinks: "paymentLinks",
    cryptoWallets: "cryptoWallets",
    cryptoTransactions: "cryptoTransactions",
    cryptoLedger: "cryptoLedger",
    walletAggregates: "walletAggregates",
    webhookEvents: "webhookEvents",
    sendIdempotencyKeys: "sendIdempotencyKeys",
    pendingReservations: "pendingReservations",
  },

  paymentLinks: {
    /** Override payer link host via PAYMENT_LINK_BASE_URL env (e.g. https://pay.truepay.africa). */
    baseUrl: getEnv("PAYMENT_LINK_BASE_URL", null),
  },

  circle: {
    apiKey: getEnv("CIRCLE_API_KEY", null),
    entitySecret: getEnv("CIRCLE_ENTITY_SECRET", null),
    env: getEnv("CIRCLE_ENV", "sandbox"),
    baseUrl: getEnv("CIRCLE_API_BASE_URL", "https://api.circle.com"),
    walletSetId: getEnv("CIRCLE_WALLET_SET_ID", null),
    blockchain: getEnv("CIRCLE_BLOCKCHAIN", null),
    usdcTokenId: getEnv("CIRCLE_USDC_TOKEN_ID", null),
  },
};

module.exports = config;

