/**
 * @fileoverview HTTP handlers for customer wallets REST API
 * Thin controllers that delegate to business logic in libs/userWallets.js
 */

const {onRequest} = require("firebase-functions/v2/https");
const admin = require("../admin");
const express = require("express");
const config = require("../config");
const userWalletsLib = require("../libs/userWallets");
const ratesLib = require("../libs/rates");

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
 * GET /customer-wallets
 * List all customer wallets with pagination
 */
app.get("/customer-wallets", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const {wallets, total} = await userWalletsLib.listCustomerWallets(limit, offset);

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
    const {id} = req.params;
    
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
    const {id} = req.params;
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
 */
app.post("/customer-wallets/:id/credit", async (req, res) => {
  try {
    const {id} = req.params;
    const {amount, description} = req.body;

    if (!amount || typeof amount !== "number" || amount <= 0) {
      res.status(400).json({
        success: false,
        error: "Invalid amount. Amount must be a positive number.",
      });
      return;
    }

    const result = await userWalletsLib.creditCustomerWallet(id, amount, description);

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
 */
app.post("/customer-wallets/:id/debit", async (req, res) => {
  try {
    const {id} = req.params;
    const {amount, description} = req.body;

    if (!amount || typeof amount !== "number" || amount <= 0) {
      res.status(400).json({
        success: false,
        error: "Invalid amount. Amount must be a positive number.",
      });
      return;
    }

    const result = await userWalletsLib.debitCustomerWallet(id, amount, description);

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
    const {name, email, phone, initialBalance = 0} = req.body;

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
 */
async function verifyAdminFromRequest(req) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return {isAdmin: false, adminId: null};
    }

    const token = authHeader.split("Bearer ")[1];
    const decodedToken = await admin.auth().verifyIdToken(token);
    const adminId = decodedToken.uid;

    // Check if user is admin
    const {isAdmin: checkIsAdmin} = require("../utils/validation");
    const adminDoc = await db.collection(config.collections.users).doc(adminId).get();
    if (!adminDoc.exists) {
      return {isAdmin: false, adminId: null};
    }

    const userData = adminDoc.data();
    const isAdminUser = checkIsAdmin(userData);

    return {isAdmin: isAdminUser, adminId: isAdminUser ? adminId : null};
  } catch (error) {
    console.error("Error verifying admin from request:", error.message);
    return {isAdmin: false, adminId: null};
  }
}

/**
 * GET /config/fees
 * Get current commission/fee configuration
 * Authentication: Required (Admin only)
 */
app.get("/config/fees", async (req, res) => {
  try {
    const {isAdmin: isAdminUser} = await verifyAdminFromRequest(req);
    if (!isAdminUser) {
      res.status(403).json({
        success: false,
        error: "Forbidden",
        message: "Admin access required",
      });
      return;
    }

    // Get commission configuration from Firestore
    const configRef = db.collection(config.collections.config).doc("fees");
    const configDoc = await configRef.get();

    if (!configDoc.exists) {
      res.status(200).json({
        success: true,
        data: {
          arbitrageFee: 1.5,
          serviceFee: 1.5,
        },
        message: "Using default commission values",
      });
      return;
    }

    const configData = configDoc.data();

    res.status(200).json({
      success: true,
      data: {
        arbitrageFee: configData.arbitrageFee || 1.5,
        serviceFee: configData.serviceFee || 1.5,
        updatedAt: configData.updatedAt?.toDate?.()?.toISOString() || null,
        updatedBy: configData.updatedBy || null,
      },
    });
  } catch (error) {
    console.error("Error getting commission config:", error);
    res.status(500).json({
      success: false,
      error: "Failed to get commission configuration",
      message: error.message,
    });
  }
});

/**
 * PUT /config/fees
 * Update commission/fee configuration
 * Authentication: Required (Admin only)
 */
app.put("/config/fees", async (req, res) => {
  try {
    const {isAdmin: isAdminUser, adminId} = await verifyAdminFromRequest(req);
    if (!isAdminUser || !adminId) {
      res.status(403).json({
        success: false,
        error: "Forbidden",
        message: "Admin access required",
      });
      return;
    }

    const {arbitrageFee, serviceFee} = req.body || {};

    if (arbitrageFee === undefined && serviceFee === undefined) {
      res.status(400).json({
        success: false,
        error: "Invalid request",
        message: "At least one fee (arbitrageFee or serviceFee) must be provided",
      });
      return;
    }

    const configRef = db.collection(config.collections.config).doc("fees");
    const configDoc = await configRef.get();
    const beforeData = configDoc.exists ? configDoc.data() : {};

    const updateData = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: adminId,
    };

    if (arbitrageFee !== undefined) {
      const feeValue = Number(arbitrageFee);
      if (isNaN(feeValue) || feeValue < 0 || feeValue > 100) {
        res.status(400).json({
          success: false,
          error: "Invalid request",
          message: "arbitrageFee must be a number between 0 and 100",
        });
        return;
      }
      updateData.arbitrageFee = feeValue;
    }

    if (serviceFee !== undefined) {
      const feeValue = Number(serviceFee);
      if (isNaN(feeValue) || feeValue < 0 || feeValue > 100) {
        res.status(400).json({
          success: false,
          error: "Invalid request",
          message: "serviceFee must be a number between 0 and 100",
        });
        return;
      }
      updateData.serviceFee = feeValue;
    }

    await configRef.set(updateData, {merge: true});

    const afterDoc = await configRef.get();
    const afterData = afterDoc.data();

    // Log admin action
    const {logAdminAction} = require("../utils/transactions");
    try {
      await logAdminAction(
          adminId,
          "system",
          "updateCommission",
          beforeData,
          afterData,
      );
    } catch (logError) {
      console.error("Failed to log admin action:", logError.message);
    }

    console.log(`✅ Admin ${adminId} updated commission configuration via REST API`, {
      arbitrageFee: updateData.arbitrageFee,
      serviceFee: updateData.serviceFee,
    });

    res.status(200).json({
      success: true,
      data: {
        arbitrageFee: afterData.arbitrageFee || 1.5,
        serviceFee: afterData.serviceFee || 1.5,
        updatedAt: afterData.updatedAt?.toDate?.()?.toISOString() || new Date().toISOString(),
        updatedBy: adminId,
      },
      message: "Commission configuration updated successfully",
    });
  } catch (error) {
    console.error("Error updating commission config:", error);
    res.status(500).json({
      success: false,
      error: "Failed to update commission configuration",
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
    },
    app,
);

