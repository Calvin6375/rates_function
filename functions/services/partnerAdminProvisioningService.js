/**
 * @fileoverview Platform-admin partner create with org-admin email + temporary password.
 * First login requires password/PIN reset which also marks emailVerified.
 */

const admin = require("../admin");
const {collection, serverTimestamp} = require("../libs/firestore");
const {mergeCustomUserClaims, getCustomClaims} = require("../utils/customClaimsMerge");
const partnerService = require("./partnerService");
const b2bMemberService = require("./b2bMemberService");
const accountPasswordService = require("./accountPasswordService");

const MIN_PASSWORD_LENGTH = accountPasswordService.MIN_PASSWORD_LENGTH || 8;

/**
 * @param {unknown} email
 * @returns {string}
 */
function normalizeEmail(email) {
  return accountPasswordService.normalizeEmail(email);
}

/**
 * @param {string} email
 * @returns {boolean}
 */
function isValidEmailShape(email) {
  if (!email || email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * @param {string} uid
 * @param {boolean} required
 * @returns {Promise<void>}
 */
async function setMustChangePasswordFlag(uid, required) {
  await mergeCustomUserClaims(uid, {
    mustChangePassword: required ? true : null,
  });
  await collection("users").doc(uid).set(
      {
        mustChangePassword: required === true,
        mustChangePasswordUpdatedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
      {merge: true},
  );
}

/**
 * @param {string} uid
 * @param {Object|null|undefined} [decodedToken]
 * @returns {Promise<boolean>}
 */
async function readMustChangePassword(uid, decodedToken = null) {
  if (decodedToken && decodedToken.mustChangePassword === true) {
    return true;
  }
  try {
    const claims = await getCustomClaims(uid);
    if (claims.mustChangePassword === true) {
      return true;
    }
  } catch (_e) {
    // fall through to users doc
  }
  const snap = await collection("users").doc(uid).get();
  return snap.exists && snap.data()?.mustChangePassword === true;
}

/**
 * Create partner and optionally provision org admin with temp password.
 *
 * @param {Object} params
 * @param {string} params.name
 * @param {string} [params.settlementCurrency]
 * @param {string|null} [params.webhookUrl]
 * @param {string} [params.email] - org admin email
 * @param {string} [params.temporaryPassword]
 * @param {string} [params.displayName]
 * @param {string} params.actorUid - platform admin uid
 * @returns {Promise<Object>}
 */
async function createPartnerWithOrgAdmin(params) {
  const {
    name,
    settlementCurrency = "KES",
    webhookUrl = null,
    email = null,
    temporaryPassword = null,
    displayName = null,
    actorUid,
  } = params;

  if (!name || typeof name !== "string" || !name.trim()) {
    const err = new Error("name is required");
    err.statusCode = 400;
    err.code = "INVALID_ARGUMENT";
    throw err;
  }
  if (!actorUid) {
    const err = new Error("actorUid is required");
    err.statusCode = 400;
    err.code = "INVALID_ARGUMENT";
    throw err;
  }

  const normalizedEmail = email != null ? normalizeEmail(email) : "";
  const wantsOrgAdmin = Boolean(normalizedEmail);

  /** @type {import("firebase-admin/auth").UserRecord|null} */
  let existingUser = null;
  if (wantsOrgAdmin) {
    if (!isValidEmailShape(normalizedEmail)) {
      const err = new Error("Valid org admin email is required");
      err.statusCode = 400;
      err.code = "INVALID_EMAIL";
      throw err;
    }
    if (!temporaryPassword || String(temporaryPassword).length < MIN_PASSWORD_LENGTH) {
      const err = new Error(
          `temporaryPassword must be at least ${MIN_PASSWORD_LENGTH} characters`,
      );
      err.statusCode = 400;
      err.code = "WEAK_PASSWORD";
      throw err;
    }
    try {
      existingUser = await admin.auth().getUserByEmail(normalizedEmail);
    } catch (e) {
      if (e.code !== "auth/user-not-found") {
        throw e;
      }
      existingUser = null;
    }
    if (existingUser) {
      const claims = await getCustomClaims(existingUser.uid);
      if (claims.partnerId) {
        const err = new Error(
            "Email already belongs to another partner. Use a different email or remove them first.",
        );
        err.statusCode = 409;
        err.code = "EMAIL_IN_USE";
        throw err;
      }
    }
  }

  const creationDisplayName = displayName ?
    String(displayName).trim() :
    name.trim();
  const created = await partnerService.createPartner({
    name: name.trim(),
    settlementCurrency: settlementCurrency || "KES",
    webhookUrl: webhookUrl || null,
    onboardingSource: "platform",
    greetingDisplayName: creationDisplayName,
  });

  if (!wantsOrgAdmin) {
    return {
      partnerId: created.partnerId,
      apiKey: created.apiKey,
      partner: {
        id: created.partnerId,
        name: created.partner.name,
        orgAdminUid: null,
      },
      orgAdmin: null,
    };
  }

  let userRecord = existingUser;
  if (!userRecord) {
    userRecord = await admin.auth().createUser({
      email: normalizedEmail,
      password: String(temporaryPassword),
      displayName: displayName ? String(displayName).trim() : name.trim(),
      emailVerified: false,
    });
  } else {
    await admin.auth().updateUser(userRecord.uid, {
      password: String(temporaryPassword),
      displayName: displayName ?
        String(displayName).trim() :
        (userRecord.displayName || name.trim()),
      emailVerified: false,
    });
  }

  await b2bMemberService.setPartnerOrgAdmin(
      created.partnerId,
      userRecord.uid,
      actorUid,
  );

  await b2bMemberService.ensureUserDashboardProfile(userRecord.uid, {
    email: normalizedEmail,
    displayName: displayName ?
      String(displayName).trim() :
      (userRecord.displayName || name.trim()),
    institution: b2bMemberService.INSTITUTION_PARTNER_DASHBOARD,
    channel: b2bMemberService.CHANNEL_B2B,
  });

  await setMustChangePasswordFlag(userRecord.uid, true);

  return {
    partnerId: created.partnerId,
    apiKey: created.apiKey,
    partner: {
      id: created.partnerId,
      name: created.partner.name,
      orgAdminUid: userRecord.uid,
    },
    orgAdmin: {
      userId: userRecord.uid,
      email: normalizedEmail,
      mustChangePassword: true,
      emailVerified: false,
      redirectTo: "set_pin",
    },
  };
}

/**
 * First-login: replace temporary password (PIN page) and mark email verified.
 *
 * @param {string} uid
 * @param {Object} input
 * @param {string} input.temporaryPassword - current temp password
 * @param {string} input.newPassword
 * @param {string} [input.confirmPassword]
 * @returns {Promise<Object>}
 */
async function completeFirstLoginSetPassword(uid, input = {}) {
  if (!uid) {
    const err = new Error("Authentication required");
    err.statusCode = 401;
    err.code = "UNAUTHENTICATED";
    throw err;
  }

  const required = await readMustChangePassword(uid);
  if (!required) {
    const err = new Error("This account does not require a first-login password change");
    err.statusCode = 400;
    err.code = "NOT_REQUIRED";
    throw err;
  }

  const temporaryPassword =
    input.temporaryPassword != null ?
      String(input.temporaryPassword) :
      (input.currentPassword != null ? String(input.currentPassword) : "");
  const newPassword = input.newPassword != null ? String(input.newPassword) : "";
  const confirmPassword =
    input.confirmPassword != null ? String(input.confirmPassword) : null;

  await accountPasswordService.changePassword(uid, {
    currentPassword: temporaryPassword,
    newPassword,
    confirmPassword,
  });

  try {
    await admin.auth().updateUser(uid, {emailVerified: true});
  } catch (e) {
    console.error("completeFirstLoginSetPassword emailVerified:", e.message);
    const err = new Error("Password updated but email verification failed");
    err.statusCode = 500;
    err.code = "EMAIL_VERIFY_FAILED";
    throw err;
  }

  await setMustChangePasswordFlag(uid, false);

  return {
    success: true,
    emailVerified: true,
    mustChangePassword: false,
    redirectTo: null,
    claimsNeedRefresh: true,
  };
}

/**
 * Shape for GET /portal/me session gating.
 *
 * @param {string} uid
 * @param {Object|null|undefined} decodedToken
 * @returns {Promise<{ mustChangePassword: boolean, redirectTo: string|null }>}
 */
async function firstLoginSessionHints(uid, decodedToken) {
  const mustChangePassword = await readMustChangePassword(uid, decodedToken);
  return {
    mustChangePassword,
    redirectTo: mustChangePassword ? "set_pin" : null,
  };
}

module.exports = {
  createPartnerWithOrgAdmin,
  completeFirstLoginSetPassword,
  firstLoginSessionHints,
  readMustChangePassword,
  setMustChangePasswordFlag,
};
