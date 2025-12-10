const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const admin = require("./admin");
const axios = require("axios");
const {updateBalanceWithTransaction, getUserBalance, userExists} = require("./utils/firestore");
const {syncBalanceToRealtime} = require("./utils/realtime");
const {logAdminAction} = require("./utils/transactions");
const {validateBalanceUpdate, isAdmin} = require("./utils/validation");

const firestore = admin.firestore();

// IntaSend API configuration
const intaSendSecretKey = defineSecret("INTASEND_SECRET_KEY");
const intaSendPublishableKey = defineSecret("INTASEND_PUBLISHABLE_KEY");

/**
 * Get IntaSend API keys
 * @returns {{secretKey: string|null, publishableKey: string|null}}
 */
function getIntaSendKeys() {
  const secretKey = intaSendSecretKey.value() || process.env.INTASEND_SECRET_KEY || null;
  const publishableKey = intaSendPublishableKey.value() || process.env.INTASEND_PUBLISHABLE_KEY || null;
  return {secretKey, publishableKey};
}

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
exports.updateUserProfile = onCall(
    {
      region: "us-central1",
      cpu: 0.25,
      memory: "256MiB",
    },
    async (request) => {
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
exports.updateUserBalance = onCall(
    {
      region: "us-central1",
      cpu: 0.25,
      memory: "256MiB",
    },
    async (request) => {
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

    // Get user document AFTER update to ensure we have latest currency
    const userDoc = await firestore.collection("users").doc(userId).get();
    if (!userDoc.exists) {
      throw new HttpsError("not-found", `User ${userId} not found`);
    }
    const userData = userDoc.data();
    const currency = userData.currency || userData.fiatCurrency || "USD";

    // Sync to Realtime DB with currency (with retry on failure)
    try {
      await syncBalanceToRealtime(userId, result.newBalance, currency);
      console.log(`✅ Successfully synced balance to Realtime DB: ${userId}`);
    } catch (syncError) {
      // Log error but don't fail the admin action - the Cloud Function trigger will retry
      console.error(`⚠️ Failed to sync balance to Realtime DB (will retry via trigger):`, {
        userId,
        error: syncError.message,
      });
      // The balanceSync Cloud Function will handle the sync automatically
    }

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
exports.getUserData = onCall(
    {
      region: "us-central1",
      cpu: 0.25,
      memory: "256MiB",
    },
    async (request) => {
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
exports.updateKYCStatus = onCall(
    {
      region: "us-central1",
      cpu: 0.25,
      memory: "256MiB",
    },
    async (request) => {
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

/**
 * Callable Function: Sync User Balance to Realtime DB (Manual)
 * Admin-only function to manually sync user balance to Realtime Database
 * Useful for fixing discrepancies between Firestore and Realtime DB
 * 
 * @param {Object} request.data - Request data
 * @param {string} request.data.userId - Target user ID
 * @param {string} request.auth.uid - Admin user ID
 */
exports.syncUserBalanceToRealtime = onCall(
    {
      region: "us-central1",
      cpu: 0.25,
      memory: "256MiB",
    },
    async (request) => {
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

    // Get user document from Firestore (source of truth)
    const userDoc = await firestore.collection("users").doc(userId).get();

    if (!userDoc.exists) {
      throw new HttpsError("not-found", `User ${userId} not found`);
    }

    const userData = userDoc.data();
    const balance = Number(userData.balance || 0);
    const currency = userData.currency || userData.fiatCurrency || "USD";

    // Sync to Realtime DB
    await syncBalanceToRealtime(userId, balance, currency);

    console.log(`✅ Admin ${adminId} manually synced balance for user ${userId}`, {
      balance,
      currency,
    });

    return {
      success: true,
      userId,
      balance,
      currency,
      message: "Balance synced successfully",
    };
  } catch (error) {
    console.error("❌ Error manually syncing balance:", {
      adminId: request.auth?.uid,
      userId: request.data?.userId,
      error: error.message,
    });

    if (error instanceof HttpsError) {
      throw error;
    }

    throw new HttpsError("internal", `Failed to sync balance: ${error.message}`);
  }
});

/**
 * Callable Function: Get Commission Configuration
 * Admin-only function to retrieve current commission/fee settings
 * 
 * @param {Object} request.data - Request data (empty, no parameters needed)
 * @param {string} request.auth.uid - Admin user ID
 */
exports.getCommissionConfig = onCall(
    {
      region: "us-central1",
      cpu: 0.25,
      memory: "256MiB",
    },
    async (request) => {
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

    // Get commission configuration from Firestore
    const configRef = firestore.collection("config").doc("fees");
    const configDoc = await configRef.get();

    if (!configDoc.exists) {
      // Return default values if config doesn't exist
      return {
        success: true,
        config: {
          arbitrageFee: 1.5, // Default 1.5%
          serviceFee: 1.5, // Default 1.5%
        },
        message: "Using default commission values (config document not found)",
      };
    }

    const configData = configDoc.data();

    return {
      success: true,
      config: {
        arbitrageFee: configData.arbitrageFee || 1.5,
        serviceFee: configData.serviceFee || 1.5,
        updatedAt: configData.updatedAt?.toMillis?.() || null,
      },
    };
  } catch (error) {
    console.error("❌ Error getting commission config:", {
      adminId: request.auth?.uid,
      error: error.message,
    });

    if (error instanceof HttpsError) {
      throw error;
    }

    throw new HttpsError("internal", `Failed to get commission config: ${error.message}`);
  }
});

/**
 * Callable Function: Update Commission Configuration
 * Admin-only function to update commission/fee settings
 * 
 * @param {Object} request.data - Request data
 * @param {number} request.data.arbitrageFee - Arbitrage fee percentage (e.g., 1.5 for 1.5%)
 * @param {number} request.data.serviceFee - Service fee percentage (optional, e.g., 1.5 for 1.5%)
 * @param {string} request.auth.uid - Admin user ID
 */
exports.updateCommissionConfig = onCall(
    {
      region: "us-central1",
      cpu: 0.25,
      memory: "256MiB",
    },
    async (request) => {
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

    const {arbitrageFee, serviceFee} = request.data || {};

    // Validate that at least one fee is provided
    if (arbitrageFee === undefined && serviceFee === undefined) {
      throw new HttpsError("invalid-argument", "At least one fee (arbitrageFee or serviceFee) must be provided");
    }

    // Get current config for logging
    const configRef = firestore.collection("config").doc("fees");
    const configDoc = await configRef.get();
    const beforeData = configDoc.exists ? configDoc.data() : {};

    // Prepare update data
    const updateData = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: adminId,
    };

    // Validate and add arbitrageFee if provided
    if (arbitrageFee !== undefined) {
      const feeValue = Number(arbitrageFee);
      if (isNaN(feeValue) || feeValue < 0 || feeValue > 100) {
        throw new HttpsError("invalid-argument", "arbitrageFee must be a number between 0 and 100");
      }
      updateData.arbitrageFee = feeValue;
    }

    // Validate and add serviceFee if provided
    if (serviceFee !== undefined) {
      const feeValue = Number(serviceFee);
      if (isNaN(feeValue) || feeValue < 0 || feeValue > 100) {
        throw new HttpsError("invalid-argument", "serviceFee must be a number between 0 and 100");
      }
      updateData.serviceFee = feeValue;
    }

    // Update or create config document
    await configRef.set(updateData, {merge: true});

    // Get updated data for logging
    const afterDoc = await configRef.get();
    const afterData = afterDoc.data();

    // Log admin action
    await logAdminAction(
        adminId,
        "system",
        "updateCommission",
        beforeData,
        afterData,
    );

    console.log(`✅ Admin ${adminId} updated commission configuration`, {
      arbitrageFee: updateData.arbitrageFee,
      serviceFee: updateData.serviceFee,
    });

    return {
      success: true,
      config: {
        arbitrageFee: afterData.arbitrageFee || 1.5,
        serviceFee: afterData.serviceFee || 1.5,
        updatedAt: afterData.updatedAt?.toMillis?.() || Date.now(),
        updatedBy: adminId,
      },
      message: "Commission configuration updated successfully",
    };
  } catch (error) {
    console.error("❌ Error updating commission config:", {
      adminId: request.auth?.uid,
      arbitrageFee: request.data?.arbitrageFee,
      serviceFee: request.data?.serviceFee,
      error: error.message,
    });

    if (error instanceof HttpsError) {
      throw error;
    }

    throw new HttpsError("internal", `Failed to update commission config: ${error.message}`);
  }
});

/**
 * Callable Function: Get IntaSend Payment Status
 * Admin-only function to check the status of an IntaSend payment by invoice_id
 * 
 * @param {Object} request.data - Request data
 * @param {string} request.data.invoiceId - IntaSend invoice ID
 * @param {string} request.auth.uid - Admin user ID
 */
exports.getIntaSendPaymentStatus = onCall(
    {
      secrets: [intaSendSecretKey, intaSendPublishableKey],
      region: "us-central1",
      cpu: 0.25,
      memory: "256MiB",
    },
    async (request) => {
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

    const {invoiceId} = request.data || {};

    if (!invoiceId || typeof invoiceId !== "string" || invoiceId.trim().length === 0) {
      throw new HttpsError("invalid-argument", "invoiceId is required and must be a non-empty string");
    }

    // Get IntaSend API keys
    const {secretKey, publishableKey} = getIntaSendKeys();

    if (!secretKey) {
      throw new HttpsError("failed-precondition", "IntaSend API secret key is not configured. Please set INTASEND_SECRET_KEY secret.");
    }

    // Determine if we're in sandbox or production based on the key or environment
    // IntaSend sandbox keys typically start with "IS" or contain "sandbox"
    const isSandbox = secretKey.includes("sandbox") || secretKey.toLowerCase().includes("test") || 
                      process.env.INTASEND_ENV === "sandbox";
    
    const baseUrl = isSandbox 
      ? "https://sandbox.intasend.com" 
      : "https://payment.intasend.com";

    // IntaSend API endpoint for checking collection status
    const statusUrl = `${baseUrl}/api/v1/payment/collections/${invoiceId.trim()}/status/`;

    console.log(`🔍 Checking IntaSend payment status for invoice: ${invoiceId}`, {
      baseUrl,
      isSandbox,
    });

    try {
      // Make API call to IntaSend
      // IntaSend API typically uses Bearer token authentication with the secret key
      // Some endpoints may use Basic Auth, so we'll try Bearer first
      const headers = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${secretKey}`,
      };

      // If publishable key is available, some IntaSend endpoints use it
      if (publishableKey) {
        headers["X-Publishable-Key"] = publishableKey;
      }

      const response = await axios.get(statusUrl, {
        headers,
        timeout: 10000, // 10 second timeout
      });

      const statusData = response.data;

      console.log(`✅ Successfully retrieved payment status for invoice: ${invoiceId}`);

      // Log admin action
      await logAdminAction(
          adminId,
          "system",
          "checkPaymentStatus",
          {},
          {invoiceId, status: statusData.invoice?.state || "unknown"},
      );

      // Return the status data in a structured format
      return {
        success: true,
        invoiceId,
        status: statusData,
        // Extract key fields for easier access
        invoice: statusData.invoice || null,
        meta: statusData.meta || null,
      };
    } catch (apiError) {
      // Handle API errors
      if (apiError.response) {
        // IntaSend API returned an error response
        const statusCode = apiError.response.status;
        const errorData = apiError.response.data;

        console.error(`❌ IntaSend API error for invoice ${invoiceId}:`, {
          statusCode,
          error: errorData,
        });

        if (statusCode === 404) {
          throw new HttpsError("not-found", `Invoice ${invoiceId} not found in IntaSend`);
        } else if (statusCode === 401 || statusCode === 403) {
          throw new HttpsError("permission-denied", "Invalid IntaSend API credentials");
        } else {
          throw new HttpsError(
              "internal",
              `IntaSend API error: ${errorData?.message || errorData?.error || "Unknown error"}`,
          );
        }
      } else if (apiError.request) {
        // Request was made but no response received
        console.error(`❌ No response from IntaSend API for invoice ${invoiceId}:`, apiError.message);
        throw new HttpsError("deadline-exceeded", "IntaSend API request timed out or failed to connect");
      } else {
        // Error setting up the request
        console.error(`❌ Error setting up IntaSend API request for invoice ${invoiceId}:`, apiError.message);
        throw new HttpsError("internal", `Failed to check payment status: ${apiError.message}`);
      }
    }
  } catch (error) {
    console.error("❌ Error checking IntaSend payment status:", {
      adminId: request.auth?.uid,
      invoiceId: request.data?.invoiceId,
      error: error.message,
    });

    if (error instanceof HttpsError) {
      throw error;
    }

    throw new HttpsError("internal", `Failed to check payment status: ${error.message}`);
  }
});

