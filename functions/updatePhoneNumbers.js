const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {onRequest} = require("firebase-functions/v2/https");
const admin = require("./admin");
const express = require("express");

const db = admin.firestore();

/**
 * Callable function to update phone numbers only
 * Sets phoneNumber to empty string for users that don't have it
 * 
 * Usage: Call this function to update phone numbers for all existing users
 */
exports.updatePhoneNumbers = onCall(async (request) => {
  try {
    console.log("Starting phone number update...");

    const usersRef = db.collection("users");
    const snapshot = await usersRef.get();

    if (snapshot.empty) {
      console.log("No users found to update");
      return {
        success: true,
        message: "No users found to update",
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
      
      // Check if user needs phone number update
      const needsPhoneNumber = !("phoneNumber" in userData) || 
                               userData.phoneNumber === null || 
                               userData.phoneNumber === undefined;

      if (needsPhoneNumber) {
        const updates = {
          phoneNumber: "",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

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

    console.log(`Phone number update complete: ${updateCount} users updated, ${skipCount} users skipped`);

    return {
      success: true,
      message: "Phone number update completed successfully",
      totalUsers: snapshot.size,
      updatedUsers: updateCount,
      skippedUsers: skipCount,
      batches: batches.length,
    };
  } catch (error) {
    console.error("Error during phone number update:", error);
    throw new HttpsError(
        "internal",
        `Phone number update failed: ${error.message}`,
    );
  }
});

/**
 * HTTP endpoint version for phone number update (alternative to callable)
 * POST /updatePhoneNumbers
 */
const updatePhoneApp = express();

updatePhoneApp.use(express.json());

// CORS middleware
updatePhoneApp.use((req, res, next) => {
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

updatePhoneApp.post("/updatePhoneNumbers", async (req, res) => {
  try {
    console.log("Starting phone number update via HTTP...");

    const usersRef = db.collection("users");
    const snapshot = await usersRef.get();

    if (snapshot.empty) {
      return res.status(200).json({
        success: true,
        message: "No users found to update",
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
      
      const needsPhoneNumber = !("phoneNumber" in userData) || 
                               userData.phoneNumber === null || 
                               userData.phoneNumber === undefined;

      if (needsPhoneNumber) {
        const updates = {
          phoneNumber: "",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

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
      message: "Phone number update completed successfully",
      totalUsers: snapshot.size,
      updatedUsers: updateCount,
      skippedUsers: skipCount,
      batches: batches.length,
    });
  } catch (error) {
    console.error("Error during phone number update:", error);
    res.status(500).json({
      success: false,
      error: "Phone number update failed",
      message: error.message,
    });
  }
});

exports.updatePhoneNumbersHttp = onRequest(updatePhoneApp);

