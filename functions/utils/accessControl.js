/**
 * @fileoverview TruePay identity & access — Firebase custom claims and role checks.
 *
 * New claim shape:
 *   customer: { userType: "customer" }
 *   partner:  { userType: "partner", partnerId, role }
 *   admin:    { userType: "admin", role: "super_admin" | "operations_admin" | ... }
 *
 * Legacy claims (partnerRole, admin: true) are still written and accepted during migration.
 */

const admin = require("../admin");
const { collection, serverTimestamp } = require("../libs/firestore");
const { mergeCustomUserClaims, getCustomClaims } = require("./customClaimsMerge");

/** Built-in super-admin email (override with MASTER_ADMIN_EMAIL env). */
const SUPER_ADMIN_EMAIL = (
  process.env.MASTER_ADMIN_EMAIL || "calvinrumba8@gmail.com"
).trim().toLowerCase();

const USER_TYPE_CUSTOMER = "customer";
const USER_TYPE_PARTNER = "partner";
const USER_TYPE_ADMIN = "admin";

const ADMIN_ROLE_SUPER = "super_admin";
const ADMIN_ROLES = [
  ADMIN_ROLE_SUPER,
  "operations_admin",
  "support_admin",
  "finance_admin",
];

const PARTNER_ROLE_OWNER = "owner";
const PARTNER_ROLES = [
  PARTNER_ROLE_OWNER,
  "finance",
  "support",
  "operations",
  "viewer",
];

/** Legacy partner roles still accepted on tokens and member docs. */
const LEGACY_PARTNER_ROLE_ORG_ADMIN = "org_admin";
const LEGACY_PARTNER_ROLE_MEMBER = "member";

const PLATFORM_ADMINS_COL = "platformAdmins";

/**
 * @param {unknown} role
 * @returns {string}
 */
function normalizePartnerRole(role) {
  const r = String(role || "").trim();
  if (r === LEGACY_PARTNER_ROLE_ORG_ADMIN) {
    return PARTNER_ROLE_OWNER;
  }
  if (r === LEGACY_PARTNER_ROLE_MEMBER) {
    return "viewer";
  }
  if (r === "auditor") {
    return "viewer";
  }
  return r;
}

/**
 * Legacy partnerRole value to keep on token during migration.
 *
 * @param {string} role normalized partner role
 * @returns {string}
 */
function legacyPartnerRoleFromNormalized(role) {
  if (role === PARTNER_ROLE_OWNER) {
    return LEGACY_PARTNER_ROLE_ORG_ADMIN;
  }
  return role;
}

/**
 * @param {Object|null|undefined} decodedToken
 * @returns {{
 *   userType: string|null,
 *   role: string|null,
 *   partnerId: string|null,
 *   isLegacyAdmin: boolean,
 *   legacyPartnerRole: string|null,
 * }}
 */
function parseAccessFromToken(decodedToken) {
  const t = decodedToken || {};
  let userType =
    typeof t.userType === "string" && t.userType.trim() ? t.userType.trim() : null;
  let role = typeof t.role === "string" && t.role.trim() ? t.role.trim() : null;
  let partnerId =
    typeof t.partnerId === "string" && t.partnerId.trim() ? t.partnerId.trim() : null;

  const legacyPartnerRole =
    typeof t.partnerRole === "string" && t.partnerRole.trim() ?
      t.partnerRole.trim() :
      null;
  const isLegacyAdmin = t.admin === true;

  if (!userType && legacyPartnerRole && partnerId) {
    userType = USER_TYPE_PARTNER;
    role = normalizePartnerRole(legacyPartnerRole);
  }
  if (!userType && isLegacyAdmin) {
    userType = USER_TYPE_ADMIN;
    role = role || ADMIN_ROLE_SUPER;
  }

  if (userType === USER_TYPE_PARTNER && role) {
    role = normalizePartnerRole(role);
  }

  return {
    userType,
    role,
    partnerId,
    isLegacyAdmin,
    legacyPartnerRole,
  };
}

/**
 * @param {Object|null|undefined} decodedToken
 * @param {string} [uid]
 * @returns {Promise<boolean>}
 */
async function isSuperAdminEmailUid(uid) {
  if (!uid) {
    return false;
  }
  try {
    const user = await admin.auth().getUser(uid);
    return (user.email || "").trim().toLowerCase() === SUPER_ADMIN_EMAIL;
  } catch (_e) {
    return false;
  }
}

