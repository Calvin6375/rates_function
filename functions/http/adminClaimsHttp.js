/**
 * @fileoverview HTTP handlers for admin claims management
 * Allows super admins to set/unset platform admin roles for other users.
 */

const {onCall, HttpsError} = require("firebase-functions/v2/https");
const admin = require("../admin");
const config = require("../config");
const {
  setAdminAccessClaims,
  clearAdminAccessClaims,
  verifySuperAdminFromAuth,
  ADMIN_ROLES,
  ADMIN_ROLE_SUPER,
  SUPER_ADMIN_EMAIL,
  syncUserDocAccessFields,
  USER_TYPE_ADMIN,
} = require("../utils/accessControl");
const {logAdminAction} = require("../utils/transactions");

/**
 * Callable Function: Set platform admin role (super_admin only).
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

        if (!verifySuperAdminFromAuth(request.auth)) {
          throw new HttpsError("permission-denied", "Super admin access required");
        }

        const {userId, role} = request.data || {};

        if (!userId || typeof userId !== "string") {
          throw new HttpsError("invalid-argument", "userId is required and must be a string");
        }

        if (userId.trim().length === 0) {
          throw new HttpsError("invalid-argument", "userId cannot be empty");
        }

        const adminRole = role && typeof role === "string" ? role.trim() : ADMIN_ROLE_SUPER;
        if (!ADMIN_ROLES.includes(adminRole)) {
          throw new HttpsError(
              "invalid-argument",
              `role must be one of: ${ADMIN_ROLES.join(", ")}`,
          );
        }

        if (adminRole === ADMIN_ROLE_SUPER) {
          try {
            const target = await admin.auth().getUser(userId);
            const email = (target.email || "").trim().toLowerCase();
            if (email !== SUPER_ADMIN_EMAIL) {
              throw new HttpsError(
                  "permission-denied",
                  "Only the built-in super-admin account may hold super_admin role",
              );
            }
          } catch (e) {
            if (e instanceof HttpsError) {
              throw e;
            }
            if (e.code === "auth/user-not-found") {
              throw new HttpsError("not-found", `User ${userId} not found`);
            }
            throw e;
          }
        }

        await setAdminAccessClaims(userId, adminRole, adminId);

        const targetUser = await admin.auth().getUser(userId);
        await syncUserDocAccessFields(userId, {
          userType: USER_TYPE_ADMIN,
          role: adminRole,
          email: targetUser.email || null,
          status: "Active",
        });

        await logAdminAction(
            adminId,
            userId,
            "setAdminClaim",
            {hasAdminClaim: false},
            {hasAdminClaim: true, role: adminRole},
        );

        console.log(`✅ Super admin ${adminId} set ${adminRole} for user ${userId}`);

        return {
          success: true,
          userId,
          role: adminRole,
          message: "Admin role set successfully. User must sign out and sign in again for changes to take effect.",
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
 * Callable Function: Remove platform admin role (super_admin only).
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

        if (!verifySuperAdminFromAuth(request.auth)) {
          throw new HttpsError("permission-denied", "Super admin access required");
        }

        const {userId} = request.data || {};

        if (!userId || typeof userId !== "string") {
          throw new HttpsError("invalid-argument", "userId is required and must be a string");
        }

        if (userId.trim().length === 0) {
          throw new HttpsError("invalid-argument", "userId cannot be empty");
        }

        if (userId === adminId) {
          throw new HttpsError("permission-denied", "Cannot remove your own admin claim");
        }

        try {
          const target = await admin.auth().getUser(userId);
          const email = (target.email || "").trim().toLowerCase();
          if (email === SUPER_ADMIN_EMAIL) {
            throw new HttpsError(
                "permission-denied",
                "Cannot remove the built-in super-admin account",
            );
          }
        } catch (e) {
          if (e instanceof HttpsError) {
            throw e;
          }
          if (e.code !== "auth/user-not-found") {
            throw e;
          }
        }

        await clearAdminAccessClaims(userId);

        await logAdminAction(
            adminId,
            userId,
            "removeAdminClaim",
            {hasAdminClaim: true},
            {hasAdminClaim: false},
        );

        console.log(`✅ Super admin ${adminId} removed admin claim for user ${userId}`);

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
