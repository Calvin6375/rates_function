/**
 * @fileoverview HTTP handlers for admin endpoints
 * Thin controllers that delegate to business logic in libs/adminActions.js
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const config = require("../config");
const adminActionsLib = require("../libs/adminActions");
const { verifyAdminFromToken } = require("../utils/adminClaims");

// IntaSend API configuration
const intaSendSecretKey = defineSecret(config.secrets.intaSendSecretKey);
const intaSendPublishableKey = defineSecret(config.secrets.intaSendPublishableKey);

/**
 * Callable Function: Update User Profile
 * Admin-only function to update user profile fields
 */
exports.updateUserProfile = onCall(
  {
    region: config.region,
    cpu: config.resources.cpu,
    memory: config.resources.memory,
    enforceAppCheck: true, // Require App Check token
  },
  async (request) => {
    try {
      const adminId = request.auth?.uid;
      if (!adminId) {
        throw new HttpsError("unauthenticated", "Authentication required");
      }

      // Verify admin role using Custom Claims (faster, more secure)
      if (!verifyAdminFromToken(request.auth)) {
        throw new HttpsError("permission-denied", "Admin access required");
      }

      const { userId, updates } = request.data || {};

      if (!userId) {
        throw new HttpsError("invalid-argument", "userId is required");
      }

      if (!updates || typeof updates !== "object") {
        throw new HttpsError("invalid-argument", "updates object is required");
      }

      return await adminActionsLib.updateUserProfile(adminId, userId, updates);
    } catch (error) {
      console.error("❌ Error updating user profile:", {
        adminId: request.auth?.uid,
        userId: request.data?.userId,
        error: error.message,
      });

      if (error instanceof HttpsError) {
        throw error;
      }

      if (error.message.includes("not found")) {
        throw new HttpsError("not-found", error.message);
      }

      throw new HttpsError("internal", `Failed to update profile: ${error.message}`);
    }
  },
);

/**
 * Callable Function: Update User Balance
 * Admin-only function to update user balance
 */
exports.updateUserBalance = onCall(
  {
    region: config.region,
    cpu: config.resources.cpu,
    memory: config.resources.memory,
    enforceAppCheck: true,
  },
  async (request) => {
    try {
      const adminId = request.auth?.uid;
      if (!adminId) {
        throw new HttpsError("unauthenticated", "Authentication required");
      }

      // Verify admin role using Custom Claims
      if (!verifyAdminFromToken(request.auth)) {
        throw new HttpsError("permission-denied", "Admin access required");
      }

      const { userId, amount, reason } = request.data || {};

      return await adminActionsLib.updateUserBalance(adminId, userId, amount, reason);
    } catch (error) {
      console.error("❌ Error updating user balance:", {
        adminId: request.auth?.uid,
        userId: request.data?.userId,
        error: error.message,
      });

      if (error instanceof HttpsError) {
        throw error;
      }

      if (error.message.includes("Invalid") || error.message.includes("Missing")) {
        throw new HttpsError("invalid-argument", error.message);
      }

      if (error.message.includes("not found")) {
        throw new HttpsError("not-found", error.message);
      }

      throw new HttpsError("internal", `Failed to update balance: ${error.message}`);
    }
  },
);

/**
 * Callable Function: Get User Data
 * Admin-only function to retrieve user data
 */
exports.getUserData = onCall(
  {
    region: config.region,
    cpu: config.resources.cpu,
    memory: config.resources.memory,
    enforceAppCheck: true,
  },
  async (request) => {
    try {
      const adminId = request.auth?.uid;
      if (!adminId) {
        throw new HttpsError("unauthenticated", "Authentication required");
      }

      // Verify admin role using Custom Claims
      if (!verifyAdminFromToken(request.auth)) {
        throw new HttpsError("permission-denied", "Admin access required");
      }

      const { userId } = request.data || {};

      if (!userId) {
        throw new HttpsError("invalid-argument", "userId is required");
      }

      return await adminActionsLib.getUserData(adminId, userId);
    } catch (error) {
      console.error("❌ Error getting user data:", {
        adminId: request.auth?.uid,
        userId: request.data?.userId,
        error: error.message,
      });

      if (error instanceof HttpsError) {
        throw error;
      }

      if (error.message.includes("not found")) {
        throw new HttpsError("not-found", error.message);
      }

      throw new HttpsError("internal", `Failed to get user data: ${error.message}`);
    }
  },
);

/**
 * Callable Function: Update KYC Status
 * Admin-only function to update user KYC status
 */
exports.updateKYCStatus = onCall(
  {
    region: config.region,
    cpu: config.resources.cpu,
    memory: config.resources.memory,
    enforceAppCheck: true,
  },
  async (request) => {
    try {
      const adminId = request.auth?.uid;
      if (!adminId) {
        throw new HttpsError("unauthenticated", "Authentication required");
      }

      // Verify admin role using Custom Claims
      if (!verifyAdminFromToken(request.auth)) {
        throw new HttpsError("permission-denied", "Admin access required");
      }

      const { userId, kycStatus, kycData } = request.data || {};

      if (!userId) {
        throw new HttpsError("invalid-argument", "userId is required");
      }

      if (!kycStatus) {
        throw new HttpsError("invalid-argument", "kycStatus is required");
      }

      return await adminActionsLib.updateKYCStatus(adminId, userId, kycStatus, kycData);
    } catch (error) {
      console.error("❌ Error updating KYC status:", {
        adminId: request.auth?.uid,
        userId: request.data?.userId,
        error: error.message,
      });

      if (error instanceof HttpsError) {
        throw error;
      }

      if (error.message.includes("Invalid")) {
        throw new HttpsError("invalid-argument", error.message);
      }

      if (error.message.includes("not found")) {
        throw new HttpsError("not-found", error.message);
      }

      throw new HttpsError("internal", `Failed to update KYC status: ${error.message}`);
    }
  },
);

