const {onDocumentUpdated} = require("firebase-functions/v2/firestore");
const {syncBalanceToRealtime} = require("./utils/realtime");

/**
 * Cloud Function: Firestore → Realtime Database Balance Sync
 * 
 * Triggered when a user document is updated in Firestore
 * If the balance field changes, syncs it to Realtime Database
 * 
 * This ensures Realtime DB always has the latest balance for instant UI updates
 * while Firestore remains the master source of truth
 */
exports.syncBalance = onDocumentUpdated(
    {
      document: "users/{uid}",
      region: "us-central1",
      cpu: 0.25,
      memory: "256MiB",
    },
    async (event) => {
      try {
        const uid = event.params.uid;
        const beforeData = event.data.before.data();
        const afterData = event.data.after.data();

        // Check both balance and fiatBalance fields
        // Prefer balance field, but fall back to fiatBalance if balance doesn't exist
        const beforeBalance = Number(beforeData.balance ?? beforeData.fiatBalance ?? 0);
        const afterBalance = Number(afterData.balance ?? afterData.fiatBalance ?? 0);

        // Only sync if balance actually changed
        if (beforeBalance === afterBalance) {
          console.log(`ℹ️ Balance unchanged for ${uid}, skipping sync`);
          return null;
        }

        // Get currency from user data (default to USD)
        const currency = afterData.currency || afterData.fiatCurrency || "USD";

        console.log(`🔄 Syncing balance change: ${uid}`, {
          before: beforeBalance,
          after: afterBalance,
          currency: currency,
          source: afterData.balance !== undefined ? "balance" : "fiatBalance",
        });

        // Sync to Realtime Database with retry logic
        let syncAttempts = 0;
        const maxRetries = 3;
        let lastError = null;

        while (syncAttempts < maxRetries) {
          try {
            await syncBalanceToRealtime(uid, afterBalance, currency);
            console.log(`✅ Balance synced to Realtime DB: ${uid}`, {
              balance: afterBalance,
              currency,
              attempts: syncAttempts + 1,
            });
            break; // Success, exit retry loop
          } catch (syncError) {
            syncAttempts++;
            lastError = syncError;
            console.warn(`⚠️ Sync attempt ${syncAttempts}/${maxRetries} failed for ${uid}:`, syncError.message);
            
            if (syncAttempts < maxRetries) {
              // Wait before retry (exponential backoff)
              await new Promise((resolve) => setTimeout(resolve, 1000 * syncAttempts));
            }
          }
        }

        if (syncAttempts >= maxRetries && lastError) {
          // All retries failed, log but don't throw
          console.error("❌ All sync retry attempts failed:", {
            userId: uid,
            error: lastError.message,
            attempts: maxRetries,
          });
          return {
            success: false,
            error: lastError.message,
            userId: uid,
          };
        }

        return {
          success: true,
          userId: uid,
          balance: afterBalance,
          currency,
        };
      } catch (error) {
        console.error("❌ Error in balance sync trigger:", {
          userId: event.params?.uid,
          error: error.message,
          stack: error.stack,
        });

        // Don't throw - this is a sync function, we don't want to fail the update
        return {
          success: false,
          error: error.message,
        };
      }
    },
);

