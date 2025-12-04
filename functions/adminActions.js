const {onCall, HttpsError} = require("firebase-functions/v2/https");
const admin = require("./admin");
const {updateBalanceWithTransaction, getUserBalance, userExists} = require("./utils/firestore");
const {syncBalanceToRealtime} = require("./utils/realtime");
const {logAdminAction} = require("./utils/transactions");
const {validateBalanceUpdate, isAdmin} = require("./utils/validation");

const firestore = admin.firestore();

/**
 * Helper: Verify admin role
 * @param {string} adminId - Admin user ID
 * @returns {Promise<boolean>} True if user is admin
 */
async function verifyAdmin(adminId) {
  try {
    const adminDoc = await firestore.collection("users").doc(adminId).get();
    if (!adminDoc.exists) {
      return false;
    }
    return isAdmin(adminDoc.data());
  } catch (error) {
    console.error("Error verifying admin:", error.message);
    return false;
  }
}

/**
 * Callable Function: Update User Profile
 * Admin-only function to update user profile fields
 * 
 * @param {Object} request.data - Request data
 * @param {string} request.data.userId - Target user ID
 * @param {Object} request.data.updates - Fields to update (name, email, country, etc.)
 * @param {string} request.auth.uid - Admin user ID (from auth context)
 */
exports.updateUserProfile = onCall(async (request) => {
  try {
    const adminId = request.auth?.uid;
    if (!adminId) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }

    // Verify admin role
    const isAdminUser = await verifyAdmin(adminId);
    if (!isAdminUser) {
      throw new HttpsError("permission-denied", "Admin access required");
    }

    const {userId, updates} = request.data || {};

    if (!userId) {
      throw new HttpsError("invalid-argument", "userId is required");
    }

    if (!updates || typeof updates !== "object") {
      throw new HttpsError("invalid-argument", "updates object is required");
    }

    // Check if user exists
    const exists = await userExists(userId);
    if (!exists) {
      throw new HttpsError("not-found", `User ${userId} not found`);
    }

    // Get current user data for logging
    const userRef = firestore.collection("users").doc(userId);
    const userDoc = await userRef.get();
    const beforeData = userDoc.data();

    // Prepare allowed fields (prevent balance updates through this function)
    const allowedFields = ["name", "email", "country", "phoneNumber", "kycStatus", "kycData"];
    const sanitizedUpdates = {};

    for (const key of Object.keys(updates)) {
      if (allowedFields.includes(key)) {
        sanitizedUpdates[key] = updates[key];
      }
    }

    if (Object.keys(sanitizedUpdates).length === 0) {
      throw new HttpsError("invalid-argument", "No valid fields to update");
    }

    // Add updatedAt timestamp
    sanitizedUpdates.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    // Update user document
    await userRef.update(sanitizedUpdates);

    // Get updated data for logging
    const afterDoc = await userRef.get();
    const afterData = afterDoc.data();

    // Log admin action
    await logAdminAction(
        adminId,
        userId,
        "updateProfile",
        beforeData,
        afterData,
    );

    console.log(`✅ Admin ${adminId} updated profile for user ${userId}`);

    return {
      success: true,
      userId,
      updatedFields: Object.keys(sanitizedUpdates),
    };
  } catch (error) {
    console.error("❌ Error updating user profile:", {
      adminId: request.auth?.uid,
      userId: request.data?.userId,
      error: error.message,
    });

    if (error instanceof HttpsError) {
      throw error;
    }

    throw new HttpsError("internal", `Failed to update profile: ${error.message}`);
  }
});

/**
 * Callable Function: Update User Balance
 * Admin-only function to update user balance
 * Uses Firestore transactions to ensure atomicity
 * 
 * @param {Object} request.data - Request data
 * @param {string} request.data.userId - Target user ID
 * @param {number} request.data.amount - Amount to add (positive) or subtract (negative)
 * @param {string} request.data.reason - Reason for balance update (optional)
 * @param {string} request.auth.uid - Admin user ID
 */
exports.updateUserBalance = onCall(async (request) => {
  try {
    const adminId = request.auth?.uid;
    if (!adminId) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }

    // Verify admin role
    const isAdminUser = await verifyAdmin(adminId);
    if (!isAdminUser) {
      throw new HttpsError("permission-denied", "Admin access required");
    }

    const {userId, amount, reason} = request.data || {};

    // Validate request
    const validation = validateBalanceUpdate({userId, amount});
    if (!validation.valid) {
      throw new HttpsError("invalid-argument", validation.error);
    }

    const amountDelta = Number(amount);

    // Get current balance for logging
    const beforeBalance = await getUserBalance(userId);

    // Get user document to extract currency
    const userDoc = await firestore.collection("users").doc(userId).get();
    if (!userDoc.exists) {
      throw new HttpsError("not-found", `User ${userId} not found`);
    }
    const userData = userDoc.data();
    const currency = userData.currency || userData.fiatCurrency || "USD";

    // Update balance using transaction
    const result = await updateBalanceWithTransaction(
        userId,
        amountDelta,
        amountDelta > 0 ? "credit" : "debit",
        {
          source: "admin",
          adminId,
          reason: reason || "Admin balance adjustment",
          allowNegative: true, // Admins can set negative balances if needed
        },
    );

    // Sync to Realtime DB with currency
    await syncBalanceToRealtime(userId, result.newBalance, currency);

    // Log admin action
    await logAdminAction(
        adminId,
        userId,
        "updateBalance",
        {balance: beforeBalance},
        {balance: result.newBalance, amountDelta},
    );

    console.log(`✅ Admin ${adminId} updated balance for user ${userId}`, {
      amountDelta,
      previousBalance: result.previousBalance,
      newBalance: result.newBalance,
    });

    return {
      success: true,
      userId,
      previousBalance: result.previousBalance,
      newBalance: result.newBalance,
      amountDelta,
      transactionId: result.transactionId,
    };
  } catch (error) {
    console.error("❌ Error updating user balance:", {
      adminId: request.auth?.uid,
      userId: request.data?.userId,
      error: error.message,
    });

    if (error instanceof HttpsError) {
      throw error;
    }

    throw new HttpsError("internal", `Failed to update balance: ${error.message}`);
  }
});

