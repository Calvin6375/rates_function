/**
 * @fileoverview HTTP handlers for customer wallets REST API
 * Thin controllers that delegate to business logic in libs/userWallets.js
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("../admin");
const express = require("express");
const config = require("../config");
const userWalletsLib = require("../libs/userWallets");
const ratesLib = require("../libs/rates");
const p2pListingsLib = require("../libs/p2pListings");
const {
  resolveCustomerPair,
  expandRatesWithCrosses,
  parseSendGetQuery,
  buildSendGetRatePayload,
  normalizeRatesForStorage,
  normalizeKesBook,
  toCurrencyBook,
  BASE_CURRENCY,
  RATE_MEANING,
  listCurrenciesFromRates,
} = require("../utils/customerRatesResolve");
const {getPairCapabilities} = require("../services/settlementCapabilityService");
const exchangeQuoteService = require("../services/exchangeQuoteService");
const supportedCountriesService = require("../services/supportedCountriesService");
const customerSelfRegistrationService = require("../services/customerSelfRegistrationService");
const walletService = require("../services/walletService");
const c2bSafariTapAdminListService = require("../services/c2bSafariTapAdminListService");
const { mountFundingRoutes } = require("./fundingHttp");
const { mountProductPricingRoutes } = require("./productPricingRoutes");
const { mountFundingOpsRoutes } = require("./fundingOpsHttp");
const { isPlatformAdmin } = require("../utils/accessControl");
const { verifyFirebaseAuth } = require("../libs/auth");
const {
  C2B_ENCRYPTION_SECRETS,
  C2B_ENCRYPTION_ALLOW_HEADERS,
  createC2bPayloadEncryptionMiddleware,
} = require("./middleware/c2bPayloadEncryption");

const db = admin.firestore();
const app = express();

/**
 * Only return pairs with valid positive buy/sell (avoids admin UI .toLocaleString on undefined).
 * @param {Object} rates
 * @returns {Object} Map of pair string to buyRate/sellRate numbers
 */
function sanitizeCustomerRatesObject(rates) {
  const out = {};
  if (!rates || typeof rates !== "object") {
    return out;
  }
  for (const [pair, row] of Object.entries(rates)) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const buyRate = Number(row.buyRate);
    const sellRate = Number(row.sellRate);
    if (
      !Number.isFinite(buyRate) ||
      !Number.isFinite(sellRate) ||
      buyRate <= 0 ||
      sellRate <= 0
    ) {
      continue;
    }
    out[pair] = { buyRate, sellRate };
  }
  return out;
}

// Middleware
app.use(express.json());
app.use(createC2bPayloadEncryptionMiddleware());

// CORS middleware - supports credentials
app.use((req, res, next) => {
  const origin = req.headers.origin;

  const allowedOrigins = [
    "https://truepay-72060.web.app",
    "https://truepay-72060.firebaseapp.com",
    "https://theadmin.truepay.live",
    "https://truepay.live",
    "https://www.truepay.live",
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:8080",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:8080",
  ];

  let allowedOrigin = "*";
  if (origin) {
    if (allowedOrigins.includes(origin)) {
      allowedOrigin = origin;
    } else if (origin.includes("localhost") || origin.includes("127.0.0.1")) {
      allowedOrigin = origin;
    } else if (
      origin.includes("truepay-72060") ||
      /^https:\/\/([a-z0-9-]+\.)*truepay\.live$/i.test(origin)
    ) {
      allowedOrigin = origin;
    }
  }

  res.set("Access-Control-Allow-Origin", allowedOrigin);
  res.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.set("Access-Control-Allow-Headers", C2B_ENCRYPTION_ALLOW_HEADERS);
  res.set("Access-Control-Allow-Credentials", "true");
  res.set("Access-Control-Max-Age", "3600");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  next();
});

/**
 * Express middleware: valid Firebase ID token and platform admin access.
 * Accepts userType admin, legacy admin claim, or built-in super-admin email.
 */
