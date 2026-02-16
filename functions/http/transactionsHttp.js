/**
 * @fileoverview HTTP handlers for transactions history endpoint
 * Supports querying from both Firestore and Realtime Database
 */

const {onRequest} = require("firebase-functions/v2/https");
const admin = require("../admin");
const express = require("express");
const config = require("../config");

const firestore = admin.firestore();
const rtdb = admin.database();
const app = express();

// Middleware
app.use(express.json());

// CORS middleware
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
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Allow-Credentials", "true");
  res.set("Access-Control-Max-Age", "3600");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  next();
});

/**
 * Helper: Verify Firebase Auth token and get user ID
 * @param {Object} req - Express request object
 * @returns {Promise<{success: boolean, userId: string|null, error: string|null, decodedToken?: Object}>}
 */
async function verifyAuthToken(req) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return {success: false, userId: null, error: "Missing authorization header"};
    }

    const token = authHeader.split("Bearer ")[1];
    const decodedToken = await admin.auth().verifyIdToken(token);

    return {success: true, userId: decodedToken.uid, decodedToken, error: null};
  } catch (error) {
    console.error("Error verifying auth token:", error.message);
    return {success: false, userId: null, error: "Invalid or expired token"};
  }
}

/**
 * Query transactions from Firestore
 * @param {string} userId - User ID
 * @param {Object} options - Query options (limit, startAfter, type, status)
 * @returns {Promise<Array>} Array of transactions
 */
async function getTransactionsFromFirestore(userId, options = {}) {
  const {
    limit = 50,
    startAfter = null,
    type = null,
    status = null,
  } = options;

  try {
    // Query user transactions subcollection
    let query = firestore
        .collection(config.collections.transactions)
        .doc(userId)
        .collection("transactions")
        .orderBy("timestamp", "desc")
        .limit(limit);

    // Apply filters
    if (type) {
      query = query.where("type", "==", type);
    }
    if (status) {
      query = query.where("status", "==", status);
    }

    // Apply pagination cursor
    if (startAfter) {
      const startAfterDoc = await firestore
          .collection(config.collections.transactions)
          .doc(userId)
          .collection("transactions")
          .doc(startAfter)
          .get();

      if (startAfterDoc.exists) {
        query = query.startAfter(startAfterDoc);
      }
    }

    const snapshot = await query.get();
    const transactionsCol = config.collections.transactions || "transactions";
    const queryPath = `${transactionsCol}/${userId}/transactions`;
    if (snapshot.empty && !type && !status) {
      console.log("GET /transactions: 0 docs from Firestore path " + queryPath + " (orderBy timestamp desc)");
    }

    // Also check walletTransactions collection for this user
    let walletTxQuery = firestore
        .collection("walletTransactions")
        .where("userId", "==", userId)
        .orderBy("createdAt", "desc")
        .limit(limit);

    if (type) {
      walletTxQuery = walletTxQuery.where("type", "==", type);
    }

    const walletTxSnapshot = await walletTxQuery.get();

    // Combine and format transactions
    const transactions = [];

    // Add transactions from user subcollection
    snapshot.forEach((doc) => {
      const data = doc.data();
      transactions.push({
        id: doc.id,
        ...data,
        timestamp: data.timestamp?.toDate?.()?.toISOString() || null,
        source: "firestore",
      });
    });

    // Add transactions from walletTransactions collection
    walletTxSnapshot.forEach((doc) => {
      const data = doc.data();
      // Avoid duplicates (check if transaction ID already exists)
      const exists = transactions.some((tx) => tx.id === doc.id);
      if (!exists) {
        transactions.push({
          id: doc.id,
          ...data,
          timestamp: data.createdAt?.toDate?.()?.toISOString() || null,
          createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
          source: "firestore",
        });
      }
    });

    // Sort by timestamp descending and apply limit
    transactions.sort((a, b) => {
      const timeA = new Date(a.timestamp || a.createdAt || 0).getTime();
      const timeB = new Date(b.timestamp || b.createdAt || 0).getTime();
      return timeB - timeA;
    });

    return transactions.slice(0, limit);
  } catch (error) {
    console.error("Error querying Firestore transactions:", error);
    throw error;
  }
}

