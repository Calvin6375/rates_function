/**
 * @fileoverview HTTP handlers for admin claims management
 * Allows existing admins to set/unset admin claims for other users
 */

const {onCall, HttpsError} = require("firebase-functions/v2/https");
const config = require("../config");
const {setAdminClaim, removeAdminClaim, verifyAdminFromToken} = require("../utils/adminClaims");
const {logAdminAction} = require("../utils/transactions");

/**
 * Callable Function: Set Admin Claim
 * Admin-only function to grant admin privileges to a user
 */
exports.setAdminClaim = onCall(
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

        const {userId} = request.data || {};

        if (!userId || typeof userId !== "string") {
          throw new HttpsError("invalid-argument", "userId is required and must be a string");
        }

        // Validate userId format
        if (userId.trim().length === 0) {
          throw new HttpsError("invalid-argument", "userId cannot be empty");
        }

        // Set admin claim
        await setAdminClaim(userId);

        // Log admin action
        await logAdminAction(
            adminId,
            userId,
            "setAdminClaim",
            {hasAdminClaim: false},
            {hasAdminClaim: true},
        );

        console.log(`✅ Admin ${adminId} set admin claim for user ${userId}`);

        return {
          success: true,
          userId,
          message: "Admin claim set successfully. User must sign out and sign in again for changes to take effect.",
        };
      } catch (error) {
        console.error("❌ Error setting admin claim:", {
          adminId: request.auth?.uid,
          userId: request.data?.userId,
          error: error.message,
        });

        if (error instanceof HttpsError) {
          throw error;
        }

        if (error.message.includes("not found") || error.code === "auth/user-not-found") {
          throw new HttpsError("not-found", `User ${request.data?.userId} not found`);
        }

        throw new HttpsError("internal", `Failed to set admin claim: ${error.message}`);
      }
    },
);

/**
 * Callable Function: Remove Admin Claim
 * Admin-only function to revoke admin privileges from a user
 */
exports.removeAdminClaim = onCall(
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

        const {userId} = request.data || {};

        if (!userId || typeof userId !== "string") {
          throw new HttpsError("invalid-argument", "userId is required and must be a string");
        }

        // Validate userId format
        if (userId.trim().length === 0) {
          throw new HttpsError("invalid-argument", "userId cannot be empty");
        }

        // Prevent self-removal (safety check)
        if (userId === adminId) {
          throw new HttpsError("permission-denied", "Cannot remove your own admin claim");
        }

        // Remove admin claim
        await removeAdminClaim(userId);

        // Log admin action
        await logAdminAction(
            adminId,
            userId,
            "removeAdminClaim",
            {hasAdminClaim: true},
            {hasAdminClaim: false},
        );

        console.log(`✅ Admin ${adminId} removed admin claim for user ${userId}`);

        return {
          success: true,
          userId,
          message: "Admin claim removed successfully. User must sign out and sign in again for changes to take effect.",
        };
      } catch (error) {
        console.error("❌ Error removing admin claim:", {
          adminId: request.auth?.uid,
          userId: request.data?.userId,
          error: error.message,
        });

        if (error instanceof HttpsError) {
          throw error;
        }

        if (error.message.includes("not found") || error.code === "auth/user-not-found") {
          throw new HttpsError("not-found", `User ${request.data?.userId} not found`);
        }

        throw new HttpsError("internal", `Failed to remove admin claim: ${error.message}`);
      }
    },
);