/**
 * Callable Function: Sync User Balance to Realtime DB (Manual)
 * Admin-only function to manually sync user balance to Realtime Database
 */
exports.syncUserBalanceToRealtime = onCall(
  {
    region: config.region,
    cpu: config.resources.cpu,
    memory: config.resources.memory,
    enforceAppCheck: true,
  },
  async (request) => {
    try {
      const adminId = request.auth?.uid;
      if (!adminId) {
        throw new HttpsError("unauthenticated", "Authentication required");
      }

      // Verify admin role using Custom Claims
      if (!verifyAdminFromToken(request.auth)) {
        throw new HttpsError("permission-denied", "Admin access required");
      }

      const { userId } = request.data || {};

      if (!userId) {
        throw new HttpsError("invalid-argument", "userId is required");
      }

      return await adminActionsLib.syncUserBalanceToRealtime(adminId, userId);
    } catch (error) {
      console.error("❌ Error manually syncing balance:", {
        adminId: request.auth?.uid,
        userId: request.data?.userId,
        error: error.message,
      });

      if (error instanceof HttpsError) {
        throw error;
      }

      if (error.message.includes("not found")) {
        throw new HttpsError("not-found", error.message);
      }

      throw new HttpsError("internal", `Failed to sync balance: ${error.message}`);
    }
  },
);

/**
 * Callable Function: Get Commission Configuration
 * Admin-only function to retrieve current commission/fee settings
 */
exports.getCommissionConfig = onCall(
  {
    region: config.region,
    cpu: config.resources.cpu,
    memory: config.resources.memory,
    enforceAppCheck: true,
  },
  async (request) => {
    try {
      const adminId = request.auth?.uid;
      if (!adminId) {
        throw new HttpsError("unauthenticated", "Authentication required");
      }

      // Verify admin role using Custom Claims
      if (!verifyAdminFromToken(request.auth)) {
        throw new HttpsError("permission-denied", "Admin access required");
      }

      return await adminActionsLib.getCommissionConfig(adminId);
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
  },
);

/**
 * Callable Function: Update Customer Rates Configuration
 * Admin-only function to update customer rates (buyRate and sellRate)
 * 
 * Request format:
 * {
 *   buyRate: number,        // Required: Customer rate for buying
 *   sellRate: number,        // Required: Customer rate for selling
 *   currencyPair?: string    // Optional: e.g., "USDT/KES", defaults to "USDT/KES"
 * }
 */
exports.updateCommissionConfig = onCall(
  {
    region: config.region,
    cpu: config.resources.cpu,
    memory: config.resources.memory,
    enforceAppCheck: true,
  },
  async (request) => {
    try {
      const adminId = request.auth?.uid;
      if (!adminId) {
        throw new HttpsError("unauthenticated", "Authentication required");
      }

      // Verify admin role using Custom Claims
      if (!verifyAdminFromToken(request.auth)) {
        throw new HttpsError("permission-denied", "Admin access required");
      }

      const { buyRate, sellRate, currencyPair, arbitrageFee } = request.data || {};

      return await adminActionsLib.updateCommissionConfig(adminId, buyRate, sellRate, currencyPair, arbitrageFee);
    } catch (error) {
      console.error("❌ Error updating customer rates config:", {
        adminId: request.auth?.uid,
        buyRate: request.data?.buyRate,
        sellRate: request.data?.sellRate,
        currencyPair: request.data?.currencyPair,
        error: error.message,
      });

      if (error instanceof HttpsError) {
        throw error;
      }

      if (error.message.includes("must be") || error.message.includes("required")) {
        throw new HttpsError("invalid-argument", error.message);
      }

      throw new HttpsError("internal", `Failed to update customer rates: ${error.message}`);
    }
  },
);

/**
 * Callable Function: Get IntaSend Payment Status
 * Admin-only function to check the status of an IntaSend payment by invoice_id
 */
exports.getIntaSendPaymentStatus = onCall(
  {
    secrets: [intaSendSecretKey, intaSendPublishableKey],
    region: config.region,
    cpu: config.resources.cpu,
    memory: config.resources.memory,
    enforceAppCheck: true,
  },
  async (request) => {
    try {
      const adminId = request.auth?.uid;
      if (!adminId) {
        throw new HttpsError("unauthenticated", "Authentication required");
      }

      // Verify admin role using Custom Claims
      if (!verifyAdminFromToken(request.auth)) {
        throw new HttpsError("permission-denied", "Admin access required");
      }

      const { invoiceId } = request.data || {};

      return await adminActionsLib.getIntaSendPaymentStatus(adminId, invoiceId);
    } catch (error) {
      console.error("❌ Error checking IntaSend payment status:", {
        adminId: request.auth?.uid,
        invoiceId: request.data?.invoiceId,
        error: error.message,
      });

      if (error instanceof HttpsError) {
        throw error;
      }

      if (error.message.includes("required") || error.message.includes("must be")) {
        throw new HttpsError("invalid-argument", error.message);
      }

      if (error.message.includes("not found")) {
        throw new HttpsError("not-found", error.message);
      }

      if (error.message.includes("credentials") || error.message.includes("not configured")) {
        throw new HttpsError("failed-precondition", error.message);
      }

      if (error.message.includes("timed out") || error.message.includes("failed to connect")) {
        throw new HttpsError("deadline-exceeded", error.message);
      }

      throw new HttpsError("internal", `Failed to check payment status: ${error.message}`);
    }
  },
);

