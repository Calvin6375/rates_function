/**
 * @fileoverview B2B partner org structure: one org admin per partner (set by platform admin),
 * org admin manages members with roles member | viewer. Custom claims: partnerId, partnerRole.
 */

const admin = require("../admin");
const { collection, serverTimestamp } = require("../libs/firestore");
const partnerService = require("./partnerService");
const { mergeCustomUserClaims, clearPartnerClaims, getCustomClaims } = require("../utils/customClaimsMerge");

const MEMBERS_SUB = "members";

/** @type {readonly string[]} */
const ASSIGNABLE_ROLES = ["member", "viewer"];

/** @type {readonly string[]} */
const ALL_PARTNER_ROLES = ["org_admin", "member", "viewer"];

/**
 * @param {string} partnerId
 * @returns {import("firebase-admin/firestore").CollectionReference}
 */
function membersCollection(partnerId) {
  return collection("partners").doc(partnerId).collection(MEMBERS_SUB);
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
 * @param {string} actorUid - Platform admin uid (for audit)
 * @returns {Promise<{ partnerId: string, orgAdminUid: string }>}
 */
async function setPartnerOrgAdmin(partnerId, newOrgAdminUid, actorUid) {
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
  if (
    incomingClaims.partnerId &&
    incomingClaims.partnerId !== partnerId &&
    incomingClaims.partnerRole === "org_admin"
  ) {
    throw new Error("User is already org admin of another partner");
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

  await mergeCustomUserClaims(newOrgAdminUid, {
    partnerId,
    partnerRole: "org_admin",
  });

  await collection("partners").doc(partnerId).update({
    orgAdminUid: newOrgAdminUid,
    updatedAt: serverTimestamp(),
  });

  const email = newUser.email || "";
  await membersCollection(partnerId).doc(newOrgAdminUid).set(
    {
      email,
      displayName: newUser.displayName || "",
      role: "org_admin",
      status: "active",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdByUid: actorUid,
      assignedByPlatformAdminUid: actorUid,
    },
    { merge: true },
  );

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
 * Org admin: invite/create a Firebase user and attach to partner with role member|viewer.
 *
 * @param {string} partnerId
 * @param {{ email: string, password: string, role: string, displayName?: string }} input
 * @param {string} actorUid - org admin uid
 * @returns {Promise<{ userId: string, email: string, role: string }>}
 */
async function addMember(partnerId, { email, password, role, displayName }, actorUid) {
  if (!ASSIGNABLE_ROLES.includes(role)) {
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

  await mergeCustomUserClaims(uid, {
    partnerId,
    partnerRole: role,
  });

  await membersCollection(partnerId).doc(uid).set(
    {
      email: normalizedEmail,
      displayName: displayName || userRecord.displayName || "",
      role,
      status: "active",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdByUid: actorUid,
    },
    { merge: true },
  );

  return { userId: uid, email: normalizedEmail, role };
}

/**
 * Org admin: change role of a non–org-admin member.
 *
 * @param {string} partnerId
 * @param {string} targetUid
 * @param {string} role - member | viewer
 * @returns {Promise<void>}
 */
async function updateMemberRole(partnerId, targetUid, role) {
  if (!ASSIGNABLE_ROLES.includes(role)) {
    throw new Error(`Invalid role. Must be one of: ${ASSIGNABLE_ROLES.join(", ")}`);
  }

  const memberRef = membersCollection(partnerId).doc(targetUid);
  const memberDoc = await memberRef.get();
  if (!memberDoc.exists) {
    throw new Error("Member not found");
  }
  const data = memberDoc.data();
  if (data.role === "org_admin") {
    throw new Error("Cannot change org admin role from the portal; platform admin must reassign org admin");
  }

  await mergeCustomUserClaims(targetUid, {
    partnerId,
    partnerRole: role,
  });

  await memberRef.update({
    role,
    updatedAt: serverTimestamp(),
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
  if (memberDoc.data().role === "org_admin") {
    throw new Error("Cannot remove org admin; platform admin must assign a new org admin");
  }

  await clearPartnerClaims(targetUid);
  await memberRef.delete();
}

/**
 * @param {string} role
 * @returns {boolean}
 */
function isAssignablePartnerRole(role) {
  return ASSIGNABLE_ROLES.includes(role);
}

module.exports = {
  MEMBERS_SUB,
  ASSIGNABLE_ROLES,
  ALL_PARTNER_ROLES,
  setPartnerOrgAdmin,
  listMembers,
  addMember,
  updateMemberRole,
  removeMember,
  isAssignablePartnerRole,
};