async function requireAdmin(req, res, next) {
  try {
    const auth = await verifyFirebaseAuth(req);
    if (!auth.success) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
        message: auth.error || "Authentication required. Please provide a valid Firebase Auth token.",
      });
      return;
    }

    const decodedToken = auth.decodedToken;
    req.adminId = decodedToken.uid;

    if (await isPlatformAdmin(decodedToken, decodedToken.uid)) {
      next();
      return;
    }

    try {
      const userRecord = await admin.auth().getUser(decodedToken.uid);
      if (userRecord.customClaims &&
          (userRecord.customClaims.admin === true ||
           userRecord.customClaims.userType === "admin")) {
        console.log(`requireAdmin: stale token for ${decodedToken.uid} — live claim check passed`);
        next();
        return;
      }
    } catch (userLookupErr) {
      console.warn("requireAdmin: live claim lookup failed:", userLookupErr.message);
    }

    if (await isPlatformAdmin(null, decodedToken.uid)) {
      next();
      return;
    }

    res.status(403).json({
      success: false,
      error: "Forbidden",
      message: "Admin access required.",
    });
  } catch (err) {
    console.error("requireAdmin middleware:", err.message);
    res.status(500).json({
      success: false,
      error: "Internal error",
      message: err.message,
    });
  }
}

/**
 * Express middleware: valid Firebase ID token for the calling C2B customer.
 */
async function requireCustomerAuth(req, res, next) {
  try {
    const auth = await verifyFirebaseAuth(req);
    if (!auth.success || !auth.userId) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
        message: auth.error || "Authentication required. Please provide a valid Firebase Auth token.",
      });
      return;
    }
    req.userId = auth.userId;
    next();
  } catch (err) {
    console.error("requireCustomerAuth middleware:", err.message);
    res.status(500).json({
      success: false,
      error: "Internal error",
      message: err.message,
    });
  }
}

/**
 * Shared handler for GET /accounts and GET /wallets.
 * Authenticated C2B wallet list (fiat + crypto). Replaces direct Flutter RTDB
 * reads of wallet/{uid}/fiat and wallet/{uid}/crypto.
 * Balances come from Firestore + USDC ledger — never from RTDB.
 */
async function handleListCustomerAccounts(req, res) {
  try {
    const accounts = await walletService.listCustomerAccounts(req.userId);
    if (!accounts) {
      res.status(404).json({
        success: false,
        error: "NOT_FOUND",
        message: "User wallet not found",
      });
      return;
    }
    res.status(200).json({
      success: true,
      data: accounts,
    });
  } catch (error) {
    console.error("Error listing customer accounts:", error);
    res.status(500).json({
      success: false,
      error: "Failed to list accounts",
      message: error.message,
    });
  }
}

app.get("/accounts", requireCustomerAuth, handleListCustomerAccounts);
/** Alias of GET /accounts */
app.get("/wallets", requireCustomerAuth, handleListCustomerAccounts);

/**
 * GET /rates
 * Public customer rate book (KES-per-unit) with expanded Send/Get crosses.
 * Does not overwrite admin rates with Binance.
 */
app.get("/rates", async (req, res) => {
  try {
    const configRef = db.collection(config.collections.config).doc("customerRates");
    const configDoc = await configRef.get();

    if (!configDoc.exists) {
      res.status(200).json({
        success: true,
        data: {
          rates: {},
          book: {},
          baseCurrency: BASE_CURRENCY,
          rateMeaning: RATE_MEANING,
        },
        message: "No rates configured yet",
      });
      return;
    }

    const configData = configDoc.data();
    const rates = {...(configData.rates || {})};
    const ratesExpanded = expandRatesWithCrosses(rates);
    const book = toCurrencyBook(rates);

    res.status(200).json({
      success: true,
      data: {
        rates: ratesExpanded,
        book,
        currencies: listCurrenciesFromRates(rates),
        baseCurrency: configData.baseCurrency || BASE_CURRENCY,
        rateMeaning: configData.rateMeaning || RATE_MEANING,
        rateVersion: configData.rateVersion != null ? Number(configData.rateVersion) : null,
        updatedAt: configData.updatedAt?.toDate?.()?.toISOString() || null,
      },
    });
  } catch (error) {
    console.error("Error getting rates:", error);
    res.status(500).json({
      success: false,
      error: "Failed to get rates",
      message: error.message,
    });
  }
});

/**
 * GET /countries
 * Supported **currency** codes derived from the P2P rates book
 * (`config/customerRates`). Field name `countries` is legacy; values are
 * currencies (ETB, KES, USDC), not ISO country codes.
 * Public — same App Check enforcement as the rest of this HTTP function.
 */
app.get("/countries", async (req, res) => {
  try {
    const payload = await supportedCountriesService.getSupportedCountries();
    res.status(200).json({
      success: true,
      data: {
        countries: payload.countries,
        currencies: payload.currencies,
        source: payload.source,
        rateVersion: payload.rateVersion,
        updatedAt: payload.updatedAt,
        isDefault: payload.isDefault,
      },
    });
  } catch (error) {
    console.error("Error getting supported countries:", error);
    res.status(500).json({
      success: false,
      error: "Failed to get supported countries",
      message: error.message,
    });
  }
});