/**
 * Query transactions from Realtime Database
 * @param {string} userId - User ID
 * @param {Object} options - Query options (limit)
 * @returns {Promise<Array>} Array of transactions
 */
async function getTransactionsFromRealtimeDatabase(userId, options = {}) {
  const {limit = 50} = options;

  try {
    // Try common Realtime Database paths for transactions
    const paths = [
      `wallet/${userId}/transactions`,
      `transactions/${userId}`,
      `wallet/${userId}/history`,
    ];

    let transactions = [];

    // Try each path
    for (const path of paths) {
      try {
        const snapshot = await rtdb.ref(path).once("value");
        const data = snapshot.val();

        if (data) {
          // Convert object to array
          const txArray = Object.entries(data).map(([id, tx]) => ({
            id,
            ...tx,
            source: "realtime",
          }));

          transactions = [...transactions, ...txArray];
        }
      } catch (pathError) {
        // Path doesn't exist, continue to next path
        continue;
      }
    }

    // Sort by timestamp descending and apply limit
    transactions.sort((a, b) => {
      const timeA = (a.timestamp || a.createdAt || 0);
      const timeB = (b.timestamp || b.createdAt || 0);
      return timeB - timeA;
    });

    return transactions.slice(0, limit);
  } catch (error) {
    console.error("Error querying Realtime Database transactions:", error);
    // Don't throw - Realtime DB might not have transactions
    return [];
  }
}

/**
 * GET /transactions
 * Get transaction history for authenticated user
 * Supports querying from both Firestore and Realtime Database
 * 
 * Query parameters:
 * - source: "firestore" | "realtime" | "both" (default: "both")
 * - limit: number (default: 50, max: 100)
 * - startAfter: transaction ID for pagination
 * - type: filter by transaction type (credit, debit, etc.)
 * - status: filter by status (completed, pending, failed)
 * 
 * Headers:
 * - Authorization: Bearer <Firebase Auth token>
 */
app.get("/transactions", async (req, res) => {
  try {
    // Verify authentication
    const authResult = await verifyAuthToken(req);
    if (!authResult.success) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
        message: authResult.error || "Authentication required",
      });
      return;
    }

    const userId = authResult.userId;
    const source = req.query.source || "both"; // firestore, realtime, or both
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const startAfter = req.query.startAfter || null;
    const type = req.query.type || null;
    const status = req.query.status || null;

    const options = {
      limit,
      startAfter,
      type,
      status,
    };

    let transactions = [];
    let sources = [];

    // Query based on source preference
    if (source === "firestore" || source === "both") {
      try {
        const firestoreTxs = await getTransactionsFromFirestore(userId, options);
        transactions = [...transactions, ...firestoreTxs];
        sources.push("firestore");
      } catch (error) {
        console.error("Error fetching from Firestore:", error);
        if (source === "firestore") {
          // If only Firestore requested and it fails, return error
          res.status(500).json({
            success: false,
            error: "Failed to fetch transactions from Firestore",
            message: error.message,
          });
          return;
        }
        // If "both", continue to try Realtime DB
      }
    }

    if (source === "realtime" || source === "both") {
      try {
        const rtdbTxs = await getTransactionsFromRealtimeDatabase(userId, {limit});
        transactions = [...transactions, ...rtdbTxs];
        if (rtdbTxs.length > 0) {
          sources.push("realtime");
        }
      } catch (error) {
        console.error("Error fetching from Realtime Database:", error);
        // Don't fail if Realtime DB doesn't have transactions
      }
    }

    // Remove duplicates (same transaction ID) and sort
    const uniqueTransactions = [];
    const seenIds = new Set();

    transactions.forEach((tx) => {
      if (!seenIds.has(tx.id)) {
        seenIds.add(tx.id);
        uniqueTransactions.push(tx);
      }
    });

    // Sort by timestamp descending
    uniqueTransactions.sort((a, b) => {
      const timeA = new Date(a.timestamp || a.createdAt || 0).getTime();
      const timeB = new Date(b.timestamp || b.createdAt || 0).getTime();
      return timeB - timeA;
    });

    // Apply limit after deduplication
    const limitedTransactions = uniqueTransactions.slice(0, limit);

    // Get last transaction ID for pagination
    const lastTransactionId = limitedTransactions.length > 0
      ? limitedTransactions[limitedTransactions.length - 1].id
      : null;

    res.status(200).json({
      success: true,
      data: {
        transactions: limitedTransactions,
        pagination: {
          limit,
          count: limitedTransactions.length,
          hasMore: limitedTransactions.length === limit,
          startAfter: lastTransactionId,
        },
        sources: sources,
      },
    });
  } catch (error) {
    console.error("Error in /transactions endpoint:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
      message: error.message,
    });
  }
});

