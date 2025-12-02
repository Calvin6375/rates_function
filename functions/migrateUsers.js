const {onCall, HttpsError} = require("firebase-functions/v2/https");
const admin = require("./admin");

const db = admin.firestore();

/**
 * Callable function to migrate existing users
 * Adds default fields (fiatBalance, cryptoBalance, phoneNumber) to all existing users
 * 
 * Usage: Call this function once to update all existing users
 * This is a one-time migration function
 */
exports.migrateExistingUsers = onCall(async (request) => {
  try {
    // Optional: Add authentication check here
    // const auth = request.auth;
    // if (!auth || !auth.token.admin) {
    //   throw new HttpsError("permission-denied", "Only admins can run migrations");
    // }

    console.log("Starting user migration...");

    const usersRef = db.collection("users");
    const snapshot = await usersRef.get();

    if (snapshot.empty) {
      console.log("No users found to migrate");
      return {
        success: true,
        message: "No users found to migrate",
        totalUsers: 0,
        updatedUsers: 0,
        skippedUsers: 0,
      };
    }

    let updateCount = 0;
    let skipCount = 0;
    const batchSize = 500; // Firestore batch limit
    let currentBatch = db.batch();
    let batchOperationCount = 0;
    const batches = [];

    for (const doc of snapshot.docs) {
      const userData = doc.data();
      const updates = {};

      // Check if user needs migration
      const needsFiatBalance = !("fiatBalance" in userData) || 
                               userData.fiatBalance === null || 
                               userData.fiatBalance === undefined;
      const needsCryptoBalance = !("cryptoBalance" in userData) || 
                                 userData.cryptoBalance === null || 
                                 userData.cryptoBalance === undefined;
      const needsPhoneNumber = !("phoneNumber" in userData) || 
                               userData.phoneNumber === null || 
                               userData.phoneNumber === undefined;

      if (needsFiatBalance || needsCryptoBalance || needsPhoneNumber) {
        if (needsFiatBalance) updates.fiatBalance = 0;
        if (needsCryptoBalance) updates.cryptoBalance = 0;
        if (needsPhoneNumber) updates.phoneNumber = "";

        updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
        updates.migratedAt = admin.firestore.FieldValue.serverTimestamp();

        currentBatch.update(doc.ref, updates);
        batchOperationCount++;
        updateCount++;

        // Commit batch when we reach the limit
        if (batchOperationCount >= batchSize) {
          batches.push(currentBatch);
          currentBatch = db.batch();
          batchOperationCount = 0;
        }
      } else {
        skipCount++;
      }
    }

    // Commit remaining updates if any
    if (batchOperationCount > 0) {
      batches.push(currentBatch);
    }

    // Commit all batches
    for (const batch of batches) {
      await batch.commit();
    }

    console.log(`Migration complete: ${updateCount} users updated, ${skipCount} users skipped`);

    return {
      success: true,
      message: "Migration completed successfully",
      totalUsers: snapshot.size,
      updatedUsers: updateCount,
      skippedUsers: skipCount,
      batches: batches.length,
    };
  } catch (error) {
    console.error("Error during user migration:", error);
    throw new HttpsError(
        "internal",
        `Migration failed: ${error.message}`,
    );
  }
});

/**
 * HTTP endpoint version for migration (alternative to callable)
 * POST /migrateUsers
 */
const {onRequest} = require("firebase-functions/v2/https");
const express = require("express");
const migrateApp = express();

migrateApp.use(express.json());

// CORS middleware
migrateApp.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowedOrigins = [
    "https://truepay-72060.web.app",
    "https://truepay-72060.firebaseapp.com",
    "http://localhost:3000",
    "http://localhost:5173",
  ];
  const allowedOrigin = allowedOrigins.includes(origin) ? origin : "*";
  res.set("Access-Control-Allow-Origin", allowedOrigin);
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  next();
});

migrateApp.post("/migrateUsers", async (req, res) => {
  try {
    console.log("Starting user migration via HTTP...");

    const usersRef = db.collection("users");
    const snapshot = await usersRef.get();

    if (snapshot.empty) {
      return res.status(200).json({
        success: true,
        message: "No users found to migrate",
        totalUsers: 0,
        updatedUsers: 0,
        skippedUsers: 0,
      });
    }

    let updateCount = 0;
    let skipCount = 0;
    const batchSize = 500;
    let currentBatch = db.batch();
    let batchOperationCount = 0;
    const batches = [];

    for (const doc of snapshot.docs) {
      const userData = doc.data();
      const updates = {};

      const needsFiatBalance = !("fiatBalance" in userData) || 
                               userData.fiatBalance === null || 
                               userData.fiatBalance === undefined;
      const needsCryptoBalance = !("cryptoBalance" in userData) || 
                                 userData.cryptoBalance === null || 
                                 userData.cryptoBalance === undefined;
      const needsPhoneNumber = !("phoneNumber" in userData) || 
                               userData.phoneNumber === null || 
                               userData.phoneNumber === undefined;

      if (needsFiatBalance || needsCryptoBalance || needsPhoneNumber) {
        if (needsFiatBalance) updates.fiatBalance = 0;
        if (needsCryptoBalance) updates.cryptoBalance = 0;
        if (needsPhoneNumber) updates.phoneNumber = "";

        updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
        updates.migratedAt = admin.firestore.FieldValue.serverTimestamp();

        currentBatch.update(doc.ref, updates);
        batchOperationCount++;
        updateCount++;

        if (batchOperationCount >= batchSize) {
          batches.push(currentBatch);
          currentBatch = db.batch();
          batchOperationCount = 0;
        }
      } else {
        skipCount++;
      }
    }

    // Commit remaining updates if any
    if (batchOperationCount > 0) {
      batches.push(currentBatch);
    }

    // Commit all batches sequentially
    for (const batch of batches) {
      await batch.commit();
    }

    res.status(200).json({
      success: true,
      message: "Migration completed successfully",
      totalUsers: snapshot.size,
      updatedUsers: updateCount,
      skippedUsers: skipCount,
    });
  } catch (error) {
    console.error("Error during user migration:", error);
    res.status(500).json({
      success: false,
      error: "Migration failed",
      message: error.message,
    });
  }
});

exports.migrateUsersHttp = onRequest(migrateApp);

