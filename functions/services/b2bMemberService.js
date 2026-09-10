/**
 * @fileoverview B2B partner org structure: one owner per partner (set by platform admin),
 * owner assigns institutional roles. Custom claims: userType partner + partnerId + role.
 */

const admin = require("../admin");
const { collection, serverTimestamp } = require("../libs/firestore");
const { clearPartnerClaims, getCustomClaims } = require("../utils/customClaimsMerge");
const {
  PARTNER_ROLE_OWNER,
  PARTNER_ROLES,
  LEGACY_PARTNER_ROLE_ORG_ADMIN,
  LEGACY_ASSIGNABLE_PARTNER_ROLES,
  normalizePartnerRole,
  isPartnerOwnerRole,
  setPartnerAccessClaims,
  syncUserDocAccessFields,
  USER_TYPE_PARTNER,
} = require("../utils/accessControl");

const MEMBERS_SUB = "members";

/** Portal provisioning: Firestore `users` doc markers (Partner dashboard signup). */
const INSTITUTION_PARTNER_DASHBOARD = "PartnerDashboard";
const CHANNEL_B2B = "B2B";

/** Roles partner owner may assign (claims + members doc). */
/** @type {readonly string[]} */
const ASSIGNABLE_ROLES = ["finance", "support", "operations", "viewer"];

/** All partnerRole values accepted on the portal (token + GET /portal/me). */
/** @type {readonly string[]} */
const ALL_PARTNER_ROLES = [
  PARTNER_ROLE_OWNER,
  LEGACY_PARTNER_ROLE_ORG_ADMIN,
  ...ASSIGNABLE_ROLES,
  ...LEGACY_ASSIGNABLE_PARTNER_ROLES,
];

const DEFAULT_DASHBOARD_USER_STATUS = "Active";

/** Default Firestore permissions for new B2B partner-dashboard users. */
const DEFAULT_B2B_PARTNER_PERMISSIONS = [
  "dashboard.view",
  "notifications.view",
  "settings.view",
];

/**
 * @param {unknown} permissions
 * @returns {boolean}
 */
function permissionsNeedDefaults(permissions) {
  if (permissions === undefined || permissions === null) {
    return true;
  }
  return Array.isArray(permissions) && permissions.length === 0;
}

/**
 * @param {{ institution?: string, channel?: string }|null} provisioning
 * @param {Object|null|undefined} existing
 * @returns {boolean}
 */
function isB2BPartnerDashboardUser(provisioning, existing) {
  if (provisioning && provisioning.institution && provisioning.channel) {
    return (
      provisioning.institution === INSTITUTION_PARTNER_DASHBOARD &&
      provisioning.channel === CHANNEL_B2B
    );
  }
  if (existing && typeof existing === "object") {
    return (
      existing.institution === INSTITUTION_PARTNER_DASHBOARD &&
      existing.channel === CHANNEL_B2B
    );
  }
  return false;
}

/**
 * Split a display name into firstName / lastName for users/{uid} bootstrap.
 *
 * @param {string|null|undefined} displayName
 * @return {{ firstName: string|null, lastName: string|null, name: string|null }}
 */
function splitDisplayName(displayName) {
  const display =
    displayName && String(displayName).trim() ? String(displayName).trim() : null;
  if (!display) {
    return {firstName: null, lastName: null, name: null};
  }
  const parts = display.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return {firstName: null, lastName: null, name: null};
  }
  if (parts.length === 1) {
    return {firstName: parts[0], lastName: null, name: display};
  }
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
    name: display,
  };
}

/**
 * @param {string} partnerId
 * @returns {import("firebase-admin/firestore").CollectionReference}
 */
function membersCollection(partnerId) {
  return collection("partners").doc(partnerId).collection(MEMBERS_SUB);
}

/**
 * Parse optional Institution + Channel from ensure-dashboard-profile body.
 * Accepts PascalCase (admin dashboard) or camelCase keys. Typo PatnerDashboard
 * normalizes to PartnerDashboard.
 *
 * @param {Object|null|undefined} body
 * @return {{ institution: string, channel: string }|null} null = omit provisioning fields
 * @throws {Error} invalid or partial pair
 */
