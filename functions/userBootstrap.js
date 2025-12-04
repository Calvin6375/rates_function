const functions = require("firebase-functions/v1");
const admin = require("./admin");
const {initializeBalanceInRealtime} = require("./utils/realtime");

const firestore = admin.firestore();
const realtimeDb = admin.database();

/**
 * Cloud Function: User Creation Bootstrap
 * Triggered when a new user is created via Firebase Authentication
 * Uses auth.user().onCreate trigger (v1 style, required for auth triggers in v2 projects)
 * 
 * Creates:
 * 1. User document in Firestore: /users/{uid}
 * 2. Balance mirror in Realtime DB: /balances/{uid}/balance
 * 
 * Ensures idempotency by checking if user document already exists
 */
exports.userBootstrap = functions.auth.user().onCreate(async (user) => {
  try {
    const uid = user.uid;
    const email = user.email || null;
    const displayName = user.displayName || null;

    console.log(`🔄 Processing user creation bootstrap: ${uid}`, {
      email,
      displayName,
    });

    // Check if user document already exists (idempotency)
    const userRef = firestore.collection("users").doc(uid);
    const userDoc = await userRef.get();

    if (userDoc.exists) {
      console.log(`ℹ️ User document already exists: ${uid}, skipping bootstrap`);
      
      // Still ensure Realtime DB balance exists
      const existingData = userDoc.data();
      const existingBalance = Number(existingData.balance || 0);
      const currency = existingData.currency || existingData.fiatCurrency || "USD";
      
      try {
        await initializeBalanceInRealtime(uid, existingBalance, currency);
      } catch (rtdbError) {
        console.error("⚠️ Failed to sync existing balance to Realtime DB:", rtdbError.message);
      }
      
      return {
        success: true,
        userId: uid,
        message: "User already exists, balance synced",
      };
    }

    // Create user document in Firestore
    const userData = {
      name: displayName || null,
      email: email,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      balance: 0,
      country: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await userRef.set(userData);

    console.log(`✅ Created user document in Firestore: ${uid}`);

    // Create balance mirror in Realtime Database
    await initializeBalanceInRealtime(uid, 0);

    console.log(`✅ User bootstrap completed: ${uid}`, {
      firestore: "created",
      realtimeDb: "created",
    });

    return {
      success: true,
      userId: uid,
      firestore: "created",
      realtimeDb: "created",
    };
  } catch (error) {
    console.error("❌ Error in user bootstrap:", {
      userId: user?.uid || "unknown",
      error: error.message,
      stack: error.stack,
    });

    // Don't throw - we don't want to fail user creation if bootstrap fails
    // The user can still authenticate, and we can retry bootstrap later
    return {
      success: false,
      error: error.message,
    };
  }
});

