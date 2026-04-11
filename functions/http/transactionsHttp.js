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

/**
 * Sort key for `orders` docs (createdAt)
 * @param {FirebaseFirestore.DocumentData} data
 * @returns {number}
 */
function orderDocCreatedMs(data) {
  const c = data && data.createdAt;
  if (!c) {
    return 0;
  }
  if (typeof c.toDate === "function") {
    return c.toDate().getTime();
  }
  if (typeof c.toMillis === "function") {
    return c.toMillis();
  }
  return 0;
}

/**
 * Firestore composite index missing or still building
 * @param {Error} err
 * @returns {boolean}
 */
function isFirestoreIndexMissingError(err) {
  const code = err && err.code;
  const msg = err && err.message ? String(err.message) : "";
  return (
    code === 9 ||
    code === "failed-precondition" ||
    msg.includes("FAILED_PRECONDITION") ||
    msg.includes("requires an index")
  );
}

/**
 * Short label from Firebase UID for admin lists (avoids bare "Unknown User").
 * @param {string|null|undefined} uid
 * @returns {string}
 */
function displayNameFromUserId(uid) {
  if (!uid || typeof uid !== "string") {
    return "Unknown User";
  }
  return `User ${uid.slice(0, 8)}`;
}

/**
 * Best display name from users/{uid} or customerWallets/{id} document fields.
 * @param {Object|null|undefined} rec
 * @param {string|null|undefined} uid
 * @returns {string}
 */
function resolveClientDisplayName(rec, uid) {
  if (!rec || typeof rec !== "object") {
    return displayNameFromUserId(uid);
  }

  const trim = (s) => (typeof s === "string" ? s.trim() : "");

  const direct =
    trim(rec.name) ||
    trim(rec.displayName) ||
    trim(rec.fullName) ||
    trim(rec.username);

  if (direct) {
    return direct;
  }

  const fn = trim(rec.firstName);
  const ln = trim(rec.lastName);
  if (fn || ln) {
    return [fn, ln].filter(Boolean).join(" ");
  }

  const em = rec.email;
  if (typeof em === "string" && em.includes("@")) {
    const local = em.split("@")[0].trim();
    if (local) {
      return local;
    }
  }

  return displayNameFromUserId(uid);
}

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
 * Lists **direct top-up orders only** (`orders` where `orderType === "direct_topup"`).
 * Does not include IntaSend topups, swaps, credits, or wallet ledger rows.
 *
 * Query parameters:
 * - limit: number (default: 50, max: 200)
 * - startAfter: order document ID for pagination (last `id` from previous page)
 * - userId: filter by customer Firebase UID
 * - status: filter (pending, completed, …) applied after fetch
 * - currency: filter (USD, KES, …) applied after fetch
 * - startDate / endDate: ISO date filters applied after fetch
 *
 * Headers:
 * - Authorization: Bearer <Firebase Auth token> (Authentication required)
 */