function parsePortalProvisioningFields(body) {
  if (!body || typeof body !== "object") {
    return null;
  }
  const rawInst =
      body.Institution !== undefined ? body.Institution : body.institution;
  const rawCh = body.Channel !== undefined ? body.Channel : body.channel;
  const hasInst =
    rawInst !== undefined && rawInst !== null && String(rawInst).trim() !== "";
  const hasCh =
    rawCh !== undefined && rawCh !== null && String(rawCh).trim() !== "";
  if (!hasInst && !hasCh) {
    return null;
  }
  if (hasInst !== hasCh) {
    throw new Error("Institution and Channel must both be provided together");
  }
  let institution = String(rawInst).trim();
  if (institution === "PatnerDashboard") {
    institution = INSTITUTION_PARTNER_DASHBOARD;
  }
  const channel = String(rawCh).trim();
  if (institution !== INSTITUTION_PARTNER_DASHBOARD) {
    throw new Error(
        `Invalid Institution "${institution}" (expected ${INSTITUTION_PARTNER_DASHBOARD})`,
    );
  }
  if (channel !== CHANNEL_B2B) {
    throw new Error(`Invalid Channel "${channel}" (expected ${CHANNEL_B2B})`);
  }
  return { institution, channel };
}

/**
 * Ensure `users/{uid}` exists so dashboard login and consumer flows can resolve the profile.
 * Shape aligns with `userBootstrap` (name, email, balance, country, timestamps); idempotent.
 *
 * @param {string} uid
 * @param {{ email: string, displayName?: string|null, institution?: string, channel?: string }} opts
 * @returns {Promise<void>}
 */
async function ensureUserDashboardProfile(uid, { email, displayName, institution, channel }) {
  const normalizedEmail =
    email && String(email).trim()
      ? String(email).trim().toLowerCase()
      : null;
  const userRef = collection("users").doc(uid);
  const snap = await userRef.get();
  const nameParts = splitDisplayName(displayName);

  const provisioning =
      institution && channel ? { institution, channel } : null;

  if (!snap.exists) {
    /** @type {Record<string, unknown>} */
    const initial = {
      status: DEFAULT_DASHBOARD_USER_STATUS,
      email: normalizedEmail,
      createdAt: serverTimestamp(),
      balance: 0,
      country: null,
      updatedAt: serverTimestamp(),
    };
    if (nameParts.name) {
      initial.name = nameParts.name;
    }
    if (nameParts.firstName) {
      initial.firstName = nameParts.firstName;
    }
    if (nameParts.lastName) {
      initial.lastName = nameParts.lastName;
    }
    if (provisioning) {
      initial.institution = provisioning.institution;
      initial.channel = provisioning.channel;
    }
    if (isB2BPartnerDashboardUser(provisioning, null)) {
      initial.permissions = [...DEFAULT_B2B_PARTNER_PERMISSIONS];
    }
    await userRef.set(initial, { merge: true });
    return;
  }

  const existing = snap.data() || {};
  const updates = {};
  if (normalizedEmail) {
    const prev = existing.email ? String(existing.email).trim().toLowerCase() : "";
    if (!prev || prev !== normalizedEmail) {
      updates.email = normalizedEmail;
    }
  }
  if (!existing.status) {
    updates.status = DEFAULT_DASHBOARD_USER_STATUS;
  }
  if (nameParts.name && !existing.name && !existing.firstName) {
    updates.name = nameParts.name;
  }
  if (nameParts.firstName && !existing.firstName) {
    updates.firstName = nameParts.firstName;
  }
  if (nameParts.lastName && !existing.lastName) {
    updates.lastName = nameParts.lastName;
  }
  if (!("balance" in existing) && existing.balance === undefined) {
    updates.balance = 0;
  }
  if (!("country" in existing) && existing.country === undefined) {
    updates.country = null;
  }
  if (provisioning) {
    updates.institution = provisioning.institution;
    updates.channel = provisioning.channel;
  }
  if (
    isB2BPartnerDashboardUser(provisioning, existing) &&
    permissionsNeedDefaults(existing.permissions)
  ) {
    updates.permissions = [...DEFAULT_B2B_PARTNER_PERMISSIONS];
  }
  if (Object.keys(updates).length > 0) {
    updates.updatedAt = serverTimestamp();
    await userRef.update(updates);
  }
}

/**
 * Load Auth record and ensure `users/{uid}` exists (for HTTP bootstrap after sign-in).
 *
 * @param {string} uid
 * @param {{ institution?: string, channel?: string }} [provisioning]
 * @returns {Promise<void>}
 */
async function ensureUserDashboardProfileFromAuthUid(uid, provisioning = {}) {
  const userRecord = await admin.auth().getUser(uid);
  await ensureUserDashboardProfile(uid, {
    email: userRecord.email || "",
    displayName: userRecord.displayName || "",
    institution: provisioning.institution,
    channel: provisioning.channel,
  });
}

/**
 * @param {FirebaseFirestore.DocumentSnapshot} doc
 * @returns {Object}
 */
function serializeMemberDoc(doc) {
  if (!doc.exists) return null;
  const d = doc.data();
  return {
    userId: doc.id,
    email: d.email || null,
    displayName: d.displayName || null,
    role: d.role,
    status: d.status || "active",
    createdAt: d.createdAt?.toDate?.()?.toISOString() || null,
    updatedAt: d.updatedAt?.toDate?.()?.toISOString() || null,
    createdByUid: d.createdByUid || null,
  };
}

