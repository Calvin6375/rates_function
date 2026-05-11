/**
 * @fileoverview Auth trigger for user bootstrap
 * Callable function to bootstrap user data after Firebase Authentication signup
 */

const {onCall, HttpsError} = require("firebase-functions/v2/https");
const admin = require("../admin");
const config = require("../config");
const {
  parseCustomerAppProvisioningFields,
} = require("../utils/customerAppProvisioning");

const firestore = admin.firestore();

/**
 * Cloud Function: User Creation Bootstrap
 * Callable function to bootstrap user data after Firebase Authentication signup
 *
 * Creates:
 * 1. User document in Firestore: /users/{uid}
 *
 * Ensures idempotency by checking if user document already exists.
 * Clients should listen to Firestore for real-time balance updates.
 */
exports.userBootstrap = onCall(
    {
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
      enforceAppCheck: true,
    },
    async (request) => {
      // Get the authenticated user from the request
      const auth = request.auth;
      if (!auth) {
        throw new HttpsError(
            "unauthenticated",
            "User must be authenticated to bootstrap account",
        );
      }

      const uid = auth.uid;

      let customerTagging = null;
      try {
        customerTagging = parseCustomerAppProvisioningFields(request.data);
      } catch (parseErr) {
        const msg = parseErr.message || "Invalid tagging";
        throw new HttpsError("invalid-argument", msg);
      }

      // Get user data from Firebase Auth
      let email = null;
      let displayName = null;
      try {
        const userRecord = await admin.auth().getUser(uid);
        email = userRecord.email || null;
        displayName = userRecord.displayName || null;
      } catch (authError) {
        console.warn(
            `⚠️ Could not fetch user record for ${uid}:`,
            authError.message,
        );
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
          console.log(
              `ℹ️ User document already exists: ${uid}, merging bootstrap data`,
          );

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
          const noBalance =
            !("balance" in existingData) && existingData.balance === undefined;
          if (noBalance) {
            updates.balance = 0;
          }

          // Only set country if not already present
          const noCountry =
            !("country" in existingData) && existingData.country === undefined;
          if (noCountry) {
            updates.country = null;
          }

          // Only set createdAt if not already present
          if (!existingData.createdAt) {
            updates.createdAt = admin.firestore.FieldValue.serverTimestamp();
          }

          if (customerTagging && !existingData.institution) {
            updates.institution = customerTagging.institution;
            updates.channel = customerTagging.channel;
          }

          // Always update updatedAt
          updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();

          // Only update if there are fields to add
          if (Object.keys(updates).length > 0) {
            await userRef.update(updates);
            const fields = Object.keys(updates);
            console.log(
                `✅ Merged bootstrap data into existing user document: ${uid}`,
                {addedFields: fields},
            );
          }

          // Balance only in Firestore; clients listen to Firestore.

          return {
            success: true,
            userId: uid,
            message:
                "User already exists, data merged and balance synced",
          };
        }

        // Create users/{uid} if missing. merge preserves concurrent writes.
        const newUserData = {
          name: displayName || null,
          email: email,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          balance: 0,
          country: null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        if (customerTagging) {
          newUserData.institution = customerTagging.institution;
          newUserData.channel = customerTagging.channel;
        }

        // Use set with merge: true to preserve any existing fields
        await userRef.set(newUserData, {merge: true});

        console.log(`✅ Created user document in Firestore: ${uid}`);

        // Balance is only in Firestore; clients listen to Firestore.

        console.log(`✅ User bootstrap completed: ${uid}`, {
          firestore: "created",
        });

        return {
          success: true,
          userId: uid,
          firestore: "created",
        };
      } catch (error) {
        console.error("❌ Error in user bootstrap:", {
          userId: uid,
          error: error.message,
          stack: error.stack,
        });

        // Throw HttpsError so client can handle it appropriately
        const detail = error.message;
        throw new HttpsError("internal", `Failed to bootstrap user: ${detail}`);
      }
    },
);

