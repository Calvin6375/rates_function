/**
 * @fileoverview HTTP handlers for customer wallets REST API
 * Thin controllers that delegate to business logic in libs/userWallets.js
 */

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("../admin");
const express = require("express");
const config = require("../config");
const userWalletsLib = require("../libs/userWallets");
const ratesLib = require("../libs/rates");
const p2pListingsLib = require("../libs/p2pListings");

const db = admin.firestore();
const app = express();

// Middleware
app.use(express.json());

// CORS middleware - supports credentials
app.use((req, res, next) => {
  const origin = req.headers.origin;

  const allowedOrigins = [
    "https://truepay-72060.web.app",
    "https://truepay-72060.firebaseapp.com",
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
    } else if (origin.includes("truepay-72060")) {
      allowedOrigin = origin;
    }
  }

  res.set("Access-Control-Allow-Origin", allowedOrigin);
  res.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.set("Access-Control-Allow-Credentials", "true");
  res.set("Access-Control-Max-Age", "3600");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  next();
});

/**
 * GET /rates
 * Get all customer rates (view-only, public endpoint)
 * No authentication required - public access for displaying rates
 * 
 * Returns all configured customer rates (rate + commission combined) in Buy and Sell format
 */
app.get("/rates", async (req, res) => {
  try {
    // Get customer rates configuration from Firestore
    const configRef = db.collection(config.collections.config).doc("customerRates");
    const configDoc = await configRef.get();

    if (!configDoc.exists) {
      res.status(200).json({
        success: true,
        data: {
          rates: {},
        },
        message: "No rates configured yet",
      });
      return;
    }

    const configData = configDoc.data();
    const rates = configData.rates || {};

    // Include inverse pairs so e.g. USD/USDT works when only USDT/USD is configured
    const ratesWithInverses = { ...rates };
    for (const [pair, pairRates] of Object.entries(rates)) {
      if (!pairRates || typeof pairRates.buyRate !== "number" || typeof pairRates.sellRate !== "number") continue;
      if (!pair.includes("/")) continue;
      const [base, quote] = pair.split("/");
      const inversePair = `${quote}/${base}`;
      if (!ratesWithInverses[inversePair]) {
        ratesWithInverses[inversePair] = {
          buyRate: 1 / pairRates.sellRate,
          sellRate: 1 / pairRates.buyRate,
        };
      }
    }

    // Return all rates (public access)
    res.status(200).json({
      success: true,
      data: {
        rates: ratesWithInverses,
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
 * GET /customer-rates
 * Get customer rates (buyRate and sellRate) for Flutter app
 * Public endpoint - no authentication required
 * 
 * Query parameters:
 * - currencyPair (optional): e.g., "USDT/KES", defaults to "USDT/KES"
 * 
 * Returns the customer rates (rate + commission combined) for buying and selling
 */
app.get("/customer-rates", async (req, res) => {
  try {
    const currencyPair = req.query.currencyPair || `${config.binance.defaultAsset}/${config.binance.defaultFiat}`;

    // Get customer rates configuration from Firestore
    const configRef = db.collection(config.collections.config).doc("customerRates");
    const configDoc = await configRef.get();

    if (!configDoc.exists) {
      res.status(404).json({
        success: false,
        error: "Customer rates not configured",
        message: `No rates found for ${currencyPair}. Please configure rates in admin dashboard.`,
      });
      return;
    }

    const configData = configDoc.data();
    const rates = configData.rates || {};

    let pairRates = rates[currencyPair];
    let resolvedPair = currencyPair;

    // If exact pair not found, try inverse (e.g. USD/USDT when only USDT/USD is configured)
    if (!pairRates && currencyPair.includes("/")) {
      const [base, quote] = currencyPair.split("/");
      const inversePair = `${quote}/${base}`;
      const inverseRates = rates[inversePair];
      if (inverseRates && typeof inverseRates.buyRate === "number" && typeof inverseRates.sellRate === "number") {
        pairRates = {
          buyRate: 1 / inverseRates.sellRate,
          sellRate: 1 / inverseRates.buyRate,
        };
        resolvedPair = currencyPair;
      }
    }

    if (!pairRates || typeof pairRates.buyRate !== "number" || typeof pairRates.sellRate !== "number") {
      res.status(404).json({
        success: false,
        error: "Currency pair not found",
        message: `No rates configured for ${currencyPair}. Available pairs: ${Object.keys(rates).join(", ") || "none"}`,
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        currencyPair: resolvedPair,
        buyRate: pairRates.buyRate,
        sellRate: pairRates.sellRate,
        updatedAt: configData.updatedAt?.toDate?.()?.toISOString() || null,
      },
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
 */
app.get("/customer-wallets", async (req, res) => {
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
 */
app.get("/customer-wallets/:id", async (req, res) => {
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
 */
app.put("/customer-wallets/:id", async (req, res) => {
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
 */
app.post("/customer-wallets/:id/credit", async (req, res) => {
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
 */
app.post("/customer-wallets/:id/debit", async (req, res) => {
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
 */
app.post("/customer-wallets", async (req, res) => {
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
 * Helper: Verify admin from Firebase Auth token (for REST API)
 * Uses Custom Claims for better security and performance
 */
async function verifyAdminFromRequest(req) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return { isAdmin: false, adminId: null };
    }

    const token = authHeader.split("Bearer ")[1];
    const decodedToken = await admin.auth().verifyIdToken(token);
    const adminId = decodedToken.uid;

    // Check admin claim from token (faster, more secure)
    const isAdminUser = decodedToken.admin === true;

    return { isAdmin: isAdminUser, adminId: isAdminUser ? adminId : null };
  } catch (error) {
    console.error("Error verifying admin from request:", error.message);
    return { isAdmin: false, adminId: null };
  }
}

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
    // Verify user is authenticated (but don't require admin for reading)
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
        message: "Authentication required. Please provide a valid Firebase Auth token.",
      });
      return;
    }

    try {
      const token = authHeader.split("Bearer ")[1];
      await admin.auth().verifyIdToken(token);
      // Token is valid, proceed
    } catch (authError) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
        message: "Invalid or expired authentication token.",
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

    res.status(200).json({
      success: true,
      data: {
        rates: configData.rates || {}, // Object with currency pairs as keys
        arbitrageFee: arbitrageFee,
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
 * Update customer rates configuration (buyRate and sellRate)
 * Authentication: Required (any authenticated user can update)
 * 
 * Accepts customer rates (rate + commission combined) in Buy and Sell format.
 * Rates are stored per currency pair (e.g., "USDT/KES").
 * 
 * Request body format:
 * {
 *   "currencyPair": "USDT/KES",  // Optional: defaults to "USDT/KES"
 *   "buyRate": 129.50,            // Required: Customer rate for buying
 *   "sellRate": 128.00            // Required: Customer rate for selling
 * }
 * 
 * Or update multiple pairs:
 * {
 *   "rates": {
 *     "USDT/KES": { "buyRate": 129.50, "sellRate": 128.00 },
 *     "USDT/NGN": { "buyRate": 1500.00, "sellRate": 1480.00 }
 *   }
 * }
 */
app.put("/config/fees", async (req, res) => {
  try {
    // Verify user is authenticated (but don't require admin for updating rates)
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
        message: "Authentication required. Please provide a valid Firebase Auth token.",
      });
      return;
    }

    let userId = null;
    try {
      const token = authHeader.split("Bearer ")[1];
      const decodedToken = await admin.auth().verifyIdToken(token);
      userId = decodedToken.uid;
      // Token is valid, proceed
    } catch (authError) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
        message: "Invalid or expired authentication token.",
      });
      return;
    }

    const { currencyPair, buyRate, sellRate, rates } = req.body || {};

    // Get current config for logging
    const configRef = db.collection(config.collections.config).doc("customerRates");
    const configDoc = await configRef.get();
    const beforeData = configDoc.exists ? configDoc.data() : { rates: {} };

    const updateData = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: userId,
    };

    // Initialize rates object if it doesn't exist
    if (!updateData.rates) {
      updateData.rates = beforeData.rates || {};
    } else {
      updateData.rates = { ...beforeData.rates };
    }

    // Handle bulk update (rates object)
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

          updateData.rates[pair] = {
            buyRate: buy,
            sellRate: sell,
          };
        }
      }
    } else if (buyRate !== undefined || sellRate !== undefined) {
      // Handle single currency pair update
      const pair = currencyPair || `${config.binance.defaultAsset}/${config.binance.defaultFiat}`;

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

      updateData.rates[pair] = {
        buyRate: buy,
        sellRate: sell,
      };
    } else {
      res.status(400).json({
        success: false,
        error: "Invalid request",
        message: "Either provide 'rates' object or 'buyRate' and 'sellRate' with optional 'currencyPair'",
      });
      return;
    }

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
          updatedBy: userId,
        }, { merge: true });

        console.log(`✅ User ${userId} updated arbitrage fee to ${fee}%`);
      }
    }

    // Update the document
    await configRef.set(updateData, { merge: true });

    const afterDoc = await configRef.get();
    const afterData = afterDoc.data();

    // Log action (using logAdminAction for consistency, but any authenticated user can update)
    const { logAdminAction } = require("../utils/transactions");
    try {
      await logAdminAction(
        userId,
        "system",
        "updateCustomerRates",
        beforeData,
        afterData,
      );
    } catch (logError) {
      console.error("Failed to log action:", logError.message);
    }

    console.log(`✅ User ${userId} updated customer rates via REST API`, {
      rates: updateData.rates,
    });

    res.status(200).json({
      success: true,
      data: {
        rates: afterData.rates || {},
        updatedAt: afterData.updatedAt?.toDate?.()?.toISOString() || new Date().toISOString(),
        updatedBy: userId,
      },
      message: "Customer rates updated successfully",
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

// Export as Firebase Function
exports.api = onRequest(
  {
    region: config.region,
    cpu: config.resources.cpu,
    memory: config.resources.memory,
    enforceAppCheck: true,
  },
  app,
);

