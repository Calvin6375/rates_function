/**
 * @fileoverview B2B self-serve onboarding: Firestore onboarding/{uid} and
 * register partner as org admin. Platform flow: POST /platform/partners +
 * PUT .../org-admin.
 */

const {collection, serverTimestamp} = require("../libs/firestore");
const {getCustomClaims} = require("../utils/customClaimsMerge");
const {
  normalizePartnerRole,
  isPartnerOwnerRole,
} = require("../utils/accessControl");
const {deepMerge} = require("../utils/objectDeepMerge");
const partnerService = require("./partnerService");
const b2bMemberService = require("./b2bMemberService");

const ONBOARDING_COL = "onboarding";

/** Top-level fields clients may PATCH (validated merge). */
const PATCHABLE_KEYS = [
  "business", "owner", "payments", "kyc",
  "useCases", "terms", "progress", "sandbox",
];

/** Ordered onboarding stages (frontend syncOnboardingStatus). */
const ONBOARDING_STATUSES = [
  "draft",
  "email_verified",
  "profile_complete",
  "credentials_ready",
  "payment_links_ready",
  "submitted",
  "active",
];

/** @type {readonly Set<string>} */
const TERMINAL_ONBOARDING_STATUSES = new Set(["submitted", "active"]);

/** @type {readonly string[]} */
const PATCH_ACCEPTED_KEYS = [...PATCHABLE_KEYS, "onboardingStatus"];

/**
 * @param {unknown} status
 * @return {number}
 */
function onboardingStatusRank(status) {
  const idx = ONBOARDING_STATUSES.indexOf(String(status).trim());
  return idx;
}

/**
 * Apply client onboardingStatus only when it advances (never downgrade).
 *
 * @param {unknown} existingStatus
 * @param {unknown} patchStatus
 * @return {string}
 */
function resolveOnboardingStatusPatch(existingStatus, patchStatus) {
  const next = patchStatus != null ? String(patchStatus).trim() : "";
  if (!next) {
    throw new Error("onboardingStatus must be a non-empty string");
  }
  if (!ONBOARDING_STATUSES.includes(next)) {
    throw new Error(
        `Invalid onboardingStatus "${next}" (expected one of: ${ONBOARDING_STATUSES.join(", ")})`,
    );
  }

  const currentRaw =
    existingStatus != null && String(existingStatus).trim() ?
      String(existingStatus).trim() :
      "draft";
  const current = ONBOARDING_STATUSES.includes(currentRaw) ? currentRaw : "draft";
  const currentRank = onboardingStatusRank(current);
  const nextRank = onboardingStatusRank(next);

  if (TERMINAL_ONBOARDING_STATUSES.has(current) && nextRank < currentRank) {
    return current;
  }
  if (nextRank < currentRank) {
    return current;
  }
  return next;
}

/**
 * @param {unknown} v
 * @return {unknown}
 */
function serializeValue(v) {
  if (v === null || v === undefined) return v;
  if (typeof v === "object" && v !== null && typeof v.toDate === "function") {
    try {
      return v.toDate().toISOString();
    } catch (_e) {
      return null;
    }
  }
  if (Array.isArray(v)) {
    return v.map(serializeValue);
  }
  if (typeof v === "object" && v !== null && !(v instanceof Date)) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = serializeValue(val);
    }
    return out;
  }
  return v;
}

/**
 * @param {FirebaseFirestore.DocumentData|null|undefined} data
 * @return {Object|null}
 */
function serializeOnboardingDoc(data) {
  if (!data) return null;
  return /** @type {Object} */ (serializeValue(data));
}

/**
 * @param {string} uid
 * @return {FirebaseFirestore.DocumentReference}
 */
function onboardingRef(uid) {
  return collection(ONBOARDING_COL).doc(uid);
}

/**
 * @param {string} uid
 * @return {Promise<Object|null>}
 */
async function getOnboarding(uid) {
  const snap = await onboardingRef(uid).get();
  if (!snap.exists) return null;
  return serializeOnboardingDoc(snap.data());
}

/**
 * Deep-merge allowed section keys into onboarding/{uid}.
 *
 * @param {string} uid
 * @param {Record<string, unknown>} partial
 * @return {Promise<Object>} serialized doc after write
 */