/**
 * @param {Object|null|undefined} decodedToken
 * @param {string} [uid]
 * @returns {Promise<boolean>}
 */
async function isSuperAdmin(decodedToken, uid) {
  const access = parseAccessFromToken(decodedToken);
  if (access.userType === USER_TYPE_ADMIN && access.role === ADMIN_ROLE_SUPER) {
    return true;
  }
  if (access.isLegacyAdmin && uid && await isSuperAdminEmailUid(uid)) {
    return true;
  }
  if (uid && await isSuperAdminEmailUid(uid)) {
    return true;
  }
  return false;
}

/**
 * Platform admin (any admin role) — includes legacy admin claim + master email bootstrap.
 *
 * @param {Object|null|undefined} decodedToken
 * @param {string} [uid]
 * @returns {Promise<boolean>}
 */
async function isPlatformAdmin(decodedToken, uid) {
  const access = parseAccessFromToken(decodedToken);
  if (access.userType === USER_TYPE_ADMIN && access.role && ADMIN_ROLES.includes(access.role)) {
    return true;
  }
  if (access.isLegacyAdmin) {
    return true;
  }
  if (uid && await isSuperAdminEmailUid(uid)) {
    return true;
  }
  return false;
}

/**
 * @param {Object|null|undefined} decodedToken
 * @param {string[]} allowedAdminRoles
 * @returns {boolean}
 */
function hasAdminRole(decodedToken, allowedAdminRoles) {
  const access = parseAccessFromToken(decodedToken);
  if (access.userType !== USER_TYPE_ADMIN || !access.role) {
    if (access.isLegacyAdmin && allowedAdminRoles.includes(ADMIN_ROLE_SUPER)) {
      return true;
    }
    return false;
  }
  if (access.role === ADMIN_ROLE_SUPER) {
    return true;
  }
  return allowedAdminRoles.includes(access.role);
}

/**
 * @param {Object|null|undefined} decodedToken
 * @param {string[]} allowedPartnerRoles normalized role names
 * @returns {boolean}
 */
function hasPartnerRole(decodedToken, allowedPartnerRoles) {
  const access = parseAccessFromToken(decodedToken);
  if (access.userType !== USER_TYPE_PARTNER || !access.partnerId || !access.role) {
    if (access.legacyPartnerRole && access.partnerId) {
      const normalized = normalizePartnerRole(access.legacyPartnerRole);
      return allowedPartnerRoles.includes(normalized);
    }
    return false;
  }
  if (access.role === PARTNER_ROLE_OWNER && allowedPartnerRoles.includes(PARTNER_ROLE_OWNER)) {
    return true;
  }
  return allowedPartnerRoles.includes(access.role);
}

/**
 * @param {string} uid
 * @param {string} adminRole
 * @param {string|null} [createdByUid]
 * @returns {Promise<void>}
 */
async function setAdminAccessClaims(uid, adminRole, createdByUid = null) {
  if (!ADMIN_ROLES.includes(adminRole)) {
    throw new Error(`Invalid admin role: ${adminRole}`);
  }
  await mergeCustomUserClaims(uid, {
    userType: USER_TYPE_ADMIN,
    role: adminRole,
    admin: adminRole === ADMIN_ROLE_SUPER ? true : null,
    partnerId: null,
    partnerRole: null,
  });

  await collection(PLATFORM_ADMINS_COL).doc(uid).set(
      {
        uid,
        role: adminRole,
        createdBy: createdByUid || null,
        updatedAt: serverTimestamp(),
        ...(createdByUid ? {createdAt: serverTimestamp()} : {}),
      },
      {merge: true},
  );
}

/**
 * @param {string} uid
 * @returns {Promise<void>}
 */
async function clearAdminAccessClaims(uid) {
  await mergeCustomUserClaims(uid, {
    userType: null,
    role: null,
    admin: null,
  });
  await collection(PLATFORM_ADMINS_COL).doc(uid).delete();
}

/**
 * @param {string} uid
 * @param {string} partnerId
 * @param {string} partnerRole normalized (owner, finance, ...)
 * @returns {Promise<void>}
 */
async function setPartnerAccessClaims(uid, partnerId, partnerRole) {
  const normalized = normalizePartnerRole(partnerRole);
  if (!PARTNER_ROLES.includes(normalized)) {
    throw new Error(`Invalid partner role: ${partnerRole}`);
  }
  await mergeCustomUserClaims(uid, {
    userType: USER_TYPE_PARTNER,
    role: normalized,
    partnerId,
    partnerRole: legacyPartnerRoleFromNormalized(normalized),
    admin: null,
  });
}

