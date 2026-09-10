/**
 * @fileoverview TruePay operations team (platform admins) — not partner members.
 */

const admin = require("../admin");
const {collection} = require("../libs/firestore");
const accountPasswordService = require("./accountPasswordService");
const partnerAdminProvisioningService = require("./partnerAdminProvisioningService");
const b2bMemberService = require("./b2bMemberService");
const {getCustomClaims} = require("../utils/customClaimsMerge");
const {
  ADMIN_ROLES,
  ADMIN_ROLE_SUPER,
  SUPER_ADMIN_EMAIL,
  USER_TYPE_ADMIN,
  PLATFORM_ADMINS_COL,
  setAdminAccessClaims,
  clearAdminAccessClaims,
  syncUserDocAccessFields,
} = require("../utils/accessControl");

/** Partner-team role names the operations UI may send by mistake. */
const PARTNER_ROLE_TO_PLATFORM = Object.freeze({
  finance: "finance_admin",
  support: "support_admin",
  operations: "operations_admin",
});

const MIN_PASSWORD_LENGTH = accountPasswordService.MIN_PASSWORD_LENGTH || 8;

/** Roles a super admin may assign via POST /platform/admins (never super_admin). */
const ASSIGNABLE_PLATFORM_ROLES = Object.freeze([
  "operations_admin",
  "support_admin",
  "finance_admin",
]);

/**
 * @param {unknown} role
 * @returns {string}
 */
function normalizePlatformRole(role) {
  const raw = String(role || "").trim().toLowerCase();
  return PARTNER_ROLE_TO_PLATFORM[raw] || raw;
}

/**
 * @param {string} role
 * @returns {boolean}
 */
function isAssignablePlatformRole(role) {
  return ASSIGNABLE_PLATFORM_ROLES.includes(normalizePlatformRole(role));
}

/**
 * Invite or attach a TruePay operations teammate.
 *
 * @param {Object} params
 * @param {string} params.email
 * @param {string} params.role
 * @param {string} [params.temporaryPassword]
 * @param {string} [params.displayName]
 * @param {string} params.actorUid
 * @returns {Promise<Object>}
 */
async function invitePlatformAdmin(params) {
  const email = accountPasswordService.normalizeEmail(params.email);
  const role = normalizePlatformRole(params.role);
  const displayName =
    params.displayName && String(params.displayName).trim() ?
      String(params.displayName).trim() :
      null;
  const actorUid = params.actorUid;
  const temporaryPassword = params.temporaryPassword != null ?
    String(params.temporaryPassword) :
    "";

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const err = new Error("Valid email is required");
    err.statusCode = 400;
    err.code = "INVALID_EMAIL";
    throw err;
  }
  if (!isAssignablePlatformRole(role)) {
    const err = new Error(
        `role must be one of: ${ASSIGNABLE_PLATFORM_ROLES.join(", ")}`,
    );
    err.statusCode = 400;
    err.code = "INVALID_ROLE";
    throw err;
  }
  if (!actorUid) {
    const err = new Error("actorUid is required");
    err.statusCode = 400;
    throw err;
  }

  let userRecord = null;
  let createdNew = false;
  try {
    userRecord = await admin.auth().getUserByEmail(email);
  } catch (e) {
    if (e.code !== "auth/user-not-found") {
      throw e;
    }
  }

  if (!userRecord) {
    if (temporaryPassword.length < MIN_PASSWORD_LENGTH) {
      const err = new Error(
          `temporaryPassword must be at least ${MIN_PASSWORD_LENGTH} characters for new users`,
      );
      err.statusCode = 400;
      err.code = "WEAK_PASSWORD";
      throw err;
    }
    userRecord = await admin.auth().createUser({
      email,
      password: temporaryPassword,
      displayName: displayName || undefined,
      emailVerified: false,
    });
    createdNew = true;
  } else {
    if ((userRecord.email || "").trim().toLowerCase() === SUPER_ADMIN_EMAIL) {
      const err = new Error("Cannot reassign the built-in super-admin account");
      err.statusCode = 403;
      err.code = "FORBIDDEN";
      throw err;
    }
    const claims = await getCustomClaims(userRecord.uid);
    if (claims.partnerId) {
      try {
        await b2bMemberService.removeMember(String(claims.partnerId), userRecord.uid);
      } catch (detachErr) {
        if (String(detachErr.message || "").includes("owner")) {
          const err = new Error(
              "This email is the partner owner. Assign a new owner on that merchant first.",
          );
          err.statusCode = 409;
          err.code = "PARTNER_OWNER";
          throw err;
        }
      }
    }
    if (temporaryPassword.length >= MIN_PASSWORD_LENGTH) {
      await admin.auth().updateUser(userRecord.uid, {
        password: temporaryPassword,
        ...(displayName ? {displayName} : {}),
      });
    } else if (displayName) {
      await admin.auth().updateUser(userRecord.uid, {displayName});
    }
  }

  const forcePin = createdNew || temporaryPassword.length >= MIN_PASSWORD_LENGTH;

  await setAdminAccessClaims(userRecord.uid, role, actorUid);
  await b2bMemberService.ensureUserDashboardProfile(userRecord.uid, {
    email,
    displayName: displayName || userRecord.displayName || "",
  });
  await syncUserDocAccessFields(userRecord.uid, {
    userType: USER_TYPE_ADMIN,
    role,
    email,
    status: "Active",
    partnerId: null,
  });
  if (forcePin) {
    await partnerAdminProvisioningService.setMustChangePasswordFlag(userRecord.uid, true);
  }

  return {
    userId: userRecord.uid,
    email,
    role,
    userType: USER_TYPE_ADMIN,
    admin: true,
    sessionScope: "platform_admin",
    mustChangePassword: Boolean(forcePin),
    redirectTo: forcePin ? "set_pin" : null,
    claimsNeedRefresh: true,
  };
}