/**
 * POST /register
 * C2B self-registration (Flutter customer app). Creates Firebase Auth user +
 * Firestore users/{uid} with Institution "Customer App" and Channel "C2B".
 * Same App Check enforcement as the rest of this HTTP function.
 */
app.post("/register", async (req, res) => {
  try {
    const data = await customerSelfRegistrationService.registerC2bCustomer(
        req.body || {},
    );
    res.status(201).json({
      success: true,
      data,
      message:
          "Account created. Sign in with the same email and password " +
          "(do not register a second Firebase account for this email).",
    });
  } catch (err) {
    const rawCode = err.statusCode;
    const status =
      typeof rawCode === "number" && rawCode >= 400 && rawCode < 600
        ? rawCode
        : 400;
    console.error("POST /register:", status, err.message);
    res.status(status).json({
      success: false,
      error: status === 409 ? "Already exists" : "Registration failed",
      message: err.message || "Registration failed",
    });
  }
});

/**
 * GET /customer-rates
 * Exchange quote: Send (sold) → Get (received). KES-numeraire crosses.
 *
 * Query: send + get (aliases from/to). Legacy: currencyPair=SEND/GET.
 * data.rate = Get per 1 Send (sell side). Missing priced leg ⇒ 404 (no 1.0 peg).
 */
app.get("/customer-rates", async (req, res) => {
  try {
    const defaultPair = `USDT/${BASE_CURRENCY}`;
    const parsed = parseSendGetQuery(req.query, {defaultPair});
    if (!parsed.ok) {
      res.status(400).json({
        success: false,
        error: parsed.error,
        message: parsed.message,
      });
      return;
    }

    const {sendCurrency, getCurrency, currencyPair} = parsed;

    const configRef = db.collection(config.collections.config).doc("customerRates");
    const configDoc = await configRef.get();

    if (!configDoc.exists) {
      res.status(404).json({
        success: false,
        error: "Customer rates not configured",
        message: `No rates found for ${sendCurrency} → ${getCurrency}. Please configure rates in admin dashboard.`,
      });
      return;
    }

    const configData = configDoc.data();
    const rates = {...(configData.rates || {})};
    const {conflicts} = normalizeKesBook(rates);

    const resolved = resolveCustomerPair(rates, currencyPair);
    if (!resolved) {
      const known = listCurrenciesFromRates(rates).join(", ") || "none";
      res.status(404).json({
        success: false,
        error: "MISSING_RATE",
        message: `No KES price for send=${sendCurrency} and/or get=${getCurrency}. Configure each currency in admin (KES per 1 unit). Known: ${known}`,
      });
      return;
    }

    const caps = getPairCapabilities(sendCurrency, getCurrency);
    const payload = buildSendGetRatePayload({
      sendCurrency,
      getCurrency,
      pairRates: {buyRate: resolved.buyRate, sellRate: resolved.sellRate},
      source: resolved.source,
      numeraire: resolved.numeraire,
      rateUnit: resolved.rateUnit,
      quotable: caps.quotable,
      settleable: caps.settleable,
      rateVersion: configData.rateVersion != null ? Number(configData.rateVersion) : null,
      conflicts: conflicts.length ? conflicts : null,
      updatedAt: configData.updatedAt?.toDate?.()?.toISOString() || null,
    });

    // Optional locked quote when sendAmount is provided (auth required if settleable)
    const sendAmountRaw = req.query.sendAmount ?? req.query.amount;
    if (sendAmountRaw != null && String(sendAmountRaw).trim() !== "") {
      try {
        const auth = await verifyFirebaseAuth(req);
        const userId = auth.success ? auth.uid : null;
        if (caps.settleable && !userId) {
          res.status(401).json({
            success: false,
            error: "UNAUTHORIZED_QUOTE",
            message: "Authentication required to create a settleable Exchange quote",
          });
          return;
        }

        const quote = await exchangeQuoteService.createQuote({
          rates,
          sendCurrency,
          getCurrency,
          sendAmount: sendAmountRaw,
          userId,
          rateVersion: Number(configData.rateVersion) || 0,
          ratesUpdatedAt: payload.updatedAt,
        });
        payload.quoteId = quote.quoteId;
        payload.sendAmount = quote.sendAmount;
        payload.getAmount = quote.getAmount;
        payload.grossGetAmount = quote.grossGetAmount;
        payload.netGetAmount = quote.netGetAmount;
        payload.feeRate = quote.feeRate;
        payload.feeAmount = quote.feeAmount;
        payload.feeCurrency = quote.feeCurrency;
        payload.totalDebit = quote.totalDebit;
        payload.feeConvention = quote.feeConvention;
        payload.expiresAt = quote.expiresAt;
        payload.quoteStatus = quote.status;
      } catch (quoteErr) {
        if (
          quoteErr.code === "INVALID_AMOUNT" ||
          quoteErr.code === "UNAUTHORIZED_QUOTE" ||
          quoteErr.code === "INVALID_CURRENCY"
        ) {
          res.status(quoteErr.code === "UNAUTHORIZED_QUOTE" ? 401 : 400).json({
            success: false,
            error: quoteErr.code,
            message: quoteErr.message,
          });
          return;
        }
        throw quoteErr;
      }
    }

    res.status(200).json({
      success: true,
      data: payload,
    });
  } catch (error) {
    console.error("Error getting customer rates:", error);
    res.status(500).json({
      success: false,
      error: "Failed to get customer rates",
      message: error.message,
    });
  }
});

