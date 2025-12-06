const {onRequest} = require("firebase-functions/v2/https");
const admin = require("./admin");
const express = require("express");

const db = admin.firestore();
const app = express();

// Middleware
app.use(express.json());

// CORS middleware - supports credentials
app.use((req, res, next) => {
  // Get the origin from the request
  const origin = req.headers.origin;
  
  // Allow credentials - set specific origin (can't use * with credentials)
  // Allow common Firebase hosting origins and localhost for development
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
  
  // Determine which origin to allow
  let allowedOrigin = "*";
  if (origin) {
    // If origin is in allowed list, use it
    if (allowedOrigins.includes(origin)) {
      allowedOrigin = origin;
    } else if (origin.includes("localhost") || origin.includes("127.0.0.1")) {
      // Allow any localhost for development
      allowedOrigin = origin;
    } else if (origin.includes("truepay-72060")) {
      // Allow any truepay-72060 subdomain
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
 * Query params: fiat (optional, default: "KES"), asset (optional, default: "USDT")
 */
app.get("/binance/rates", async (req, res) => {
  try {
    const {getBinanceRatesLogic} = require("./rates");
    const fiat = req.query.fiat || "KES";
    const asset = req.query.asset || "USDT";

    const result = await getBinanceRatesLogic(fiat, asset);

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
 * Reads from /users collection (new architecture) and /customerWallets (legacy)
 * Query params: limit (default: 100), offset (default: 0)
 */
app.get("/customer-wallets", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    // Helper function to format user data for frontend
    const formatUserData = (doc) => {
      const data = doc.data();
      const docId = doc.id;
      
      // Split name into firstName/lastName if needed
      let firstName = data.firstName || "";
      let lastName = data.lastName || "";
      if (!firstName && !lastName && data.name) {
        const nameParts = data.name.trim().split(" ");
        firstName = nameParts[0] || "";
        lastName = nameParts.slice(1).join(" ") || "";
      }

      return {
        id: docId,
        customerId: docId,
        firstName: firstName,
        lastName: lastName,
        email: data.email || "",
        phone: data.phoneNumber || data.phone || "",
        cryptoBalance: Number(data.cryptoBalance || data.balance || 0),
        fiatBalance: Number(data.fiatBalance || data.balance || 0),
        status: data.status || "Active",
        createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
        updatedAt: data.updatedAt?.toDate?.()?.toISOString() || null,
      };
    };

    // Try to read from /users collection first (new architecture)
    const usersRef = db.collection("users");
    let query = usersRef.orderBy("createdAt", "desc").limit(limit);

    if (offset > 0) {
      const offsetSnapshot = await usersRef
          .orderBy("createdAt", "desc")
          .limit(offset)
          .get();
      if (!offsetSnapshot.empty) {
        const lastDoc = offsetSnapshot.docs[offsetSnapshot.docs.length - 1];
        query = usersRef
            .orderBy("createdAt", "desc")
            .startAfter(lastDoc)
            .limit(limit);
      }
    }

    const snapshot = await query.get();
    let wallets = snapshot.docs.map(formatUserData);
    let total = snapshot.size;

    // If no users found, try legacy customerWallets collection
    if (wallets.length === 0) {
      const walletsRef = db.collection("customerWallets");
      let legacyQuery = walletsRef.orderBy("createdAt", "desc").limit(limit);

      if (offset > 0) {
        const offsetSnapshot = await walletsRef
            .orderBy("createdAt", "desc")
            .limit(offset)
            .get();
        if (!offsetSnapshot.empty) {
          const lastDoc = offsetSnapshot.docs[offsetSnapshot.docs.length - 1];
          legacyQuery = walletsRef
              .orderBy("createdAt", "desc")
              .startAfter(lastDoc)
              .limit(limit);
        }
      }

      const legacySnapshot = await legacyQuery.get();
      wallets = legacySnapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          customerId: doc.id,
          firstName: data.firstName || "",
          lastName: data.lastName || "",
          email: data.email || "",
          phone: data.phone || "",
          cryptoBalance: Number(data.cryptoBalance || 0),
          fiatBalance: Number(data.fiatBalance || data.balance || 0),
          status: data.status || "Active",
          createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
          updatedAt: data.updatedAt?.toDate?.()?.toISOString() || null,
        };
      });

      const totalSnapshot = await walletsRef.get();
      total = totalSnapshot.size;
    } else {
      // Get total count from users collection
      const totalSnapshot = await usersRef.get();
      total = totalSnapshot.size;
    }

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
 * 
 * Supports both:
 * - New architecture: /users/{uid} (Firebase Auth UIDs)
 * - Legacy architecture: /customerWallets/{id}
 */
app.get("/customer-wallets/:id", async (req, res) => {
  try {
    const {id} = req.params;
    
    // Try new architecture first: /users/{uid}
    const userDoc = await db.collection("users").doc(id).get();

    if (userDoc.exists) {
      // Found in users collection (new architecture)
      const userData = userDoc.data();
      
      // Split name into firstName/lastName if needed
      let firstName = userData.firstName || "";
      let lastName = userData.lastName || "";
      if (!firstName && !lastName && userData.name) {
        const nameParts = userData.name.trim().split(" ");
        firstName = nameParts[0] || "";
        lastName = nameParts.slice(1).join(" ") || "";
      }
      
      // Format response to match frontend structure
      const response = {
        id: userDoc.id,
        customerId: userDoc.id,
        firstName: firstName,
        lastName: lastName,
        email: userData.email || "",
        phone: userData.phoneNumber || userData.phone || "",
        cryptoBalance: Number(userData.cryptoBalance || 0),
        fiatBalance: Number(userData.fiatBalance || userData.balance || 0),
        status: userData.status || "Active",
        country: userData.country || null,
        kycStatus: userData.kycStatus || null,
        createdAt: userData.createdAt?.toDate?.()?.toISOString() || null,
        updatedAt: userData.updatedAt?.toDate?.()?.toISOString() || null,
      };

      res.status(200).json({
        success: true,
        data: response,
      });
      return;
    }

    // Fall back to legacy architecture: /customerWallets/{id}
    const walletDoc = await db.collection("customerWallets").doc(id).get();

    if (!walletDoc.exists) {
      res.status(404).json({
        success: false,
        error: "Customer wallet not found in users or customerWallets collection",
      });
      return;
    }

    const walletData = walletDoc.data();
    res.status(200).json({
      success: true,
      data: {
        id: walletDoc.id,
        ...walletData,
        createdAt: walletData.createdAt?.toDate?.()?.toISOString() || null,
        updatedAt: walletData.updatedAt?.toDate?.()?.toISOString() || null,
      },
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
 * Body: { firstName, lastName, name, email, phone, status, etc. }
 * 
 * Supports both:
 * - New architecture: /users/{uid} (Firebase Auth UIDs)
 * - Legacy architecture: /customerWallets/{id}
 */
app.put("/customer-wallets/:id", async (req, res) => {
  try {
    const {id} = req.params;
    let updateData = req.body;

    // Don't allow updating balance directly through this endpoint
    // Use credit/debit endpoints instead
    delete updateData.balance;
    delete updateData.id;
    delete updateData.createdAt;

    // Handle firstName/lastName - keep them separate for users collection
    // If name is provided, split it into firstName/lastName
    if (updateData.name && !updateData.firstName && !updateData.lastName) {
      const nameParts = updateData.name.trim().split(" ");
      updateData.firstName = nameParts[0] || "";
      updateData.lastName = nameParts.slice(1).join(" ") || "";
      delete updateData.name;
    }
    
    // Map phone -> phoneNumber for users collection
    if (updateData.phone && !updateData.phoneNumber) {
      updateData.phoneNumber = updateData.phone;
      delete updateData.phone;
    }

    // Add updatedAt timestamp
    updateData.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    // Try new architecture first: /users/{uid}
    let userRef = db.collection("users").doc(id);
    let userDoc = await userRef.get();
    let isUserCollection = false;

    if (userDoc.exists) {
      // Found in users collection (new architecture)
      isUserCollection = true;
      
      // Map status field if provided (users collection might not have status)
      if (updateData.status) {
        // Store status in a custom field or skip if not applicable
        // For now, we'll store it but users collection might not use status
        updateData.status = updateData.status;
      }

      await userRef.update(updateData);

      // Fetch updated document
      const updatedDoc = await userRef.get();
      const updatedData = updatedDoc.data();

      // Format response to match frontend structure
      let firstName = updatedData.firstName || "";
      let lastName = updatedData.lastName || "";
      if (!firstName && !lastName && updatedData.name) {
        const nameParts = updatedData.name.trim().split(" ");
        firstName = nameParts[0] || "";
        lastName = nameParts.slice(1).join(" ") || "";
      }

      const response = {
        id: updatedDoc.id,
        customerId: updatedDoc.id,
        firstName: firstName,
        lastName: lastName,
        email: updatedData.email || "",
        phone: updatedData.phoneNumber || updatedData.phone || "",
        cryptoBalance: Number(updatedData.cryptoBalance || 0),
        fiatBalance: Number(updatedData.fiatBalance || updatedData.balance || 0),
        status: updatedData.status || "Active",
        country: updatedData.country || null,
        kycStatus: updatedData.kycStatus || null,
        createdAt: updatedData.createdAt?.toDate?.()?.toISOString() || null,
        updatedAt: updatedData.updatedAt?.toDate?.()?.toISOString() || null,
      };

      res.status(200).json({
        success: true,
        data: response,
      });
      return;
    }

    // Fall back to legacy architecture: /customerWallets/{id}
    const walletRef = db.collection("customerWallets").doc(id);
    const walletDoc = await walletRef.get();

    if (!walletDoc.exists) {
      res.status(404).json({
        success: false,
        error: "Customer wallet not found in users or customerWallets collection",
      });
      return;
    }

    await walletRef.update(updateData);

    // Fetch updated document
    const updatedDoc = await walletRef.get();
    const updatedData = updatedDoc.data();

    res.status(200).json({
      success: true,
      data: {
        id: updatedDoc.id,
        ...updatedData,
        createdAt: updatedData.createdAt?.toDate?.()?.toISOString() || null,
        updatedAt: updatedData.updatedAt?.toDate?.()?.toISOString() || null,
      },
    });
  } catch (error) {
    console.error("Error updating customer wallet:", error);
    res.status(500).json({
      success: false,
      error: "Failed to update customer wallet",
      message: error.message,
    });
  }
});

/**
 * POST /customer-wallets/:id/credit
 * Credit money to a customer wallet
 * Body: { amount: number, description?: string }
 * 
 * Supports both:
 * - New architecture: /users/{uid} (uses updateBalanceWithTransaction)
 * - Legacy architecture: /customerWallets/{id}
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

    // Try new architecture first: /users/{uid}
    const userDoc = await db.collection("users").doc(id).get();

    if (userDoc.exists) {
      // Use Firestore transaction to update fiatBalance
      const userRef = db.collection("users").doc(id);
      const userData = userDoc.data();
      const currentFiatBalance = Number(userData.fiatBalance || 0);
      const currentBalance = Number(userData.balance || currentFiatBalance);
      const newFiatBalance = currentFiatBalance + amount;
      const newBalance = currentBalance + amount;

      // Update both fiatBalance and balance using Firestore transaction
      // balance field is used by balanceSync trigger and client apps
      await db.runTransaction(async (transaction) => {
        const doc = await transaction.get(userRef);
        if (!doc.exists) {
          throw new Error("User not found");
        }
        
        const currentData = doc.data();
        const currentFiatBalance = Number(currentData.fiatBalance || 0);
        const currentBalance = Number(currentData.balance || currentFiatBalance);
        const newFiatBalance = currentFiatBalance + amount;
        const newBalance = currentBalance + amount;
        
        transaction.update(userRef, {
          fiatBalance: newFiatBalance,
          balance: newBalance, // Also update balance field for sync trigger
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });

      // Log transaction
      const {logTransaction} = require("./utils/transactions");
      try {
        await logTransaction(
            id,
            "credit",
            amount,
            "completed",
            currentFiatBalance,
            newFiatBalance,
            {
              source: "admin_api",
              description: description || "Wallet credit",
              currency: "fiat",
            },
        );
      } catch (logError) {
        console.error("Failed to log transaction:", logError.message);
      }

      // Sync to Realtime DB (always sync, not conditional)
      const {syncBalanceToRealtime} = require("./utils/realtime");
      try {
        // Get currency from user data or default to USD for fiat balance
        const currency = updatedData.currency || updatedData.fiatCurrency || "USD";
        await syncBalanceToRealtime(id, newFiatBalance, currency);
      } catch (syncError) {
        console.error("Failed to sync to Realtime DB:", syncError.message);
      }

      // Fetch updated user
      const updatedDoc = await db.collection("users").doc(id).get();
      const updatedData = updatedDoc.data();

      // Format response
      let firstName = updatedData.firstName || "";
      let lastName = updatedData.lastName || "";
      if (!firstName && !lastName && updatedData.name) {
        const nameParts = updatedData.name.trim().split(" ");
        firstName = nameParts[0] || "";
        lastName = nameParts.slice(1).join(" ") || "";
      }

      res.status(200).json({
        success: true,
        data: {
          id: updatedDoc.id,
          customerId: updatedDoc.id,
          firstName: firstName,
          lastName: lastName,
          email: updatedData.email || "",
          phone: updatedData.phoneNumber || updatedData.phone || "",
          cryptoBalance: Number(updatedData.cryptoBalance || 0),
          fiatBalance: newFiatBalance,
          status: updatedData.status || "Active",
        },
        transaction: {
          type: "credit",
          amount,
          previousBalance: currentFiatBalance,
          newBalance: newFiatBalance,
        },
      });
      return;
    }

    // Fall back to legacy architecture: /customerWallets/{id}
    const walletRef = db.collection("customerWallets").doc(id);
    const walletDoc = await walletRef.get();

    if (!walletDoc.exists) {
      res.status(404).json({
        success: false,
        error: "Customer wallet not found in users or customerWallets collection",
      });
      return;
    }

    const currentBalance = walletDoc.data().balance || 0;
    const newBalance = currentBalance + amount;

    // Update balance
    await walletRef.update({
      balance: newBalance,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Create transaction record
    const transactionData = {
      walletId: id,
      type: "credit",
      amount,
      previousBalance: currentBalance,
      newBalance,
      description: description || "Wallet credit",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.collection("walletTransactions").add(transactionData);

    // Fetch updated wallet
    const updatedDoc = await walletRef.get();
    const updatedData = updatedDoc.data();

    res.status(200).json({
      success: true,
      data: {
        id: updatedDoc.id,
        ...updatedData,
        createdAt: updatedData.createdAt?.toDate?.()?.toISOString() || null,
        updatedAt: updatedData.updatedAt?.toDate?.()?.toISOString() || null,
      },
      transaction: {
        type: "credit",
        amount,
        previousBalance: currentBalance,
        newBalance,
      },
    });
  } catch (error) {
    console.error("Error crediting customer wallet:", error);
    res.status(500).json({
      success: false,
      error: "Failed to credit customer wallet",
      message: error.message,
    });
  }
});

/**
 * POST /customer-wallets/:id/debit
 * Debit money from a customer wallet
 * Body: { amount: number, description?: string }
 * 
 * Supports both:
 * - New architecture: /users/{uid} (uses updateBalanceWithTransaction)
 * - Legacy architecture: /customerWallets/{id}
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

    // Try new architecture first: /users/{uid}
    const userDoc = await db.collection("users").doc(id).get();

    if (userDoc.exists) {
      // Use Firestore transaction to update both fiatBalance and balance
      const userRef = db.collection("users").doc(id);
      const userData = userDoc.data();
      const currentFiatBalance = Number(userData.fiatBalance || 0);
      const currentBalance = Number(userData.balance || currentFiatBalance);

      if (currentFiatBalance < amount) {
        res.status(400).json({
          success: false,
          error: "Insufficient balance",
          currentBalance: currentFiatBalance,
          requestedAmount: amount,
        });
        return;
      }

      const newFiatBalance = currentFiatBalance - amount;
      const newBalance = currentBalance - amount;

      // Update both fiatBalance and balance using Firestore transaction
      // balance field is used by balanceSync trigger and client apps
      await db.runTransaction(async (transaction) => {
        const doc = await transaction.get(userRef);
        if (!doc.exists) {
          throw new Error("User not found");
        }
        
        const currentData = doc.data();
        const currentFiatBalance = Number(currentData.fiatBalance || 0);
        const currentBalance = Number(currentData.balance || currentFiatBalance);
        
        if (currentFiatBalance < amount) {
          throw new Error("Insufficient balance");
        }
        
        const newFiatBalance = currentFiatBalance - amount;
        const newBalance = currentBalance - amount;
        
        transaction.update(userRef, {
          fiatBalance: newFiatBalance,
          balance: newBalance, // Also update balance field for sync trigger
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });

      // Log transaction
      const {logTransaction} = require("./utils/transactions");
      try {
        await logTransaction(
            id,
            "debit",
            amount,
            "completed",
            currentFiatBalance,
            newFiatBalance,
            {
              source: "admin_api",
              description: description || "Wallet debit",
              currency: "fiat",
            },
        );
      } catch (logError) {
        console.error("Failed to log transaction:", logError.message);
      }

      // Sync to Realtime DB (always sync, not conditional)
      const {syncBalanceToRealtime} = require("./utils/realtime");
      try {
        // Get currency from user data or default to USD for fiat balance
        const currency = updatedData.currency || updatedData.fiatCurrency || "USD";
        await syncBalanceToRealtime(id, newFiatBalance, currency);
      } catch (syncError) {
        console.error("Failed to sync to Realtime DB:", syncError.message);
      }

      // Fetch updated user
      const updatedDoc = await db.collection("users").doc(id).get();
      const updatedData = updatedDoc.data();

      // Format response
      let firstName = updatedData.firstName || "";
      let lastName = updatedData.lastName || "";
      if (!firstName && !lastName && updatedData.name) {
        const nameParts = updatedData.name.trim().split(" ");
        firstName = nameParts[0] || "";
        lastName = nameParts.slice(1).join(" ") || "";
      }

      res.status(200).json({
        success: true,
        data: {
          id: updatedDoc.id,
          customerId: updatedDoc.id,
          firstName: firstName,
          lastName: lastName,
          email: updatedData.email || "",
          phone: updatedData.phoneNumber || updatedData.phone || "",
          cryptoBalance: Number(updatedData.cryptoBalance || 0),
          fiatBalance: newFiatBalance,
          status: updatedData.status || "Active",
        },
        transaction: {
          type: "debit",
          amount,
          previousBalance: currentFiatBalance,
          newBalance: newFiatBalance,
        },
      });
      return;
    }

    // Fall back to legacy architecture: /customerWallets/{id}
    const walletRef = db.collection("customerWallets").doc(id);
    const walletDoc = await walletRef.get();

    if (!walletDoc.exists) {
      res.status(404).json({
        success: false,
        error: "Customer wallet not found in users or customerWallets collection",
      });
      return;
    }

    const currentBalance = walletDoc.data().balance || 0;

    if (currentBalance < amount) {
      res.status(400).json({
        success: false,
        error: "Insufficient balance",
        currentBalance,
        requestedAmount: amount,
      });
      return;
    }

    const newBalance = currentBalance - amount;

    // Update balance
    await walletRef.update({
      balance: newBalance,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Create transaction record
    const transactionData = {
      walletId: id,
      type: "debit",
      amount,
      previousBalance: currentBalance,
      newBalance,
      description: description || "Wallet debit",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.collection("walletTransactions").add(transactionData);

    // Fetch updated wallet
    const updatedDoc = await walletRef.get();
    const updatedData = updatedDoc.data();

    res.status(200).json({
      success: true,
      data: {
        id: updatedDoc.id,
        ...updatedData,
        createdAt: updatedData.createdAt?.toDate?.()?.toISOString() || null,
        updatedAt: updatedData.updatedAt?.toDate?.()?.toISOString() || null,
      },
      transaction: {
        type: "debit",
        amount,
        previousBalance: currentBalance,
        newBalance,
      },
    });
  } catch (error) {
    console.error("Error debiting customer wallet:", error);
    res.status(500).json({
      success: false,
      error: "Failed to debit customer wallet",
      message: error.message,
    });
  }
});

/**
 * POST /customer-wallets
 * Create a new customer wallet
 * Body: { name, email, phone, initialBalance?: number }
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
    const existingSnapshot = await db.collection("customerWallets")
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

    const walletRef = await db.collection("customerWallets").add(walletData);
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
 * @param {Object} req - Express request object
 * @returns {Promise<{isAdmin: boolean, adminId: string | null}>}
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

    // Check if user is admin using same logic as callable functions
    const {isAdmin: checkIsAdmin} = require("./utils/validation");
    const adminDoc = await db.collection("users").doc(adminId).get();
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
    // Verify admin
    const {isAdmin: isAdminUser, adminId} = await verifyAdminFromRequest(req);
    if (!isAdminUser) {
      res.status(403).json({
        success: false,
        error: "Forbidden",
        message: "Admin access required",
      });
      return;
    }

    // Get commission configuration from Firestore
    const configRef = db.collection("config").doc("fees");
    const configDoc = await configRef.get();

    if (!configDoc.exists) {
      // Return default values if config doesn't exist
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
 * Body: { arbitrageFee?: number, serviceFee?: number }
 */
app.put("/config/fees", async (req, res) => {
  try {
    // Verify admin
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

    // Validate that at least one fee is provided
    if (arbitrageFee === undefined && serviceFee === undefined) {
      res.status(400).json({
        success: false,
        error: "Invalid request",
        message: "At least one fee (arbitrageFee or serviceFee) must be provided",
      });
      return;
    }

    // Get current config for logging
    const configRef = db.collection("config").doc("fees");
    const configDoc = await configRef.get();
    const beforeData = configDoc.exists ? configDoc.data() : {};

    // Prepare update data
    const updateData = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: adminId,
    };

    // Validate and add arbitrageFee if provided
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

    // Validate and add serviceFee if provided
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

    // Update or create config document
    await configRef.set(updateData, {merge: true});

    // Get updated data
    const afterDoc = await configRef.get();
    const afterData = afterDoc.data();

    // Log admin action
    const {logAdminAction} = require("./utils/transactions");
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
// Name it 'api' so the URL becomes /api/customer-wallets
// CORS is handled by Express middleware above
exports.api = onRequest(
    {
      region: "us-central1",
      cpu: 0.25,
      memory: "256MiB",
    },
    app,
);