/**
 * GET /transactions/:transactionId
 * Get a specific transaction by ID
 * Searches in both Firestore and Realtime Database
 * 
 * Headers:
 * - Authorization: Bearer <Firebase Auth token>
 */
app.get("/transactions/:transactionId", async (req, res) => {
  try {
    // Verify authentication
    const authResult = await verifyAuthToken(req);
    if (!authResult.success) {
      res.status(401).json({
        success: false,
        error: "Unauthorized",
        message: authResult.error || "Authentication required",
      });
      return;
    }

    const userId = authResult.userId;
    const transactionId = req.params.transactionId;

    // Try Firestore first
    try {
      // Check user transactions subcollection
      const txDoc = await firestore
          .collection(config.collections.transactions)
          .doc(userId)
          .collection("transactions")
          .doc(transactionId)
          .get();

      if (txDoc.exists) {
        const data = txDoc.data();
        return res.status(200).json({
          success: true,
          data: {
            ...data,
            id: txDoc.id,
            timestamp: data.timestamp?.toDate?.()?.toISOString() || null,
            source: "firestore",
          },
        });
      }

      // Check walletTransactions collection
      const walletTxDoc = await firestore
          .collection("walletTransactions")
          .doc(transactionId)
          .get();

      if (walletTxDoc.exists) {
        const data = walletTxDoc.data();
        // Verify it belongs to the user
        if (data.userId === userId) {
          return res.status(200).json({
            success: true,
            data: {
              ...data,
              id: walletTxDoc.id,
              timestamp: data.createdAt?.toDate?.()?.toISOString() || null,
              createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
              source: "firestore",
            },
          });
        }
      }
    } catch (firestoreError) {
      console.error("Error querying Firestore:", firestoreError);
    }

    // Try Realtime Database
    try {
      const paths = [
        `wallet/${userId}/transactions/${transactionId}`,
        `transactions/${userId}/${transactionId}`,
        `wallet/${userId}/history/${transactionId}`,
      ];

      for (const path of paths) {
        const snapshot = await rtdb.ref(path).once("value");
        const data = snapshot.val();

        if (data) {
          return res.status(200).json({
            success: true,
            data: {
              ...data,
              id: transactionId,
              source: "realtime",
            },
          });
        }
      }
    } catch (rtdbError) {
      console.error("Error querying Realtime Database:", rtdbError);
    }

    // Transaction not found
    res.status(404).json({
      success: false,
      error: "Transaction not found",
      message: `Transaction ${transactionId} not found for user ${userId}`,
    });
  } catch (error) {
    console.error("Error in /transactions/:transactionId endpoint:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
      message: error.message,
    });
  }
});