/**
 * POST /exchange-quotes
 * Create a locked Send→Get quote (auth recommended). Body: send, get, sendAmount.
 */
app.post("/exchange-quotes", async (req, res) => {
  try {
    const auth = await verifyFirebaseAuth(req);
    if (!auth.success) {
      res.status(401).json({
        success: false,
        error: "UNAUTHORIZED_QUOTE",
        message: "Authentication required to create an Exchange quote",
      });
      return;
    }
    const userId = auth.uid;
    const body = req.body || {};
    const sendCurrency = String(body.send || body.sendCurrency || body.from || "").toUpperCase();
    const getCurrency = String(body.get || body.getCurrency || body.to || "").toUpperCase();
    const sendAmount = body.sendAmount ?? body.amount;

    if (!sendCurrency || !getCurrency) {
      res.status(400).json({
        success: false,
        error: "INVALID_CURRENCY",
        message: "send and get are required",
      });
      return;
    }
    if (sendAmount == null) {
      res.status(400).json({
        success: false,
        error: "INVALID_AMOUNT",
        message: "sendAmount is required",
      });
      return;
    }

    const configRef = db.collection(config.collections.config).doc("customerRates");
    const configDoc = await configRef.get();
    if (!configDoc.exists) {
      res.status(404).json({
        success: false,
        error: "MISSING_RATE",
        message: "Customer rates not configured",
      });
      return;
    }
    const configData = configDoc.data();
    const quote = await exchangeQuoteService.createQuote({
      rates: configData.rates || {},
      sendCurrency,
      getCurrency,
      sendAmount,
      userId,
      rateVersion: Number(configData.rateVersion) || 0,
      ratesUpdatedAt: configData.updatedAt?.toDate?.()?.toISOString() || null,
    });

    res.status(201).json({success: true, data: quote});
  } catch (error) {
    const code = error.code || "internal";
    const status = code === "MISSING_RATE" ? 404 :
      (code === "INVALID_CURRENCY" || code === "INVALID_AMOUNT" ? 400 : 500);
    res.status(status).json({
      success: false,
      error: code,
      message: error.message,
    });
  }
});

/**
 * GET /binance/rates
 * Get Binance exchange rates for a currency pair
 */
app.get("/binance/rates", async (req, res) => {
  try {
    const fiat = req.query.fiat || config.binance.defaultFiat;
    const asset = req.query.asset || config.binance.defaultAsset;

    const result = await ratesLib.getBinanceRatesLogic(fiat, asset);

    // Convert Firestore Timestamps to milliseconds for JSON response
    const response = {
      marketPrice: result.marketPrice,
      customerPrice: result.customerPrice,
      feePercentage: result.feePercentage,
      currencyPair: result.currencyPair,
      asset: result.asset,
      fiat: result.fiat,
      validUntil: result.validUntil?.toMillis?.() || Date.now() + 300000,
      updatedAt: result.updatedAt?.toMillis?.() || Date.now(),
      source: result.source || "fresh",
    };

    res.status(200).json(response);
  } catch (err) {
    console.error("Error in /binance/rates endpoint:", err.message);
    res.status(500).json({
      error: "internal",
      message: `Failed to fetch rates: ${err.message}`,
    });
  }
});

