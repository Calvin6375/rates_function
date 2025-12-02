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
 * GET /customer-wallets
 * List all customer wallets with pagination
 * Query params: limit (default: 100), offset (default: 0)
 */
app.get("/customer-wallets", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const walletsRef = db.collection("customerWallets");
    let query = walletsRef.orderBy("createdAt", "desc").limit(limit);

    if (offset > 0) {
      // For offset, we need to skip documents
      // Note: Firestore doesn't support offset directly, so we'll fetch and skip
      const offsetSnapshot = await walletsRef
          .orderBy("createdAt", "desc")
          .limit(offset)
          .get();
      if (!offsetSnapshot.empty) {
        const lastDoc = offsetSnapshot.docs[offsetSnapshot.docs.length - 1];
        query = walletsRef
            .orderBy("createdAt", "desc")
            .startAfter(lastDoc)
            .limit(limit);
      }
    }

    const snapshot = await query.get();
    const wallets = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
      // Convert Firestore Timestamps to ISO strings for JSON
      createdAt: doc.data().createdAt?.toDate?.()?.toISOString() || null,
      updatedAt: doc.data().updatedAt?.toDate?.()?.toISOString() || null,
    }));

    // Get total count for pagination info
    const totalSnapshot = await walletsRef.get();
    const total = totalSnapshot.size;

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
    const walletDoc = await db.collection("customerWallets").doc(id).get();

    if (!walletDoc.exists) {
      res.status(404).json({
        success: false,
        error: "Customer wallet not found",
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
 * Body: { name, email, phone, status, etc. }
 */
app.put("/customer-wallets/:id", async (req, res) => {
  try {
    const {id} = req.params;
    const updateData = req.body;

    // Don't allow updating balance directly through this endpoint
    // Use credit/debit endpoints instead
    delete updateData.balance;
    delete updateData.id;
    delete updateData.createdAt;

    // Add updatedAt timestamp
    updateData.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    const walletRef = db.collection("customerWallets").doc(id);
    const walletDoc = await walletRef.get();

    if (!walletDoc.exists) {
      res.status(404).json({
        success: false,
        error: "Customer wallet not found",
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

    const walletRef = db.collection("customerWallets").doc(id);
    const walletDoc = await walletRef.get();

    if (!walletDoc.exists) {
      res.status(404).json({
        success: false,
        error: "Customer wallet not found",
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

    const walletRef = db.collection("customerWallets").doc(id);
    const walletDoc = await walletRef.get();

    if (!walletDoc.exists) {
      res.status(404).json({
        success: false,
        error: "Customer wallet not found",
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

// Export as Firebase Function
// Name it 'api' so the URL becomes /api/customer-wallets
// CORS is handled by Express middleware above
exports.api = onRequest(app);