/**
 * GET /admin/transactions
 * Get all transaction histories for dashboard
 * Supports filtering, pagination, and includes client information
 * 
 * Query parameters:
 * - limit: number (default: 50, max: 200)
 * - startAfter: transaction ID for pagination
 * - userId: filter by specific user ID
 * - type: filter by transaction type (credit, debit, topup, etc.)
 * - status: filter by status (completed, pending, failed)
 * - currency: filter by currency (USD, KES, USDT, etc.)
 * - startDate: filter from date (ISO format)
 * - endDate: filter to date (ISO format)
 * 
 * Headers:
 * - Authorization: Bearer <Firebase Auth token> (Authentication required)
 */
app.get("/admin/transactions", async (req, res) => {
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

    const {
      limit: limitParam = 50,
      startAfter = null,
      userId = null,
      type = null,
      status = null,
      currency = null,
      startDate = null,
      endDate = null,
    } = req.query;

    const limit = Math.min(parseInt(limitParam) || 50, 200);

    try {
      // Collect all transactions from all users
      const allTransactions = [];

      // Strategy 1: Query transactions subcollection for all users
      // Get all user documents first
      const usersSnapshot = await firestore.collection(config.collections.users).limit(500).get();
      const userIds = usersSnapshot.docs.map((doc) => doc.id);

      // Query transactions for each user
      const transactionPromises = userIds.map(async (uid) => {
        try {
          let query = firestore
              .collection(config.collections.transactions)
              .doc(uid)
              .collection("transactions")
              .orderBy("timestamp", "desc")
              .limit(limit * 2); // Get more to account for filtering

          // Apply filters
          if (type) {
            query = query.where("type", "==", type);
          }
          if (status) {
            query = query.where("status", "==", status);
          }
          if (currency) {
            query = query.where("currency", "==", currency);
          }
          if (userId && uid !== userId) {
            return []; // Skip if filtering by specific user
          }

          const snapshot = await query.get();
          const transactions = snapshot.docs.map((doc) => ({
            id: doc.id,
            userId: uid,
            ...doc.data(),
            timestamp: doc.data().timestamp?.toDate?.()?.toISOString() || null,
          }));

          return transactions;
        } catch (error) {
          console.error(`Error fetching transactions for user ${uid}:`, error.message);
          return [];
        }
      });

      const transactionArrays = await Promise.all(transactionPromises);
      allTransactions.push(...transactionArrays.flat());

      // Strategy 2: Also query walletTransactions collection
      try {
        let walletTxQuery = firestore
            .collection("walletTransactions")
            .orderBy("createdAt", "desc")
            .limit(limit * 2);

        if (userId) {
          walletTxQuery = walletTxQuery.where("userId", "==", userId);
        }
        if (type) {
          walletTxQuery = walletTxQuery.where("type", "==", type);
        }
        if (currency) {
          walletTxQuery = walletTxQuery.where("currency", "==", currency);
        }

        const walletTxSnapshot = await walletTxQuery.get();
        walletTxSnapshot.forEach((doc) => {
          const data = doc.data();
          // Avoid duplicates
          const exists = allTransactions.some((tx) => tx.id === doc.id);
          if (!exists) {
            allTransactions.push({
              id: doc.id,
              ...data,
              timestamp: data.createdAt?.toDate?.()?.toISOString() || null,
              createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
            });
          }
        });
      } catch (walletTxError) {
        console.error("Error querying walletTransactions:", walletTxError.message);
      }

      // Apply date filters if provided
      let filteredTransactions = allTransactions;
      if (startDate) {
        const start = new Date(startDate);
        filteredTransactions = filteredTransactions.filter((tx) => {
          const txDate = new Date(tx.timestamp || tx.createdAt || 0);
          return txDate >= start;
        });
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999); // End of day
        filteredTransactions = filteredTransactions.filter((tx) => {
          const txDate = new Date(tx.timestamp || tx.createdAt || 0);
          return txDate <= end;
        });
      }

      // Sort by timestamp descending
      filteredTransactions.sort((a, b) => {
        const timeA = new Date(a.timestamp || a.createdAt || 0).getTime();
        const timeB = new Date(b.timestamp || b.createdAt || 0).getTime();
        return timeB - timeA;
      });

      // Apply limit after filtering
      let limitedTransactions = filteredTransactions.slice(0, limit);

      // Fetch user/client information for each transaction
      const enrichedTransactions = await Promise.all(
          limitedTransactions.map(async (tx) => {
            try {
              let userData = null;
              if (tx.userId) {
                const userDoc = await firestore
                    .collection(config.collections.users)
                    .doc(tx.userId)
                    .get();

                if (userDoc.exists) {
                  const user = userDoc.data();
                  userData = {
                    id: userDoc.id,
                    name: user.name || user.displayName || "Unknown User",
                    email: user.email || null,
                    phoneNumber: user.phoneNumber || user.phone || null,
                  };
                } else {
                  // Try customerWallets collection
                  const customerDoc = await firestore
                      .collection(config.collections.customerWallets)
                      .doc(tx.userId)
                      .get();

                  if (customerDoc.exists) {
                    const customer = customerDoc.data();
                    userData = {
                      id: customerDoc.id,
                      name: customer.name || "Unknown Customer",
                      email: customer.email || null,
                      phoneNumber: customer.phone || customer.phoneNumber || null,
                    };
                  }
                }
              }

              return {
                id: tx.id,
                date: tx.timestamp || tx.createdAt || null,
                type: tx.type || "unknown",
                client: userData
                  ? {
                      id: userData.id,
                      name: userData.name,
                      email: userData.email,
                      phoneNumber: userData.phoneNumber,
                    }
                  : {id: tx.userId || "unknown", name: "Unknown User"},
                amount: tx.amount || 0,
                currency: tx.currency || "USD",
                status: tx.status || "unknown",
                reference: tx.id || tx.metadata?.paymentId || tx.metadata?.invoiceId || null,
                previousBalance: tx.previousBalance || null,
                newBalance: tx.newBalance || null,
                metadata: tx.metadata || {},
                // Include full transaction data for reference
                _full: tx,
              };
            } catch (error) {
              console.error(`Error enriching transaction ${tx.id}:`, error.message);
              // Return basic transaction data if enrichment fails
              return {
                id: tx.id,
                date: tx.timestamp || tx.createdAt || null,
                type: tx.type || "unknown",
                client: {id: tx.userId || "unknown", name: "Unknown User"},
                amount: tx.amount || 0,
                currency: tx.currency || "USD",
                status: tx.status || "unknown",
                reference: tx.id || null,
                previousBalance: tx.previousBalance || null,
                newBalance: tx.newBalance || null,
                metadata: tx.metadata || {},
                _full: tx,
              };
            }
          }),
      );

      // Get last transaction ID for pagination
      const lastTransactionId = enrichedTransactions.length > 0
        ? enrichedTransactions[enrichedTransactions.length - 1].id
        : null;

      res.status(200).json({
        success: true,
        data: {
          transactions: enrichedTransactions,
          pagination: {
            limit,
            count: enrichedTransactions.length,
            total: filteredTransactions.length,
            hasMore: filteredTransactions.length > limit,
            startAfter: lastTransactionId,
          },
        },
      });
    } catch (error) {
      console.error("Error fetching all transactions:", error);
      res.status(500).json({
        success: false,
        error: "Internal server error",
        message: error.message,
      });
    }
  } catch (error) {
    console.error("Error in /admin/transactions endpoint:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
      message: error.message,
    });
  }
});

// Export as Firebase Function
exports.transactionsApi = onRequest(
    {
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
      enforceAppCheck: false, // Allow without App Check for Flutter apps
      minInstances: 0,
    },
    app,
);