/**
 * POST /p2p/listings
 * Get P2P listings from Binance
 * This endpoint proxies requests to Binance P2P API
 * 
 * CRITICAL: The tradeType parameter MUST be forwarded exactly as received.
 * The frontend makes two parallel calls:
 * - USA: tradeType: "SELL" (people selling USDT for USD) - to find where to BUY USDT
 * - Kenya: tradeType: "BUY" (people buying USDT with KES) - to find where to SELL USDT
 * Do NOT swap or modify the tradeType parameter - forward it directly to Binance.
 */
app.post("/p2p/listings", async (req, res) => {
  try {
    const requestBody = req.body || {};

    // Validate required parameters
    if (!requestBody.asset || !requestBody.fiat || !requestBody.tradeType) {
      res.status(400).json({
        success: false,
        error: "Missing required parameters: asset, fiat, and tradeType are required",
        data: null,
      });
      return;
    }

    // Log the incoming request for debugging
    console.log("Received P2P listings request:", {
      asset: requestBody.asset,
      fiat: requestBody.fiat,
      tradeType: requestBody.tradeType, // Log to verify it's received correctly
      page: requestBody.page,
      rows: requestBody.rows,
    });

    // Fetch P2P listings from Binance
    // The tradeType will be forwarded exactly as received (no modification)
    const binanceResponse = await p2pListingsLib.fetchP2PListings(requestBody);

    // Return Binance response directly (as per requirements)
    // The frontend expects the Binance response format
    res.status(200).json(binanceResponse);
  } catch (err) {
    console.error("Error in /p2p/listings endpoint:", {
      error: err.message,
      stack: err.stack,
      requestBody: req.body,
    });

    // Determine appropriate status code based on error
    let statusCode = 500;
    let errorMessage = "Internal server error. Please try again later.";

    if (err.message.includes("Missing required parameters")) {
      statusCode = 400;
      errorMessage = err.message;
    } else if (err.message.includes("403") || err.message.includes("blocked")) {
      statusCode = 503; // Service Unavailable
      errorMessage = "Binance API is currently unavailable. Please try again later.";
    } else if (err.message.includes("429") || err.message.includes("Rate limit")) {
      statusCode = 429; // Too Many Requests
      errorMessage = err.message;
    } else if (err.message.includes("timeout") || err.message.includes("Network error")) {
      statusCode = 504; // Gateway Timeout
      errorMessage = err.message;
    } else if (err.message) {
      errorMessage = err.message;
    }

    res.status(statusCode).json({
      success: false,
      error: errorMessage,
      data: null,
    });
  }
});

/**
 * GET /customer-wallets
 * List all customer wallets with pagination
 * Authentication: Admin only
 */
/**
 * GET /admin/safari-tap/transactions
 * Admin Safari Tap dashboard tabs: Topups | Pay | Send | Exchange.
 *
 * Query:
 * - type|method (required): topups | pay | send | exchange
 * - period: today | 7d | 30d | month | custom (default 30d)
 * - startDate, endDate: ISO (required when period=custom)
 * - status, currency, userId, search, limit, startAfter
 */
app.get("/admin/safari-tap/transactions", requireAdmin, async (req, res) => {
  try {
    const data = await c2bSafariTapAdminListService.listSafariTapTransactions(req.query || {});
    res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    const status = error.httpStatus || (error.code === "VALIDATION_FAILED" ? 400 : 500);
    console.error("Error listing Safari Tap admin transactions:", error);
    res.status(status).json({
      success: false,
      error: error.code || "Failed to list Safari Tap transactions",
      message: error.message,
    });
  }
});

app.get("/customer-wallets", requireAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const { wallets, total } = await userWalletsLib.listCustomerWallets(limit, offset);

    res.status(200).json({
      success: true,
      data: wallets,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + wallets.length < total,
      },
    });
  } catch (error) {
    console.error("Error fetching customer wallets:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch customer wallets",
      message: error.message,
    });
  }
});

/**
 * GET /customer-wallets/:id
 * Get a specific customer wallet by ID
 * Authentication: Admin only
 */
app.get("/customer-wallets/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const wallet = await userWalletsLib.getCustomerWallet(id);

    if (!wallet) {
      res.status(404).json({
        success: false,
        error: "Customer wallet not found in users or customerWallets collection",
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: wallet,
    });
  } catch (error) {
    console.error("Error fetching customer wallet:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch customer wallet",
      message: error.message,
    });
  }
});