/**
 * Platform admin: assign or replace the single org admin for a partner.
 *
 * @param {string} partnerId
 * @param {string} newOrgAdminUid - Existing Firebase Auth UID
 * @param {string} actorUid - Platform admin uid, or same as newOrgAdminUid for self-serve
 * @param {{ selfServe?: boolean }} [opts]
 * @returns {Promise<{ partnerId: string, orgAdminUid: string }>}
 */
async function setPartnerOrgAdmin(partnerId, newOrgAdminUid, actorUid, opts = {}) {
  const selfServe = opts.selfServe === true;
  const partnerSnap = await collection("partners").doc(partnerId).get();
  if (!partnerSnap.exists) {
    throw new Error("Partner not found");
  }
  const prevOrgAdminUid = partnerSnap.data().orgAdminUid || null;

  let newUser;
  try {
    newUser = await admin.auth().getUser(newOrgAdminUid);
  } catch (e) {
    if (e.code === "auth/user-not-found") {
      throw new Error("User not found for org admin uid");
    }
    throw e;
  }

  const incomingClaims = await getCustomClaims(newOrgAdminUid);
  const incomingRole = normalizePartnerRole(
      incomingClaims.role || incomingClaims.partnerRole,
  );
  if (
    incomingClaims.partnerId &&
    incomingClaims.partnerId !== partnerId &&
    isPartnerOwnerRole(incomingRole)
  ) {
    throw new Error("User is already owner of another partner");
  }
  if (incomingClaims.partnerId && incomingClaims.partnerId !== partnerId) {
    throw new Error("User belongs to another partner; remove them there first or use a different account");
  }

  if (prevOrgAdminUid && prevOrgAdminUid !== newOrgAdminUid) {
    await clearPartnerClaims(prevOrgAdminUid);
    const prevRef = membersCollection(partnerId).doc(prevOrgAdminUid);
    const prevDoc = await prevRef.get();
    if (prevDoc.exists) {
      await prevRef.delete();
    }
  }

  await setPartnerAccessClaims(newOrgAdminUid, partnerId, PARTNER_ROLE_OWNER);

  await collection("partners").doc(partnerId).update({
    orgAdminUid: newOrgAdminUid,
    updatedAt: serverTimestamp(),
  });

  const email = newUser.email || "";
  /** @type {Record<string, unknown>} */
  const memberRow = {
    email,
    displayName: newUser.displayName || "",
    role: PARTNER_ROLE_OWNER,
    status: "active",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    createdByUid: actorUid,
  };
  if (selfServe) {
    memberRow.selfOnboardedAt = serverTimestamp();
    memberRow.assignedByPlatformAdminUid = null;
  } else {
    memberRow.assignedByPlatformAdminUid = actorUid;
  }
  await membersCollection(partnerId).doc(newOrgAdminUid).set(memberRow, { merge: true });

  await ensureUserDashboardProfile(newOrgAdminUid, {
    email,
    displayName: newUser.displayName || "",
    institution: INSTITUTION_PARTNER_DASHBOARD,
    channel: CHANNEL_B2B,
  });

  try {
    const onboarding = require("./b2bOnboardingService");
    await onboarding.mergeRegisteredPartnerIntoOnboarding(newOrgAdminUid, partnerId);
  } catch (linkErr) {
    console.warn("setPartnerOrgAdmin onboarding link:", linkErr.message);
  }

  await syncUserDocAccessFields(newOrgAdminUid, {
    userType: USER_TYPE_PARTNER,
    partnerId,
    role: PARTNER_ROLE_OWNER,
    status: "active",
  });

  return { partnerId, orgAdminUid: newOrgAdminUid };
}

/**
 * @param {string} partnerId
 * @returns {Promise<Object[]>}
 */
async function listMembers(partnerId) {
  const snap = await membersCollection(partnerId).get();
  return snap.docs.map((doc) => serializeMemberDoc(doc)).filter(Boolean);
}

/**
 * Org admin: invite/create a Firebase user and attach to partner with an assignable role.
 *
 * @param {string} partnerId
 * @param {{ email: string, password: string, role: string, displayName?: string }} input
 * @param {string} actorUid - org admin uid
 * @returns {Promise<{ userId: string, email: string, role: string }>}
 */
