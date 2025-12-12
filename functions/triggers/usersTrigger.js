/**
 * @fileoverview Firestore trigger for user document creation
 * Automatically initializes default wallet fields for new users
 */

const {onDocumentCreated} = require("firebase-functions/v2/firestore");
const admin = require("../admin");
const config = require("../config");

const db = admin.firestore();

/**
 * Firestore Trigger: When a new user document is created in the 'users' collection,
 * automatically add default wallet fields if they don't exist:
 * - fiatBalance: 0
 * - cryptoBalance: 0
 * - phoneNumber: "" (empty string)
 */
exports.onUserCreated = onDocumentCreated(
    {
      document: `${config.collections.users}/{userId}`,
      region: config.region,
      cpu: config.resources.cpu,
      memory: config.resources.memory,
    },
    async (event) => {
      try {
        const userId = event.params.userId;
        const userData = event.data.data();

        console.log(`Processing new user creation: ${userId}`, {
          hasFiatBalance: "fiatBalance" in userData,
          hasCryptoBalance: "cryptoBalance" in userData,
          hasPhoneNumber: "phoneNumber" in userData,
        });

        // Prepare default fields to add
        const updates = {};

        // Add fiatBalance if it doesn't exist or is null/undefined
        if (!("fiatBalance" in userData) || userData.fiatBalance === null || userData.fiatBalance === undefined) {
          updates.fiatBalance = 0;
        }

        // Add cryptoBalance if it doesn't exist or is null/undefined
        if (!("cryptoBalance" in userData) || userData.cryptoBalance === null || userData.cryptoBalance === undefined) {
          updates.cryptoBalance = 0;
        }

        // Add phoneNumber only if it doesn't exist (don't overwrite existing values, even if null/undefined)
        // This preserves phone numbers set by the frontend during registration
        if (!("phoneNumber" in userData)) {
          updates.phoneNumber = "";
        }

        // Only update if there are fields to add
        if (Object.keys(updates).length > 0) {
          // Add updatedAt timestamp
          updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();

          // Update the document with default values
          await db.collection(config.collections.users).doc(userId).update(updates);

          console.log(`✅ Successfully initialized default fields for user ${userId}`, {
            addedFields: Object.keys(updates),
          });

          return {
            success: true,
            userId,
            addedFields: Object.keys(updates),
          };
        } else {
          console.log(`ℹ️ User ${userId} already has all required fields, no update needed`);
          return {
            success: true,
            userId,
            message: "All fields already present",
          };
        }
      } catch (error) {
        console.error(`❌ Error initializing default fields for user:`, {
          userId: event.params.userId,
          error: error.message,
          stack: error.stack,
        });

        // Don't throw - we don't want to fail user creation if this fails
        // The fields can be added manually or on next update
        return {
          success: false,
          error: error.message,
        };
      }
    },
);