/**
 * PUT /customer-wallets/:id
 * Update customer wallet details
 * Authentication: Admin only
 */
app.put("/customer-wallets/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    const wallet = await userWalletsLib.updateCustomerWallet(id, updateData);

    res.status(200).json({
      success: true,
      data: wallet,
    });
  } catch (error) {
    console.error("Error updating customer wallet:", error);
    res.status(error.message.includes("not found") ? 404 : 500).json({
      success: false,
      error: "Failed to update customer wallet",
      message: error.message,
    });
  }
});

/**
 * POST /customer-wallets/:id/credit
 * Credit money to a customer wallet
 * 
 * Request body:
 * {
 *   "amount": 1000,
 *   "currency": "KES",  // Optional: "USD", "KES", "USDT" - defaults to "USD"
 *   "description": "Deposit"
 * }
 *
 * Authentication: Admin only
 */
app.post("/customer-wallets/:id/credit", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, currency = "USD", description } = req.body;

    if (!amount || typeof amount !== "number" || amount <= 0) {
      res.status(400).json({
        success: false,
        error: "Invalid amount. Amount must be a positive number.",
      });
      return;
    }

    // Validate currency
    const validCurrencies = ["USD", "KES", "USDT"];
    if (!validCurrencies.includes(currency.toUpperCase())) {
      res.status(400).json({
        success: false,
        error: `Invalid currency. Must be one of: ${validCurrencies.join(", ")}`,
      });
      return;
    }

    const result = await userWalletsLib.creditCustomerWallet(id, amount, description, currency.toUpperCase());

    res.status(200).json({
      success: true,
      data: result.wallet,
      transaction: result.transaction,
    });
  } catch (error) {
    console.error("Error crediting customer wallet:", error);
    res.status(error.message.includes("not found") ? 404 : 500).json({
      success: false,
      error: "Failed to credit customer wallet",
      message: error.message,
    });
  }
});

/**
 * POST /customer-wallets/:id/debit
 * Debit money from a customer wallet
 * 
 * Request body:
 * {
 *   "amount": 1000,
 *   "currency": "KES",  // Optional: "USD", "KES", "USDT" - defaults to "USD"
 *   "description": "Withdrawal"
 * }
 *
 * Authentication: Admin only
 */
app.post("/customer-wallets/:id/debit", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, currency = "USD", description } = req.body;

    if (!amount || typeof amount !== "number" || amount <= 0) {
      res.status(400).json({
        success: false,
        error: "Invalid amount. Amount must be a positive number.",
      });
      return;
    }

    // Validate currency
    const validCurrencies = ["USD", "KES", "USDT"];
    if (!validCurrencies.includes(currency.toUpperCase())) {
      res.status(400).json({
        success: false,
        error: `Invalid currency. Must be one of: ${validCurrencies.join(", ")}`,
      });
      return;
    }

    const result = await userWalletsLib.debitCustomerWallet(id, amount, description, currency.toUpperCase());

    res.status(200).json({
      success: true,
      data: result.wallet,
      transaction: result.transaction,
    });
  } catch (error) {
    console.error("Error debiting customer wallet:", error);
    if (error.message === "Insufficient balance") {
      res.status(400).json({
        success: false,
        error: "Insufficient balance",
        message: error.message,
      });
      return;
    }
    res.status(error.message.includes("not found") ? 404 : 500).json({
      success: false,
      error: "Failed to debit customer wallet",
      message: error.message,
    });
  }
});

/**
 * POST /customer-wallets
 * Create a new customer wallet
 * Authentication: Admin only
 */