async function addMember(partnerId, { email, password, role, displayName }, actorUid) {
  const rawRole = String(role || "").trim();
  const claimRole = normalizePartnerRole(rawRole);
  if (!ASSIGNABLE_ROLES.includes(claimRole)) {
    throw new Error(`Invalid role. Must be one of: ${ASSIGNABLE_ROLES.join(", ")}`);
  }
  const normalizedEmail = String(email).trim().toLowerCase();
  if (!normalizedEmail) {
    throw new Error("Valid email is required");
  }

  let userRecord;
  try {
    userRecord = await admin.auth().getUserByEmail(normalizedEmail);
  } catch (e) {
    if (e.code !== "auth/user-not-found") {
      throw e;
    }
    userRecord = null;
  }

  if (!userRecord) {
    if (!password || String(password).length < 8) {
      throw new Error("Password (min 8 characters) is required for new users");
    }
    userRecord = await admin.auth().createUser({
      email: normalizedEmail,
      password: String(password),
      displayName: displayName || undefined,
      emailVerified: false,
    });
  } else {
    if (password && String(password).length >= 8) {
      await admin.auth().updateUser(userRecord.uid, { password: String(password) });
    }
    const claims = await getCustomClaims(userRecord.uid);
    if (claims.partnerId && claims.partnerId !== partnerId) {
      throw new Error("User already belongs to another partner");
    }
  }

  const uid = userRecord.uid;

  await setPartnerAccessClaims(uid, partnerId, claimRole);

  await membersCollection(partnerId).doc(uid).set(
    {
      email: normalizedEmail,
      displayName: displayName || userRecord.displayName || "",
      role: claimRole,
      status: "active",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdByUid: actorUid,
    },
    { merge: true },
  );

  await ensureUserDashboardProfile(uid, {
    email: normalizedEmail,
    displayName: displayName || userRecord.displayName || "",
    institution: INSTITUTION_PARTNER_DASHBOARD,
    channel: CHANNEL_B2B,
  });

  await syncUserDocAccessFields(uid, {
    userType: USER_TYPE_PARTNER,
    partnerId,
    role: claimRole,
    status: "active",
  });

  try {
    const onboarding = require("./b2bOnboardingService");
    await onboarding.mergeRegisteredPartnerIntoOnboarding(uid, partnerId);
  } catch (linkErr) {
    console.warn("addMember onboarding link:", linkErr.message);
  }

  return { userId: uid, email: normalizedEmail, role: claimRole };
}

/**
 * Org admin: change role of a non–org-admin member.
 *
 * @param {string} partnerId
 * @param {string} targetUid
 * @param {string} role - assignable institutional role
 * @returns {Promise<void>}
 */
async function updateMemberRole(partnerId, targetUid, role) {
  const claimRole = normalizePartnerRole(role);
  if (!ASSIGNABLE_ROLES.includes(claimRole)) {
    throw new Error(`Invalid role. Must be one of: ${ASSIGNABLE_ROLES.join(", ")}`);
  }

  const memberRef = membersCollection(partnerId).doc(targetUid);
  const memberDoc = await memberRef.get();
  if (!memberDoc.exists) {
    throw new Error("Member not found");
  }
  const data = memberDoc.data();
  if (isPartnerOwnerRole(data.role)) {
    throw new Error("Cannot change partner owner role from the portal; platform admin must reassign owner");
  }

  await setPartnerAccessClaims(targetUid, partnerId, claimRole);

  await memberRef.update({
    role: claimRole,
    updatedAt: serverTimestamp(),
  });

  await syncUserDocAccessFields(targetUid, {
    userType: USER_TYPE_PARTNER,
    partnerId,
    role: claimRole,
    status: "active",
  });
}

/**
 * Org admin: remove a member from the partner (not org admin).
 *
 * @param {string} partnerId
 * @param {string} targetUid
 * @returns {Promise<void>}
 */
async function removeMember(partnerId, targetUid) {
  const memberRef = membersCollection(partnerId).doc(targetUid);
  const memberDoc = await memberRef.get();
  if (!memberDoc.exists) {
    throw new Error("Member not found");
  }
  if (isPartnerOwnerRole(memberDoc.data().role)) {
    throw new Error("Cannot remove partner owner; platform admin must assign a new owner");
  }

  await clearPartnerClaims(targetUid);
  await memberRef.delete();
}

/**
 * @param {string} role
 * @returns {boolean}
 */
function isAssignablePartnerRole(role) {
  const normalized = normalizePartnerRole(role);
  return ASSIGNABLE_ROLES.includes(normalized) ||
    LEGACY_ASSIGNABLE_PARTNER_ROLES.includes(String(role || "").trim());
}

module.exports = {
  MEMBERS_SUB,
  ASSIGNABLE_ROLES,
  ALL_PARTNER_ROLES,
  PARTNER_ROLE_OWNER,
  INSTITUTION_PARTNER_DASHBOARD,
  CHANNEL_B2B,
  setPartnerOrgAdmin,
  listMembers,
  addMember,
  updateMemberRole,
  removeMember,
  isAssignablePartnerRole,
  parsePortalProvisioningFields,
  ensureUserDashboardProfile,
  ensureUserDashboardProfileFromAuthUid,
};