/**
 * @param {string} uid
 * @returns {Promise<void>}
 */
async function clearPartnerAccessClaims(uid) {
  await mergeCustomUserClaims(uid, {
    userType: null,
    role: null,
    partnerId: null,
    partnerRole: null,
  });
}

/**
 * @param {string} uid
 * @returns {Promise<void>}
 */
async function setCustomerAccessClaims(uid) {
  await mergeCustomUserClaims(uid, {
    userType: USER_TYPE_CUSTOMER,
    role: null,
    partnerId: null,
    partnerRole: null,
    admin: null,
  });
}

/**
 * @param {string} uid
 * @param {Object} profile
 * @returns {Promise<void>}
 */
async function syncUserDocAccessFields(uid, profile) {
  const ref = collection("users").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    return;
  }
  await ref.set({...profile, updatedAt: serverTimestamp()}, {merge: true});
}

/**
 * Callable / onCall admin check (legacy + new).
 *
 * @param {Object|null|undefined} auth
 * @returns {boolean}
 */
function verifyAdminFromAuth(auth) {
  if (!auth || !auth.token) {
    return false;
  }
  return hasAdminRole(auth.token, ADMIN_ROLES) || auth.token.admin === true;
}

/**
 * @param {string} role
 * @returns {boolean}
 */
function isPartnerOwnerRole(role) {
  return normalizePartnerRole(role) === PARTNER_ROLE_OWNER;
}

/** Legacy assignable roles still on member docs / tokens during migration. */
const LEGACY_ASSIGNABLE_PARTNER_ROLES = ["member", "auditor"];

/**
 * @param {string|null|undefined} role
 * @returns {boolean}
 */
function isKnownPartnerRole(role) {
  const raw = String(role || "").trim();
  if (!raw) {
    return false;
  }
  const normalized = normalizePartnerRole(raw);
  if (PARTNER_ROLES.includes(normalized)) {
    return true;
  }
  return LEGACY_ASSIGNABLE_PARTNER_ROLES.includes(raw);
}

/**
 * Resolve partner access from an ID token (new + legacy claims).
 *
 * @param {Object|null|undefined} decodedToken
 * @returns {{ partnerId: string, role: string }|null}
 */
function resolvePartnerAccess(decodedToken) {
  const access = parseAccessFromToken(decodedToken);
  if (access.userType === USER_TYPE_PARTNER && access.partnerId && access.role) {
    return { partnerId: access.partnerId, role: access.role };
  }
  if (access.partnerId && access.legacyPartnerRole) {
    return {
      partnerId: access.partnerId,
      role: normalizePartnerRole(access.legacyPartnerRole),
    };
  }
  return null;
}

/**
 * Super-admin only (not operations/support/finance admins).
 *
 * @param {Object|null|undefined} auth
 * @returns {boolean}
 */
function verifySuperAdminFromAuth(auth) {
  if (!auth || !auth.token) {
    return false;
  }
  return hasAdminRole(auth.token, [ADMIN_ROLE_SUPER]);
}

module.exports = {
  SUPER_ADMIN_EMAIL,
  USER_TYPE_CUSTOMER,
  USER_TYPE_PARTNER,
  USER_TYPE_ADMIN,
  ADMIN_ROLE_SUPER,
  ADMIN_ROLES,
  PARTNER_ROLE_OWNER,
  PARTNER_ROLES,
  LEGACY_PARTNER_ROLE_ORG_ADMIN,
  LEGACY_PARTNER_ROLE_MEMBER,
  LEGACY_ASSIGNABLE_PARTNER_ROLES,
  PLATFORM_ADMINS_COL,
  normalizePartnerRole,
  legacyPartnerRoleFromNormalized,
  parseAccessFromToken,
  resolvePartnerAccess,
  isPartnerOwnerRole,
  isKnownPartnerRole,
  isSuperAdminEmailUid,
  isSuperAdmin,
  isPlatformAdmin,
  hasAdminRole,
  hasPartnerRole,
  setAdminAccessClaims,
  clearAdminAccessClaims,
  setPartnerAccessClaims,
  clearPartnerAccessClaims,
  setCustomerAccessClaims,
  syncUserDocAccessFields,
  verifyAdminFromAuth,
  verifySuperAdminFromAuth,
  getCustomClaims,
};