app.post("/customer-wallets", requireAdmin, async (req, res) => {
  try {
    const { name, email, phone, initialBalance = 0 } = req.body;

    if (!name || !email) {
      res.status(400).json({
        success: false,
        error: "Name and email are required",
      });
      return;
    }

    // Check if customer with same email already exists
    const existingSnapshot = await db.collection(config.collections.customerWallets)
      .where("email", "==", email)
      .limit(1)
      .get();

    if (!existingSnapshot.empty) {
      res.status(409).json({
        success: false,
        error: "Customer with this email already exists",
      });
      return;
    }

    const walletData = {
      name,
      email,
      phone: phone || "",
      balance: initialBalance || 0,
      status: "active",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const walletRef = await db.collection(config.collections.customerWallets).add(walletData);
    const walletDoc = await walletRef.get();
    const wallet = walletDoc.data();

    res.status(201).json({
      success: true,
      data: {
        id: walletDoc.id,
        ...wallet,
        createdAt: wallet.createdAt?.toDate?.()?.toISOString() || null,
        updatedAt: wallet.updatedAt?.toDate?.()?.toISOString() || null,
      },
    });
  } catch (error) {
    console.error("Error creating customer wallet:", error);
    res.status(500).json({
      success: false,
      error: "Failed to create customer wallet",
      message: error.message,
    });
  }
});

/**
 * GET /config/fees
 * Get current customer rates configuration (buyRate and sellRate)
 * Authentication: Required (any authenticated user can read)
 * 
 * Returns customer rates (rate + commission combined) in Buy and Sell format
 * for use by the Flutter app. Rates are stored per currency pair.
 */
app.get("/config/fees", async (req, res) => {
  try {
    const auth = await verifyFirebaseAuth(req);
    if (!auth.success) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
        message: auth.error || "Authentication required. Please provide a valid Firebase Auth token.",
      });
      return;
    }

    // Get customer rates configuration from Firestore
    const configRef = db.collection(config.collections.config).doc("customerRates");
    const configDoc = await configRef.get();

    if (!configDoc.exists) {
      // Return default structure if config doesn't exist
      res.status(200).json({
        success: true,
        data: {
          rates: {}, // Empty rates object - admin needs to set rates
        },
        message: "No customer rates configured. Please set buyRate and sellRate.",
      });
      return;
    }

    const configData = configDoc.data();

    // Get arbitrage fee from config/fees
    // Note: customerRates is in config/customerRates, but arbitrageFee is in config/fees
    let arbitrageFee = 1.5; // Default fallback
    try {
      const feesRef = db.collection(config.collections.config).doc("fees");
      const feesDoc = await feesRef.get();
      if (feesDoc.exists && feesDoc.data().arbitrageFee !== undefined) {
        arbitrageFee = Number(feesDoc.data().arbitrageFee);
      }
    } catch (err) {
      console.error("Error fetching arbitrage fee:", err);
    }

    const safeRates = sanitizeCustomerRatesObject(configData.rates || {});
    const feeNum = Number(arbitrageFee);
    const safeArbitrage = Number.isFinite(feeNum) && feeNum > 0 ? feeNum : 1.5;
    const rawRates = configData.rates || {};

    res.status(200).json({
      success: true,
      data: {
        rates: safeRates,
        book: toCurrencyBook(rawRates),
        baseCurrency: configData.baseCurrency || BASE_CURRENCY,
        rateMeaning: configData.rateMeaning || RATE_MEANING,
        arbitrageFee: safeArbitrage,
        updatedAt: configData.updatedAt?.toDate?.()?.toISOString() || null,
        updatedBy: configData.updatedBy || null,
      },
    });
  } catch (error) {
    console.error("Error getting customer rates config:", error);
    res.status(500).json({
      success: false,
      error: "Failed to get customer rates configuration",
      message: error.message,
    });
  }
});

/**
 * PUT /config/fees
 * Update customer rates (admin). Values = KES per 1 unit of currency.
 * Accepts currency keys ("ETB") or legacy ("USDT/ETB"). Persists both + metadata.
 */