async function patchOnboarding(uid, partial) {
  if (!partial || typeof partial !== "object") {
    throw new Error("Body must be a JSON object");
  }
  const ref = onboardingRef(uid);
  const snap = await ref.get();
  const existing = snap.exists ? snap.data() || {} : {};

  /** @type {Record<string, unknown>} */
  const updates = {updatedAt: serverTimestamp()};
  for (const key of PATCHABLE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(partial, key)) {
      const prev = existing[key];
      updates[key] = deepMerge(prev, partial[key]);
    }
  }
  if (Object.prototype.hasOwnProperty.call(partial, "onboardingStatus")) {
    updates.onboardingStatus = resolveOnboardingStatusPatch(
        existing.onboardingStatus,
        partial.onboardingStatus,
    );
  }
  if (Object.keys(updates).length <= 1) {
    throw new Error(`Provide at least one of: ${PATCH_ACCEPTED_KEYS.join(", ")}`);
  }
  if (!snap.exists) {
    updates.createdAt = serverTimestamp();
    if (!Object.prototype.hasOwnProperty.call(updates, "onboardingStatus")) {
      updates.onboardingStatus = "draft";
    }
  }
  await ref.set(updates, {merge: true});
  const out = await ref.get();
  return serializeOnboardingDoc(out.data()) || {};
}

/**
 * Self-serve: create partner (pending_review), assign caller as org_admin,
 * persist onboarding.registeredPartnerId. Idempotent for existing org_admin.
 *
 * @param {string} uid
 * @param {Object} input
 * @param {string} input.name
 * @param {string} [input.settlementCurrency]
 * @param {string|null} [input.webhookUrl]
 * @return {Promise<Object>} partnerId, optional apiKey, orgAdminUid,
 *     alreadyRegistered
 */
async function registerSelfServePartner(uid, input) {
  const name = input.name && String(input.name).trim();
  if (!name) {
    throw new Error("name is required (business or partner display name)");
  }

  const claims = await getCustomClaims(uid);
  const claimPid = claims.partnerId;
  const claimRole = normalizePartnerRole(claims.role || claims.partnerRole);

  if (claimPid && typeof claimPid === "string" && claimRole &&
      !isPartnerOwnerRole(claimRole)) {
    throw new Error(
        "Account already linked to a partner; self-registration unavailable.",
    );
  }

  if (claimPid && isPartnerOwnerRole(claimRole)) {
    const partner = await partnerService.getPartner(claimPid);
    if (!partner) {
      throw new Error("Partner missing for your account; contact support.");
    }
    if (partner.orgAdminUid && partner.orgAdminUid !== uid) {
      throw new Error("Partner org admin mismatch; contact support.");
    }
    await mergeRegisteredPartnerIntoOnboarding(uid, claimPid);
    return {partnerId: claimPid, orgAdminUid: uid, alreadyRegistered: true};
  }

  const obSnap = await onboardingRef(uid).get();
  const ob = obSnap.exists ? obSnap.data() : {};
  const existingReg =
    ob && ob.registeredPartnerId ? String(ob.registeredPartnerId) : null;

  if (existingReg) {
    const partner = await partnerService.getPartner(existingReg);
    if (!partner) {
      throw new Error("Onboarding references missing partner.");
    }
    if (partner.orgAdminUid && partner.orgAdminUid !== uid) {
      throw new Error("Onboarding partner is assigned to another user.");
    }
    await b2bMemberService.setPartnerOrgAdmin(
        existingReg, uid, uid, {selfServe: true},
    );
    await mergeRegisteredPartnerIntoOnboarding(uid, existingReg);
    return {partnerId: existingReg, orgAdminUid: uid, alreadyRegistered: true};
  }

  const settlementCurrency =
    input.settlementCurrency ? String(input.settlementCurrency) : "KES";
  const webhookUrl =
    input.webhookUrl !== undefined && input.webhookUrl !== null ?
      String(input.webhookUrl) :
      null;

  const created = await partnerService.createPartner({
    name,
    settlementCurrency,
    webhookUrl,
    status: "pending_review",
    onboardingSource: "self",
  });

  await b2bMemberService.setPartnerOrgAdmin(
      created.partnerId, uid, uid, {selfServe: true},
  );

  await onboardingRef(uid).set(
      {
        registeredPartnerId: created.partnerId,
        onboardingStatus: "email_verified",
        updatedAt: serverTimestamp(),
        createdAt: serverTimestamp(),
      },
      {merge: true},
  );

  return {
    partnerId: created.partnerId,
    apiKey: created.apiKey,
    orgAdminUid: uid,
    alreadyRegistered: false,
  };
}