/**
 * @returns {Promise<Object[]>}
 */
async function listPlatformAdmins() {
  const snap = await collection(PLATFORM_ADMINS_COL).get();
  const rows = [];
  for (const doc of snap.docs) {
    const d = doc.data() || {};
    let email = null;
    let displayName = null;
    try {
      const user = await admin.auth().getUser(doc.id);
      email = user.email || null;
      displayName = user.displayName || null;
    } catch (_err) {
      // claim registry row without Auth user
    }
    rows.push({
      userId: doc.id,
      email,
      displayName,
      role: d.role || null,
      createdBy: d.createdBy || null,
      updatedAt: d.updatedAt?.toDate?.()?.toISOString?.() || null,
    });
  }
  return rows.sort((a, b) => String(a.email || "").localeCompare(String(b.email || "")));
}

/**
 * @param {string} targetUid
 * @param {string} actorUid
 * @returns {Promise<{ userId: string }>}
 */
async function removePlatformAdmin(targetUid, actorUid) {
  const uid = String(targetUid || "").trim();
  if (!uid) {
    const err = new Error("userId is required");
    err.statusCode = 400;
    throw err;
  }
  if (uid === actorUid) {
    const err = new Error("Cannot remove your own operations access");
    err.statusCode = 403;
    err.code = "FORBIDDEN";
    throw err;
  }
  try {
    const user = await admin.auth().getUser(uid);
    if ((user.email || "").trim().toLowerCase() === SUPER_ADMIN_EMAIL) {
      const err = new Error("Cannot remove the built-in super-admin account");
      err.statusCode = 403;
      err.code = "FORBIDDEN";
      throw err;
    }
  } catch (e) {
    if (e.statusCode) {
      throw e;
    }
    if (e.code !== "auth/user-not-found") {
      throw e;
    }
  }
  await clearAdminAccessClaims(uid);
  await syncUserDocAccessFields(uid, {
    userType: null,
    role: null,
  });
  return {userId: uid};
}

module.exports = {
  ASSIGNABLE_PLATFORM_ROLES,
  ADMIN_ROLES,
  ADMIN_ROLE_SUPER,
  normalizePlatformRole,
  isAssignablePlatformRole,
  invitePlatformAdmin,
  listPlatformAdmins,
  removePlatformAdmin,
};