/**
 * Callable Function: Get User Data
 * Admin-only function to retrieve user data
 * 
 * @param {Object} request.data - Request data
 * @param {string} request.data.userId - Target user ID
 * @param {string} request.auth.uid - Admin user ID
 */
exports.getUserData = onCall(async (request) => {
  try {
    const adminId = request.auth?.uid;
    if (!adminId) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }

    // Verify admin role
    const isAdminUser = await verifyAdmin(adminId);
    if (!isAdminUser) {
      throw new HttpsError("permission-denied", "Admin access required");
    }

    const {userId} = request.data || {};

    if (!userId) {
      throw new HttpsError("invalid-argument", "userId is required");
    }

    // Get user document
    const userDoc = await firestore.collection("users").doc(userId).get();

    if (!userDoc.exists) {
      throw new HttpsError("not-found", `User ${userId} not found`);
    }

    const userData = userDoc.data();

    // Return user data (excluding sensitive fields if needed)
    return {
      success: true,
      userId,
      userData: {
        ...userData,
        // Ensure balance is a number
        balance: Number(userData.balance || 0),
      },
    };
  } catch (error) {
    console.error("❌ Error getting user data:", {
      adminId: request.auth?.uid,
      userId: request.data?.userId,
      error: error.message,
    });

    if (error instanceof HttpsError) {
      throw error;
    }

    throw new HttpsError("internal", `Failed to get user data: ${error.message}`);
  }
});

/**
 * Callable Function: Update KYC Status
 * Admin-only function to update user KYC status
 * 
 * @param {Object} request.data - Request data
 * @param {string} request.data.userId - Target user ID
 * @param {string} request.data.kycStatus - New KYC status (pending, approved, rejected)
 * @param {Object} request.data.kycData - Additional KYC data (optional)
 * @param {string} request.auth.uid - Admin user ID
 */
exports.updateKYCStatus = onCall(async (request) => {
  try {
    const adminId = request.auth?.uid;
    if (!adminId) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }

    // Verify admin role
    const isAdminUser = await verifyAdmin(adminId);
    if (!isAdminUser) {
      throw new HttpsError("permission-denied", "Admin access required");
    }

    const {userId, kycStatus, kycData} = request.data || {};

    if (!userId) {
      throw new HttpsError("invalid-argument", "userId is required");
    }

    if (!kycStatus) {
      throw new HttpsError("invalid-argument", "kycStatus is required");
    }

    const validStatuses = ["pending", "approved", "rejected", "under_review"];
    if (!validStatuses.includes(kycStatus)) {
      throw new HttpsError("invalid-argument", `Invalid KYC status. Must be one of: ${validStatuses.join(", ")}`);
    }

    // Check if user exists
    const exists = await userExists(userId);
    if (!exists) {
      throw new HttpsError("not-found", `User ${userId} not found`);
    }

    // Get current user data for logging
    const userRef = firestore.collection("users").doc(userId);
    const userDoc = await userRef.get();
    const beforeData = userDoc.data();

    // Update KYC status
    const updateData = {
      kycStatus,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (kycData) {
      updateData.kycData = kycData;
    }

    await userRef.update(updateData);

    // Get updated data for logging
    const afterDoc = await userRef.get();
    const afterData = afterDoc.data();

    // Log admin action
    await logAdminAction(
        adminId,
        userId,
        "updateKYC",
        {kycStatus: beforeData.kycStatus, kycData: beforeData.kycData},
        {kycStatus: afterData.kycStatus, kycData: afterData.kycData},
    );

    console.log(`✅ Admin ${adminId} updated KYC status for user ${userId}`, {
      kycStatus,
    });

    return {
      success: true,
      userId,
      kycStatus,
    };
  } catch (error) {
    console.error("❌ Error updating KYC status:", {
      adminId: request.auth?.uid,
      userId: request.data?.userId,
      error: error.message,
    });

    if (error instanceof HttpsError) {
      throw error;
    }

    throw new HttpsError("internal", `Failed to update KYC status: ${error.message}`);
  }
});

