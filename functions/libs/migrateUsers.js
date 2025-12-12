/**
 * @fileoverview User migration business logic
 * Pure business logic for migrating existing users
 */

const admin = require("../admin");
const config = require("../config");

const db = admin.firestore();

/**
 * Migrate existing users by adding default fields
 * @returns {Promise<Object>} Migration results
 */
async function migrateExistingUsers() {
  console.log("Starting user migration...");

  const usersRef = db.collection(config.collections.users);
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
}

module.exports = {
  migrateExistingUsers,
};