app.get("/admin/transactions", async (req, res) => {
  try {
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
      userId: userIdFilter = null,
      status: statusFilter = null,
      currency: currencyFilter = null,
      startDate = null,
      endDate = null,
    } = req.query;

    const limit = Math.min(parseInt(String(limitParam), 10) || 50, 200);
    const fetchSize = Math.min(limit + 1, 201);

    try {
      const ordersCol = firestore.collection(config.collections.orders);

      let docs;
      let hasMore;

      try {
        let q = ordersCol
            .where("orderType", "==", "direct_topup")
            .orderBy("createdAt", "desc");

        if (userIdFilter && typeof userIdFilter === "string") {
          q = q.where("userId", "==", userIdFilter.trim());
        }

        if (startAfter && typeof startAfter === "string") {
          const cursor = await ordersCol.doc(startAfter.trim()).get();
          if (cursor.exists) {
            q = q.startAfter(cursor);
          }
        }

        q = q.limit(fetchSize);

        const snapshot = await q.get();
        hasMore = snapshot.docs.length > limit;
        docs = hasMore ? snapshot.docs.slice(0, limit) : snapshot.docs;
      } catch (queryErr) {
        if (!isFirestoreIndexMissingError(queryErr)) {
          throw queryErr;
        }
        console.warn(
            "admin/transactions: Firestore index missing or building;",
            "using single-field query + in-memory sort (deploy firestore:indexes).",
            queryErr.message,
        );
        const MAX_SCAN = 2000;
        const snap = await ordersCol
            .where("orderType", "==", "direct_topup")
            .limit(MAX_SCAN)
            .get();

        let rows = snap.docs.map((doc) => ({
          doc,
          ms: orderDocCreatedMs(doc.data()),
        }));

        if (userIdFilter && typeof userIdFilter === "string") {
          const uid = userIdFilter.trim();
          rows = rows.filter((r) => (r.doc.data().userId || "") === uid);
        }

        rows.sort((a, b) => b.ms - a.ms);

        let startIdx = -1;
        if (startAfter && typeof startAfter === "string") {
          startIdx = rows.findIndex((r) => r.doc.id === startAfter.trim());
        }
        const from = startIdx >= 0 ? startIdx + 1 : 0;
        const windowRows = rows.slice(from, from + fetchSize);
        hasMore = windowRows.length > limit;
        docs = (hasMore ? windowRows.slice(0, limit) : windowRows).map(
            (r) => r.doc,
        );
      }

      let orders = docs.map((doc) => {
        const d = doc.data();
        const created = d.createdAt?.toDate?.()?.toISOString?.() || null;
        return {
          id: doc.id,
          userId: d.userId || null,
          orderType: d.orderType,
          status: d.status || "unknown",
          amount: d.amount,
          currency: d.currency || "USD",
          referenceId: d.referenceId || null,
          phoneNumber: d.phoneNumber || null,
          metadata: d.metadata || {},
          createdAt: created,
          raw: d,
        };
      });

      if (statusFilter && typeof statusFilter === "string") {
        orders = orders.filter((o) => o.status === statusFilter);
      }
      if (currencyFilter && typeof currencyFilter === "string") {
        const c = String(currencyFilter).toUpperCase();
        orders = orders.filter(
            (o) => String(o.currency || "").toUpperCase() === c,
        );
      }
      if (startDate) {
        const start = new Date(startDate);
        orders = orders.filter((o) => {
          if (!o.createdAt) return false;
          return new Date(o.createdAt) >= start;
        });
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        orders = orders.filter((o) => {
          if (!o.createdAt) return false;
          return new Date(o.createdAt) <= end;
        });
      }

      const enrichedTransactions = await Promise.all(
          orders.map(async (orderRow) => {
            try {
              let userData = null;
              const uid = orderRow.userId;
              if (uid) {
                const userDoc = await firestore
                    .collection(config.collections.users)
                    .doc(uid)
                    .get();

                if (userDoc.exists) {
                  const user = userDoc.data();
                  userData = {
                    id: userDoc.id,
                    name: resolveClientDisplayName(user, userDoc.id),
                    email: user.email || null,
                    phoneNumber: user.phoneNumber || user.phone || null,
                  };
                } else {
                  const customerDoc = await firestore
                      .collection(config.collections.customerWallets)
                      .doc(uid)
                      .get();

                  if (customerDoc.exists) {
                    const customer = customerDoc.data();
                    userData = {
                      id: customerDoc.id,
                      name: resolveClientDisplayName(customer, customerDoc.id),
                      email: customer.email || null,
                      phoneNumber: customer.phone || customer.phoneNumber || null,
                    };
                  }
                }
              }

              const fallbackClientId = orderRow.userId || "unknown";
              return {
                id: orderRow.id,
                date: orderRow.createdAt,
                type: "direct_topup",
                client: userData
                  ? {
                      id: userData.id,
                      name: userData.name,
                      email: userData.email,
                      phoneNumber: userData.phoneNumber,
                    }
                  : {
                      id: fallbackClientId,
                      name: displayNameFromUserId(orderRow.userId),
                      email: null,
                      phoneNumber: null,
                    },
                amount: orderRow.amount != null ? Number(orderRow.amount) : 0,
                currency: orderRow.currency || "USD",
                status: orderRow.status || "unknown",
                reference:
                  orderRow.referenceId ||
                  orderRow.metadata.invoiceId ||
                  orderRow.id,
                previousBalance: null,
                newBalance: null,
                metadata: {
                  ...orderRow.metadata,
                  orderType: "direct_topup",
                  referenceId: orderRow.referenceId,
                },
                _full: orderRow.raw,
              };
            } catch (err) {
              console.error(`Error enriching order ${orderRow.id}:`, err.message);
              return {
                id: orderRow.id,
                date: orderRow.createdAt,
                type: "direct_topup",
                client: {
                  id: orderRow.userId || "unknown",
                  name: displayNameFromUserId(orderRow.userId),
                },
                amount: orderRow.amount != null ? Number(orderRow.amount) : 0,
                currency: orderRow.currency || "USD",
                status: orderRow.status || "unknown",
                reference: orderRow.referenceId || orderRow.id,
                metadata: orderRow.metadata || {},
                _full: orderRow.raw,
              };
            }
          }),
      );

      const lastId =
        enrichedTransactions.length > 0
          ? enrichedTransactions[enrichedTransactions.length - 1].id
          : null;

      res.status(200).json({
        success: true,
        data: {
          transactions: enrichedTransactions,
          pagination: {
            limit,
            count: enrichedTransactions.length,
            total: enrichedTransactions.length,
            hasMore,
            startAfter: lastId,
          },
        },
      });
    } catch (error) {
      console.error("Error fetching direct top-up orders:", error);
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
