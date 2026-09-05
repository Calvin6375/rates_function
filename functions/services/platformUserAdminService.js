/**
 * @fileoverview Platform admin edit for Safari Tap / C2B users (Firestore + Auth).
 * PATCH /platform/users/:userId — does not change balances or partner roles.
 */

const admin = require("../admin");
const config = require("../config");
const {isSuperAdminUid} = require("../utils/adminClaims");
const {logAdminAction} = require("../utils/transactions");
const {validateCustomerEmail} = require("../utils/emailValidation");
const platformConsumerService = require("./platformConsumerService");

const COL = config.collections.users;

/**
 * @param {string} phone
 * @returns {boolean}
 */
function isValidE164(phone) {
  return /^\+[1-9]\d{6,14}$/.test(String(phone).trim());
}

/**
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeStatus(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim().toLowerCase();
  if (s === "active") return "active";
  if (s === "inactive" || s === "disabled" || s === "suspended") return "inactive";
  return undefined;
}

/**
 * @param {string} actorUid
 * @param {string} targetUserId
 * @param {Object} body
 * @param {{ actorIsSuperAdmin?: boolean }} [opts]
 * @returns {Promise<Object>}
 */
async function updatePlatformUser(actorUid, targetUserId, body, opts = {}) {
  const userId = String(targetUserId || "").trim();
  if (!userId) {
    const err = new Error("userId is required");
    err.statusCode = 400;
    throw err;
  }

  const actorIsSuperAdmin = opts.actorIsSuperAdmin === true;
  if (!actorIsSuperAdmin) {
    const err = new Error("Only the super admin can edit users");
    err.statusCode = 403;
    throw err;
  }

  const userRef = admin.firestore().collection(COL).doc(userId);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }
  const before = userSnap.data() || {};

  let targetRecord = null;
  try {
    targetRecord = await admin.auth().getUser(userId);
  } catch (e) {
    if (e.code !== "auth/user-not-found" && e.code !== "auth/invalid-uid") {
      throw e;
    }
  }

  const targetIsAdmin = Boolean(targetRecord && targetRecord.customClaims &&
    targetRecord.customClaims.admin === true);
  if (targetIsAdmin && !actorIsSuperAdmin) {
    const err = new Error("Only the platform owner can edit an administrator account");
    err.statusCode = 403;
    throw err;
  }

  const patch = body && typeof body === "object" ? body : {};
  const firestoreUpdates = {};
  const authUpdates = {};

  if (patch.firstName !== undefined) {
    const firstName = String(patch.firstName || "").trim();
    if (!firstName) {
      const err = new Error("firstName cannot be empty");
      err.statusCode = 400;
      throw err;
    }
    firestoreUpdates.firstName = firstName;
  }
  if (patch.lastName !== undefined) {
    const lastName = String(patch.lastName || "").trim();
    if (!lastName) {
      const err = new Error("lastName cannot be empty");
      err.statusCode = 400;
      throw err;
    }
    firestoreUpdates.lastName = lastName;
  }

  const nextFirst = firestoreUpdates.firstName || before.firstName || "";
  const nextLast = firestoreUpdates.lastName || before.lastName || "";
  if (patch.name !== undefined) {
    const name = String(patch.name || "").trim();
    if (!name) {
      const err = new Error("name cannot be empty");
      err.statusCode = 400;
      throw err;
    }
    firestoreUpdates.name = name;
    authUpdates.displayName = name;
  } else if (firestoreUpdates.firstName !== undefined || firestoreUpdates.lastName !== undefined) {
    const name = `${nextFirst} ${nextLast}`.trim();
    if (name) {
      firestoreUpdates.name = name;
      authUpdates.displayName = name;
    }
  }

  if (patch.email !== undefined) {
    const emailCheck = validateCustomerEmail(patch.email);
    if (!emailCheck.ok) {
      const err = new Error(emailCheck.error);
      err.statusCode = 400;
      err.code = "INVALID_EMAIL";
      throw err;
    }
    firestoreUpdates.email = emailCheck.email;
    authUpdates.email = emailCheck.email;
    authUpdates.emailVerified = false;
  }

  if (patch.phoneNumber !== undefined) {
    const phone = patch.phoneNumber == null || patch.phoneNumber === "" ?
      "" :
      String(patch.phoneNumber).trim();
    if (phone && !isValidE164(phone)) {
      const err = new Error("phoneNumber must be E.164 (e.g. +254712137171)");
      err.statusCode = 400;
      throw err;
    }
    firestoreUpdates.phoneNumber = phone || null;
    if (phone) authUpdates.phoneNumber = phone;
  }

  if (patch.country !== undefined) {
    const country = String(patch.country || "").trim();
    firestoreUpdates.country = country || null;
  }

  if (patch.status !== undefined) {
    const status = normalizeStatus(patch.status);
    if (status === undefined) {
      const err = new Error("status must be active or inactive");
      err.statusCode = 400;
      throw err;
    }
    if (status === "inactive" && actorUid === userId) {
      const err = new Error("Cannot deactivate your own account");
      err.statusCode = 403;
      throw err;
    }
    firestoreUpdates.status = status;
    authUpdates.disabled = status === "inactive";
  }

  if (!Object.keys(firestoreUpdates).length) {
    const err = new Error(
        "Provide at least one of: firstName, lastName, name, email, phoneNumber, country, status",
    );
    err.statusCode = 400;
    throw err;
  }

  firestoreUpdates.updatedAt = admin.firestore.FieldValue.serverTimestamp();

  if (targetRecord && Object.keys(authUpdates).length) {
    try {
      await admin.auth().updateUser(userId, authUpdates);
    } catch (e) {
      if (e.code === "auth/email-already-exists") {
        const err = new Error("An account already exists for this email");
        err.statusCode = 409;
        throw err;
      }
      if (e.code === "auth/invalid-email") {
        const err = new Error("Invalid email address");
        err.statusCode = 400;
        throw err;
      }
      if (e.code === "auth/invalid-phone-number") {
        const err = new Error("phoneNumber must be E.164 (e.g. +254712137171)");
        err.statusCode = 400;
        throw err;
      }
      throw e;
    }
  }

  await userRef.update(firestoreUpdates);

  const after = await platformConsumerService.getConsumerUser(userId);
  await logAdminAction(
      actorUid,
      userId,
      "updateUser.platform",
      {
        email: before.email || null,
        name: before.name || null,
        phoneNumber: before.phoneNumber || null,
        status: before.status || null,
      },
      {
        updatedFields: Object.keys(firestoreUpdates).filter((k) => k !== "updatedAt"),
      },
  );

  return {
    userId,
    updatedFields: Object.keys(firestoreUpdates).filter((k) => k !== "updatedAt"),
    user: after,
  };
}

module.exports = {
  updatePlatformUser,
  normalizeStatus,
  isValidE164,
};
