/**
 * @fileoverview Phone number update business logic
 * Pure business logic for updating phone numbers
 */

const admin = require("../admin");
const config = require("../config");

const db = admin.firestore();

/**
 * Update phone numbers for all existing users
 * Sets phoneNumber to empty string for users that don't have it
 * @returns {Promise<Object>} Update results
 */
async function updatePhoneNumbers() {
  console.log("Starting phone number update...");

  const usersRef = db.collection(config.collections.users);
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
}

module.exports = {
  updatePhoneNumbers,
};

