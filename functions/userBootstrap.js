const {onCall, HttpsError} = require("firebase-functions/v2/https");
const admin = require("./admin");
const {initializeBalanceInRealtime} = require("./utils/realtime");

const firestore = admin.firestore();
const realtimeDb = admin.database();

/**
 * Cloud Function: User Creation Bootstrap
 * Callable function to bootstrap user data after Firebase Authentication signup
 * Can be called by the client after user creation, or triggered automatically
 * Uses v2 callable function (supports Node.js 22)
 * 
 * Creates:
 * 1. User document in Firestore: /users/{uid}
 * 2. Balance mirror in Realtime DB: /balances/{uid}/balance
 * 
 * Ensures idempotency by checking if user document already exists
 */
exports.userBootstrap = onCall(
    {
      region: "us-central1",
      cpu: 0.25,
      memory: "256MiB",
    },
    async (request) => {
      // Get the authenticated user from the request
      const auth = request.auth;
      if (!auth) {
        throw new HttpsError("unauthenticated", "User must be authenticated to bootstrap account");
      }

      const uid = auth.uid;
      
      // Get user data from Firebase Auth
      let email = null;
      let displayName = null;
      try {
        const userRecord = await admin.auth().getUser(uid);
        email = userRecord.email || null;
        displayName = userRecord.displayName || null;
      } catch (authError) {
        console.warn(`⚠️ Could not fetch user record for ${uid}:`, authError.message);
      }

      try {

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
        const newUserData = {
          name: displayName || null,
          email: email,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          balance: 0,
          country: null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        await userRef.set(newUserData);

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
          userId: uid,
          error: error.message,
          stack: error.stack,
        });

        // Throw HttpsError so client can handle it appropriately
        throw new HttpsError("internal", `Failed to bootstrap user: ${error.message}`);
      }
    },
);

