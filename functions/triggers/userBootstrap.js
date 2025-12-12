/**
 * @fileoverview Auth trigger for user bootstrap
 * Callable function to bootstrap user data after Firebase Authentication signup
 */

const {onCall, HttpsError} = require("firebase-functions/v2/https");
const admin = require("../admin");
const config = require("../config");
const {initializeBalanceInRealtime} = require("../utils/realtime");

const firestore = admin.firestore();

/**
 * Cloud Function: User Creation Bootstrap
 * Callable function to bootstrap user data after Firebase Authentication signup
 * 
 * Creates:
 * 1. User document in Firestore: /users/{uid}
 * 2. Balance mirror in Realtime DB: /balances/{uid}/balance
 * 
 * Ensures idempotency by checking if user document already exists
 */
exports.userBootstrap = onCall(
    {
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
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
        const userRef = firestore.collection(config.collections.users).doc(uid);
        const userDoc = await userRef.get();

        if (userDoc.exists) {
          console.log(`ℹ️ User document already exists: ${uid}, merging bootstrap data`);
          
          const existingData = userDoc.data();
          
          // Merge only missing fields (preserve existing data from frontend)
          const updates = {};
          
          // Only set email if not already present
          if (!existingData.email && email) {
            updates.email = email;
          }
          
          // Only set name if not already present and we have displayName
          if (!existingData.name && !existingData.firstName && displayName) {
            updates.name = displayName;
          }
          
          // Only set balance if not already present
          if (!("balance" in existingData) && existingData.balance === undefined) {
            updates.balance = 0;
          }
          
          // Only set country if not already present
          if (!("country" in existingData) && existingData.country === undefined) {
            updates.country = null;
          }
          
          // Only set createdAt if not already present
          if (!existingData.createdAt) {
            updates.createdAt = admin.firestore.FieldValue.serverTimestamp();
          }
          
          // Always update updatedAt
          updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
          
          // Only update if there are fields to add
          if (Object.keys(updates).length > 0) {
            await userRef.update(updates);
            console.log(`✅ Merged bootstrap data into existing user document: ${uid}`, {
              addedFields: Object.keys(updates),
            });
          }
          
          // Ensure Realtime DB balance exists
          const existingBalance = Number(existingData.balance || existingData.fiatBalance || 0);
          const currency = existingData.currency || existingData.fiatCurrency || "USD";
          
          try {
            await initializeBalanceInRealtime(uid, existingBalance, currency);
          } catch (rtdbError) {
            console.error("⚠️ Failed to sync existing balance to Realtime DB:", rtdbError.message);
          }
          
          return {
            success: true,
            userId: uid,
            message: "User already exists, data merged and balance synced",
          };
        }

        // Create user document in Firestore (only if it doesn't exist)
        // Use merge: true to preserve any data that might have been set concurrently
        const newUserData = {
          name: displayName || null,
          email: email,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          balance: 0,
          country: null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        // Use set with merge: true to preserve any existing fields
        await userRef.set(newUserData, {merge: true});

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

