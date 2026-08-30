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
    paystackSecretKey: "PAYSTACK_SECRET_KEY",
    paystackPublicKey: "PAYSTACK_PUBLIC_KEY",
    paystackSplitCode: "PAYSTACK_SPLIT_CODE",
    paystackB2bSplitCode: "PAYSTACK_B2B_SPLIT_CODE",
    paystackCallbackUrl: "PAYSTACK_CALLBACK_URL",
    paystackB2bCallbackUrl: "PAYSTACK_B2B_CALLBACK_URL",
    paystackWebhookSecret: "PAYSTACK_WEBHOOK_SECRET",
    transakApiKey: "TRANSAK_API_KEY",
    transakSecretKey: "TRANSAK_SECRET_KEY",
    transakWebhookSecret: "TRANSAK_WEBHOOK_SECRET",
    transakTreasuryWallet: "TRANSAK_TREASURY_WALLET",
    darajaConsumerKey: "DARAJA_CONSUMER_KEY",
    darajaConsumerSecret: "DARAJA_CONSUMER_SECRET",
    darajaInitiatorPassword: "DARAJA_INITIATOR_PASSWORD",
    /** Zoho SMTP (email verification / transactional mail) */
    smtpUser: "SMTP_USER",
    smtpPass: "SMTP_PASS",
    /**
     * Firebase Web API key (Console → Project settings → General → Web API Key).
     * Bound on b2bPortal for Identity Toolkit signInWithPassword / sendOobCode
     * (change-password, set-pin, forgot-password).
     * NOTE: Secret Manager forbids names starting with FIREBASE_ — use WEB_API_KEY.
     */
    firebaseWebApiKey: "WEB_API_KEY",
    c2bPayloadEncryptionKey: "C2B_PAYLOAD_ENCRYPTION_KEY",
  },

  /**
   * Firebase Web API key (Console → Project settings → General).
   * Used by password/set-pin flows to call Identity Toolkit server-side.
   * Prefer `process.env.WEB_API_KEY` at call time once the secret is bound.
   */
  firebaseWebApiKey: getEnv("WEB_API_KEY") || getEnv("FIREBASE_WEB_API_KEY") || null,

  /**
   * Zoho SMTP connection settings (non-secret).
   * Username/password MUST come from Secret Manager (SMTP_USER / SMTP_PASS) at runtime —
   * do not hardcode mailbox credentials in source.
   */
  smtp: {
    host: getEnv("SMTP_HOST", "smtp.zoho.com"),
    port: Number(getEnv("SMTP_PORT", "465")),
    fromName: getEnv("SMTP_FROM_NAME", "TruePay"),
  },

  /**
   * B2B dashboard URL used as the post-email-verification redirect (continueUrl).
   * Override with B2B_DASHBOARD_URL in production if the host changes.
   */
  b2bDashboardUrl:
    getEnv("B2B_DASHBOARD_URL", "https://theadmin.truepay.live") ||
    "https://theadmin.truepay.live",

  /**
   * Public Cloud Function path that applies the oobCode then 302s to the dashboard.
   * Full URL is built at send-time from GCLOUD_PROJECT + region unless overridden.
   */
  emailVerificationHandlerPath: "/public/verify-email",
  emailVerificationHandlerBaseUrl: getEnv("EMAIL_VERIFICATION_HANDLER_BASE_URL") || null,

  // Feature flags
  features: {
    enableDetailedLogging: getEnv("ENABLE_DETAILED_LOGGING", "true") === "true",
  },

  /** C2B mobile API payload encryption (optional; see docs/C2B_PAYLOAD_ENCRYPTION.md) */
  c2bPayloadEncryption: {
    required: getEnv("C2B_PAYLOAD_ENCRYPTION_REQUIRED", "false") === "true",
    defaultKeyId: getEnv("C2B_PAYLOAD_ENCRYPTION_KEY_ID", "default"),
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
    /** Locked Exchange quotes (Send→Get); consumed once by createSwapOrder */
    exchangeQuotes: "exchangeQuotes",
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
    platformAdmins: "platformAdmins",
    sendIdempotencyKeys: "sendIdempotencyKeys",
    pendingReservations: "pendingReservations",
    /** Tourist Payments — funding initiation source of truth */
    fundingOrders: "fundingOrders",
    /** Append-only fiat ledger (mirror of cryptoLedger) */
    fiatLedger: "fiatLedger",
    /** Fiat balance aggregate cache derived from fiatLedger */
    walletAggregatesFiat: "walletAggregatesFiat",
    /** Fiat holds for merchant settlement (mirror of pendingReservations) */
    pendingFiatReservations: "pendingFiatReservations",
    /** External tourist merchants (Till / PayBill / bank — not B2B partners) */
    merchantDirectory: "merchantDirectory",
    /** Tourist → merchant payment records */
    merchantPayments: "merchantPayments",
    /** Safaricom Daraja B2B settlement jobs */
    settlementJobs: "settlementJobs",
    /** Webhook receipt persistence before processing */
    webhookReceipts: "webhookReceipts",
    /** Funding order idempotency keys (TTL) */
    fundingIdempotencyKeys: "fundingIdempotencyKeys",
    /** Daily ops metrics rollups */
    opsMetricsDaily: "opsMetricsDaily",
    /** Admin payment audit trail */
    paymentAuditLog: "paymentAuditLog",
    /** B2B Send — saved merchants/recipients per partner */
    partnerRecipients: "partnerRecipients",
    /** B2B Send — outbound partner → merchant payments */
    partnerSendPayments: "partnerSendPayments",
    /** Safari Card — IntaSend disbursement payouts */
    safariCardPayouts: "safariCardPayouts",
    /** Safari Card payout idempotency keys */
    safariCardPayoutIdempotency: "safariCardPayoutIdempotency",
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

  paystack: {
    secretKey: getEnv("PAYSTACK_SECRET_KEY", null),
    publicKey: getEnv("PAYSTACK_PUBLIC_KEY", null),
    splitCode: getEnv("PAYSTACK_SPLIT_CODE", null),
    /** Optional B2B self-topup split; falls back to splitCode when unset */
    b2bSplitCode: getEnv("PAYSTACK_B2B_SPLIT_CODE", null),
    callbackUrl: getEnv("PAYSTACK_CALLBACK_URL", null),
    /** Dashboard return URL after Paystack checkout (B2B Add Money) */
    b2bCallbackUrl: getEnv("PAYSTACK_B2B_CALLBACK_URL", null),
    webhookSecret: getEnv("PAYSTACK_WEBHOOK_SECRET", null),
    baseUrl: getEnv("PAYSTACK_API_BASE_URL", "https://api.paystack.co"),
  },

  transak: {
    apiKey: getEnv("TRANSAK_API_KEY", null),
    secretKey: getEnv("TRANSAK_SECRET_KEY", null),
    webhookSecret: getEnv("TRANSAK_WEBHOOK_SECRET", null),
    environment: getEnv("TRANSAK_ENVIRONMENT", "staging"),
    baseUrl: getEnv("TRANSAK_API_BASE_URL", null),
    gatewayBaseUrl: getEnv("TRANSAK_GATEWAY_API_BASE_URL", null),
    partnersBaseUrl: getEnv("TRANSAK_PARTNERS_API_BASE_URL", null),
    defaultFiat: getEnv("TRANSAK_DEFAULT_FIAT", "USD"),
    defaultCrypto: getEnv("TRANSAK_DEFAULT_CRYPTO", "USDT"),
    defaultNetwork: getEnv("TRANSAK_DEFAULT_NETWORK", "ethereum"),
    treasuryWallet: getEnv("TRANSAK_TREASURY_WALLET", null),
    referrerDomain: getEnv("TRANSAK_REFERRER_DOMAIN", "truepay.africa"),
    debug: getEnv("TRANSAK_DEBUG", "false"),
    headless: getEnv("TRANSAK_HEADLESS", "true"),
    mode: getEnv("TRANSAK_MODE", null),
  },

  /** Safaricom Daraja — stub mode when credentials absent */
  daraja: {
    consumerKey: getEnv("DARAJA_CONSUMER_KEY", null),
    consumerSecret: getEnv("DARAJA_CONSUMER_SECRET", null),
    initiatorName: getEnv("DARAJA_INITIATOR_NAME", "TruePayAPI"),
    initiatorPassword: getEnv("DARAJA_INITIATOR_PASSWORD", null),
    shortcode: getEnv("DARAJA_SHORTCODE", null),
    env: getEnv("DARAJA_ENV", "sandbox"),
    baseUrl: getEnv(
        "DARAJA_API_BASE_URL",
        getEnv("DARAJA_ENV", "sandbox") === "production" ?
          "https://api.safaricom.co.ke" :
          "https://sandbox.safaricom.co.ke",
    ),
    stubMode: getEnv("DARAJA_STUB_MODE", "auto"),
  },

  funding: {
    /** Default provider for Tourist Payments */
    defaultProvider: getEnv("FUNDING_DEFAULT_PROVIDER", "paystack"),
    /** USD only — TruePay owns FX at settlement */
    currency: "USD",
    /** Idempotency key TTL (hours) */
    idempotencyTtlHours: Number(getEnv("FUNDING_IDEMPOTENCY_TTL_HOURS", "24")),
    /** Stale pending order threshold for reconciliation (minutes) */
    reconcileStaleMinutes: Number(getEnv("FUNDING_RECONCILE_STALE_MINUTES", "20")),
  },

  /** Fiat reservation / settlement ops */
  fiatOps: {
    reservationTtlMinutes: Number(getEnv("FIAT_RESERVATION_TTL_MINUTES", "30")),
    settlementMaxRetries: Number(getEnv("SETTLEMENT_MAX_RETRIES", "5")),
    settlementRetryBaseMs: Number(getEnv("SETTLEMENT_RETRY_BASE_MS", "60000")),
  },

  /** Safari Card payout flat fees (KES). Override via env. */
  safariCardPayoutFees: {
    mpesaB2c: Number(getEnv("SAFARI_CARD_MPESA_B2C_FEE", "0")),
    mpesaB2b: Number(getEnv("SAFARI_CARD_MPESA_B2B_FEE", "0")),
    bank: Number(getEnv("SAFARI_CARD_BANK_FEE", "0")),
    wallet: Number(getEnv("SAFARI_CARD_WALLET_FEE", "0")),
  },

  safariCardPayouts: {
    /** Max KES payout amount unless overridden */
    maxAmountKes: Number(getEnv("SAFARI_CARD_MAX_PAYOUT_KES", "999999")),
    minAmountKes: Number(getEnv("SAFARI_CARD_MIN_PAYOUT_KES", "1")),
  },

  /** C2B consumer app — Paystack return / deep link (external browser flow) */
  c2b: {
    /** Override `api` base URL for hosted payment-return page */
    apiBaseUrl: getEnv("C2B_API_BASE_URL", null),
    /** Deep link opened after Paystack redirect, e.g. truepay://payment/callback */
    appDeepLink: getEnv("C2B_APP_DEEP_LINK", "truepay://payment/callback"),
  },
};

module.exports = config;