app.put("/config/fees", requireAdmin, async (req, res) => {
  try {
    const adminId = req.adminId;

    const { currencyPair, buyRate, sellRate, rates } = req.body || {};

    const configRef = db.collection(config.collections.config).doc("customerRates");
    const configDoc = await configRef.get();
    const beforeData = configDoc.exists ? configDoc.data() : { rates: {} };

    /** @type {Record<string, { buyRate: number, sellRate: number }>} */
    const incoming = {};

    if (rates && typeof rates === "object") {
      for (const [pair, rateData] of Object.entries(rates)) {
        if (rateData && typeof rateData === "object") {
          const buy = Number(rateData.buyRate);
          const sell = Number(rateData.sellRate);

          if (isNaN(buy) || buy <= 0) {
            res.status(400).json({
              success: false,
              error: "Invalid request",
              message: `buyRate for ${pair} must be a positive number`,
            });
            return;
          }

          if (isNaN(sell) || sell <= 0) {
            res.status(400).json({
              success: false,
              error: "Invalid request",
              message: `sellRate for ${pair} must be a positive number`,
            });
            return;
          }

          incoming[pair] = {buyRate: buy, sellRate: sell};
        }
      }
    } else if (buyRate !== undefined || sellRate !== undefined) {
      const pair = currencyPair || `USDT/${BASE_CURRENCY}`;

      if (buyRate === undefined || sellRate === undefined) {
        res.status(400).json({
          success: false,
          error: "Invalid request",
          message: "Both buyRate and sellRate are required when updating a single pair",
        });
        return;
      }

      const buy = Number(buyRate);
      const sell = Number(sellRate);

      if (isNaN(buy) || buy <= 0) {
        res.status(400).json({
          success: false,
          error: "Invalid request",
          message: "buyRate must be a positive number",
        });
        return;
      }

      if (isNaN(sell) || sell <= 0) {
        res.status(400).json({
          success: false,
          error: "Invalid request",
          message: "sellRate must be a positive number",
        });
        return;
      }

      incoming[pair] = {buyRate: buy, sellRate: sell};
    } else {
      res.status(400).json({
        success: false,
        error: "Invalid request",
        message: "Either provide 'rates' object or 'buyRate' and 'sellRate' with optional 'currencyPair'",
      });
      return;
    }

    const normalized = normalizeRatesForStorage(incoming, beforeData.rates || {}, {
      rateVersion: beforeData.rateVersion,
    });
    const updateData = {
      rates: normalized.rates,
      baseCurrency: normalized.baseCurrency,
      rateMeaning: normalized.rateMeaning,
      rateVersion: normalized.rateVersion,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: adminId,
    };

    // Handle arbitrageFee update if present
    const { arbitrageFee } = req.body;
    if (arbitrageFee !== undefined) {
      const fee = Number(arbitrageFee);
      if (!isNaN(fee) && fee >= 0) {
        // Update config/fees document
        const feesRef = db.collection(config.collections.config).doc("fees");
        await feesRef.set({
          arbitrageFee: fee,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedBy: adminId,
        }, { merge: true });

        console.log(`✅ Admin ${adminId} updated arbitrage fee to ${fee}%`);
      }
    }

    // Replace `rates` map entirely (merge would leave stale pair keys)
    if (configDoc.exists) {
      await configRef.update(updateData);
    } else {
      await configRef.set(updateData);
    }

    const afterDoc = await configRef.get();
    const afterData = afterDoc.data();

    const { logAdminAction } = require("../utils/transactions");
    try {
      await logAdminAction(
        adminId,
        "system",
        "updateCustomerRates",
        beforeData,
        afterData,
      );
    } catch (logError) {
      console.error("Failed to log action:", logError.message);
    }

    console.log(`✅ Admin ${adminId} updated customer rates via REST API`, {
      currencies: listCurrenciesFromRates(updateData.rates),
    });

    res.status(200).json({
      success: true,
      data: {
        rates: afterData.rates || {},
        book: toCurrencyBook(afterData.rates || {}),
        baseCurrency: afterData.baseCurrency || BASE_CURRENCY,
        rateMeaning: afterData.rateMeaning || RATE_MEANING,
        updatedAt: afterData.updatedAt?.toDate?.()?.toISOString() || new Date().toISOString(),
        updatedBy: adminId,
      },
      message: "Customer rates updated successfully (KES per unit)",
    });
  } catch (error) {
    console.error("Error updating customer rates config:", error);
    res.status(500).json({
      success: false,
      error: "Failed to update customer rates configuration",
      message: error.message,
    });
  }
});

// Product pricing (Revenue Calculator) — admin CRUD + preview
mountProductPricingRoutes(app, {requireAdmin});

// Tourist Payments — funding layer (Paystack, merchant settlement)
mountFundingRoutes(app);
mountFundingOpsRoutes(app);

const paystackSecretKey = defineSecret(config.secrets.paystackSecretKey);
const paystackSplitCode = defineSecret(config.secrets.paystackSplitCode);
const transakApiKey = defineSecret(config.secrets.transakApiKey);
const transakSecretKey = defineSecret(config.secrets.transakSecretKey);
const transakTreasuryWallet = defineSecret(config.secrets.transakTreasuryWallet);

// Export as Firebase Function
exports.api = onRequest(
  {
    region: config.region,
    cpu: config.resources.cpu,
    memory: config.resources.memory,
    enforceAppCheck: true,
    secrets: [
      paystackSecretKey,
      paystackSplitCode,
      transakApiKey,
      transakSecretKey,
      transakTreasuryWallet,
      ...C2B_ENCRYPTION_SECRETS,
    ],
  },
  app,
);