/**
 * @param {string} uid
 * @param {string} partnerId
 * @return {Promise<void>}
 */
async function mergeRegisteredPartnerIntoOnboarding(uid, partnerId) {
  await onboardingRef(uid).set(
      {
        registeredPartnerId: partnerId,
        updatedAt: serverTimestamp(),
      },
      {merge: true},
  );
}

/**
 * Mark onboarding submitted after terms (live API needs platform activation).
 *
 * @param {string} uid
 * @param {Object} attestation
 * @param {boolean} attestation.termsAccepted
 * @param {boolean} attestation.amlAccepted
 * @return {Promise<Object>} onboardingStatus, partnerId
 */
async function completeOnboarding(uid, attestation) {
  const termsOk = attestation.termsAccepted === true;
  const amlOk = attestation.amlAccepted === true;
  if (!termsOk || !amlOk) {
    throw new Error("termsAccepted and amlAccepted must both be true");
  }

  const claims = await getCustomClaims(uid);
  let partnerId =
    typeof claims.partnerId === "string" && claims.partnerId.trim() ?
      claims.partnerId.trim() :
      null;

  const obSnap = await onboardingRef(uid).get();
  const ob = obSnap.exists ? obSnap.data() : {};
  if (!partnerId && ob && ob.registeredPartnerId) {
    partnerId = String(ob.registeredPartnerId);
  }

  if (!partnerId) {
    throw new Error(
        "Register partner first (POST /portal/onboarding/register-partner).",
    );
  }

  if (claims.partnerRole || claims.role) {
    const ownerRole = normalizePartnerRole(claims.role || claims.partnerRole);
    if (!isPartnerOwnerRole(ownerRole)) {
      throw new Error("Only the partner owner can complete onboarding");
    }
  }
  if (claims.partnerId && claims.partnerId !== partnerId) {
    throw new Error("Token partnerId does not match onboarding partner");
  }

  const partner = await partnerService.getPartner(partnerId);
  if (!partner || partner.orgAdminUid !== uid) {
    throw new Error("Partner not found or you are not the org admin");
  }

  const termsPatch = {
    termsAccepted: true,
    amlAccepted: true,
    acceptedAt: serverTimestamp(),
  };

  await onboardingRef(uid).set(
      {
        terms: {...(ob.terms || {}), ...termsPatch},
        onboardingStatus: "submitted",
        submittedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
      {merge: true},
  );

  const businessName =
    ob.business && typeof ob.business === "object" && ob.business.name ?
      String(ob.business.name).trim() :
      "";
  if (businessName && partner.name !== businessName) {
    await partnerService.updatePartner(partnerId, {name: businessName});
  }

  return {onboardingStatus: "submitted", partnerId};
}

/**
 * Whether the onboarding "Go live" checklist step is complete.
 * True when progress.goLiveDone is set or the linked partner status is active.
 *
 * @param {string} uid
 * @param {string|null|undefined} partnerIdFromToken
 * @return {Promise<boolean>}
 */
async function resolveGoLiveDone(uid, partnerIdFromToken) {
  const snap = await onboardingRef(uid).get();
  const ob = snap.exists ? snap.data() : null;
  if (ob?.progress?.goLiveDone === true) {
    return true;
  }

  let partnerId =
    partnerIdFromToken && String(partnerIdFromToken).trim() ?
      String(partnerIdFromToken).trim() :
      null;
  if (!partnerId && ob?.registeredPartnerId) {
    partnerId = String(ob.registeredPartnerId);
  }
  if (!partnerId) {
    return false;
  }

  const partner = await partnerService.getPartner(partnerId);
  return partner != null && String(partner.status).toLowerCase() === "active";
}

/**
 * Persist goLiveDone on the org admin onboarding doc when platform activates a partner.
 *
 * @param {string} partnerId
 * @return {Promise<void>}
 */
async function markGoLiveDoneForPartner(partnerId) {
  const partner = await partnerService.getPartner(partnerId);
  if (!partner) {
    return;
  }
  const uid = partner.orgAdminUid;
  if (!uid || typeof uid !== "string") {
    return;
  }

  const ref = onboardingRef(uid);
  const snap = await ref.get();
  const raw = snap.exists ? snap.data() : {};
  await ref.set(
      {
        progress: {
          ...(raw.progress || {}),
          goLiveDone: true,
          goLiveAt: serverTimestamp(),
        },
        updatedAt: serverTimestamp(),
      },
      {merge: true},
  );
}

/**
 * Derive a display name for a new partner org from onboarding and profile data.
 *
 * @param {Object|null|undefined} onboarding
 * @param {Object|null|undefined} userData
 * @param {string|null|undefined} email
 * @return {string|null}
 */
function derivePartnerName(onboarding, userData, email) {
  const business = onboarding?.business;
  if (business && typeof business === "object") {
    if (business.name && String(business.name).trim()) {
      return String(business.name).trim();
    }
    if (business.legalName && String(business.legalName).trim()) {
      return String(business.legalName).trim();
    }
  }
  const owner = onboarding?.owner;
  if (owner && typeof owner === "object") {
    if (owner.businessName && String(owner.businessName).trim()) {
      return String(owner.businessName).trim();
    }
    if (owner.fullName && String(owner.fullName).trim()) {
      return String(owner.fullName).trim();
    }
  }
  if (userData?.name && String(userData.name).trim()) {
    return String(userData.name).trim();
  }
  const resolvedEmail =
    email && String(email).trim() ?
      String(email).trim().toLowerCase() :
      userData?.email && String(userData.email).includes("@") ?
        String(userData.email).trim().toLowerCase() :
        null;
  if (resolvedEmail && resolvedEmail.includes("@")) {
    const local = resolvedEmail.split("@")[0].trim();
    if (local) {
      return local.replace(/[._+-]+/g, " ").trim() || null;
    }
  }
  return null;
}

/**
 * Idempotent: after email verification, ensure the user has a linked partner org.
 * Sandbox registration is not required. Returns null when email is not verified.
 *
 * @param {string} uid
 * @param {{ emailVerified?: boolean, email?: string|null }} opts
 * @return {Promise<Object|null>}
 */
async function ensurePartnerOrgOnEmailVerified(uid, opts = {}) {
  if (opts.emailVerified !== true) {
    return null;
  }

  const claims = await getCustomClaims(uid);
  const claimPid =
    typeof claims.partnerId === "string" && claims.partnerId.trim() ?
      claims.partnerId.trim() :
      null;
  if (claimPid) {
    const partner = await partnerService.getPartner(claimPid);
    if (partner) {
      return {
        partnerId: claimPid,
        orgAdminUid: partner.orgAdminUid || uid,
        alreadyRegistered: true,
      };
    }
  }

  const obSnap = await onboardingRef(uid).get();
  const onboarding = obSnap.exists ? obSnap.data() : null;
  const userSnap = await collection("users").doc(uid).get();
  const userData = userSnap.exists ? userSnap.data() : null;

  let partnerName = derivePartnerName(onboarding, userData, opts.email);
  if (!partnerName) {
    partnerName = `Partner ${uid.slice(0, 8)}`;
  }

  const out = await registerSelfServePartner(uid, {name: partnerName});

  await onboardingRef(uid).set(
      {
        onboardingStatus: "email_verified",
        updatedAt: serverTimestamp(),
      },
      {merge: true},
  );

  return out;
}

module.exports = {
  ONBOARDING_COL,
  PATCHABLE_KEYS,
  ONBOARDING_STATUSES,
  getOnboarding,
  patchOnboarding,
  registerSelfServePartner,
  completeOnboarding,
  resolveGoLiveDone,
  markGoLiveDoneForPartner,
  serializeOnboardingDoc,
  derivePartnerName,
  ensurePartnerOrgOnEmailVerified,
};
