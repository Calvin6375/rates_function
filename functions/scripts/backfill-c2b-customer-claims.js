#!/usr/bin/env node
/**
 * Backfill { userType: "customer" } for legacy C2B consumer accounts.
 *
 * Targets Firestore users/{uid} rows that look like C2B customers but lack the
 * customer custom claim (common for accounts created before POST /api/register
 * set claims, or via userBootstrap only).
 *
 * Skips partner and platform-admin users (including B2B dashboard signups —
 * use backfill-b2b-partner-orgs.js for those).
 *
 * Usage (from functions/):
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json node scripts/backfill-c2b-customer-claims.js
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json node scripts/backfill-c2b-customer-claims.js --apply
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json node scripts/backfill-c2b-customer-claims.js --email andrew@gmail.com --apply
 *
 * Default is dry-run (prints actions only).
 */

require("../admin");

const admin = require("../admin");
const { collection } = require("../libs/firestore");
const { getCustomClaims } = require("../utils/customClaimsMerge");
const {
  INSTITUTION_CUSTOMER_APP,
  CHANNEL_C2B,
} = require("../utils/customerAppProvisioning");
const {
  USER_TYPE_CUSTOMER,
  USER_TYPE_PARTNER,
  USER_TYPE_ADMIN,
  PLATFORM_ADMINS_COL,
  setCustomerAccessClaims,
  syncUserDocAccessFields,
} = require("../utils/accessControl");

const INSTITUTION_PARTNER_DASHBOARD = "PartnerDashboard";
const CHANNEL_B2B = "B2B";
const ONBOARDING_COL = "onboarding";

/**
 * @param {string[]} argv
 * @returns {{ apply: boolean, help: boolean, uid: string|null, email: string|null }}
 */
function parseArgs(argv) {
  const uidIndex = argv.indexOf("--uid");
  const emailIndex = argv.indexOf("--email");
  return {
    apply: argv.includes("--apply"),
    help: argv.includes("--help") || argv.includes("-h"),
    uid: uidIndex !== -1 ? String(argv[uidIndex + 1] || "").trim() || null : null,
    email: emailIndex !== -1 ? String(argv[emailIndex + 1] || "").trim() || null : null,
  };
}

function usage() {
  console.log(`
Backfill customer custom claims for legacy C2B users

Options:
  --apply           Write repairs (default is dry-run)
  --uid <uid>       Process a single Auth/Firestore uid
  --email <email>   Process a single user by email (resolves to uid)
  --help, -h        Show this help

Requires GOOGLE_APPLICATION_CREDENTIALS or gcloud application-default credentials.
`);
}

/**
 * @returns {Promise<Set<string>>}
 */
async function loadPartnerOrgAdminUids() {
  const snap = await collection("partners").get();
  const uids = new Set();
  for (const doc of snap.docs) {
    const orgAdminUid = doc.data()?.orgAdminUid;
    if (typeof orgAdminUid === "string" && orgAdminUid.trim()) {
      uids.add(orgAdminUid.trim());
    }
  }
  return uids;
}

/**
 * @returns {Promise<Set<string>>}
 */
async function loadOnboardingPartnerUids() {
  const snap = await collection(ONBOARDING_COL).get();
  const uids = new Set();
  for (const doc of snap.docs) {
    const registeredPartnerId = doc.data()?.registeredPartnerId;
    if (registeredPartnerId && String(registeredPartnerId).trim()) {
      uids.add(doc.id);
    }
  }
  return uids;
}

/**
 * @returns {Promise<Set<string>>}
 */
async function loadPlatformAdminUids() {
  const snap = await collection(PLATFORM_ADMINS_COL).get();
  return new Set(snap.docs.map((doc) => doc.id));
}

/**
 * @param {Object|null|undefined} claims
 * @returns {boolean}
 */
function hasCustomerClaim(claims) {
  return claims?.userType === USER_TYPE_CUSTOMER;
}

/**
 * @param {string} uid
 * @param {Object|null|undefined} claims
 * @param {Object|null|undefined} userData
 * @param {Set<string>} partnerOrgAdminUids
 * @param {Set<string>} onboardingPartnerUids
 * @param {Set<string>} platformAdminUids
 * @returns {string|null} skip reason, or null if eligible
 */
function skipReason(
    uid,
    claims,
    userData,
    partnerOrgAdminUids,
    onboardingPartnerUids,
    platformAdminUids,
) {
  const data = userData || {};
  const institution = typeof data.institution === "string" ? data.institution.trim() : "";
  const channel = typeof data.channel === "string" ? data.channel.trim() : "";

  if (claims?.userType === USER_TYPE_PARTNER || claims?.partnerId) {
    return "skip-partner-claims";
  }
  if (claims?.partnerRole) {
    return "skip-legacy-partner-claims";
  }
  if (institution === INSTITUTION_PARTNER_DASHBOARD && channel === CHANNEL_B2B) {
    return "skip-b2b-dashboard-user";
  }
  if (partnerOrgAdminUids.has(uid)) {
    return "skip-partner-org-admin";
  }
  if (onboardingPartnerUids.has(uid)) {
    return "skip-onboarding-partner";
  }
  if (claims?.userType === USER_TYPE_ADMIN || claims?.admin === true) {
    return "skip-admin-claims";
  }
  if (platformAdminUids.has(uid)) {
    return "skip-platform-admin";
  }
  return null;
}

/**
 * @param {string} uid
 * @param {Object|null|undefined} userData
 * @param {boolean} apply
 * @returns {Promise<Object>}
 */
async function applyCustomerBackfill(uid, userData, apply) {
  const data = userData || {};
  const email = data.email ? String(data.email).trim().toLowerCase() : "";

  let claims = {};
  try {
    claims = await getCustomClaims(uid);
  } catch (err) {
    if (err.code === "auth/user-not-found") {
      return {uid, email, status: "auth-user-missing"};
    }
    throw err;
  }

  const claimOk = hasCustomerClaim(claims);
  const docUserType =
    typeof data.userType === "string" && data.userType.trim() ?
      data.userType.trim() :
      null;
  const docOk = docUserType === USER_TYPE_CUSTOMER;

  if (claimOk && docOk) {
    return {uid, email, status: "ok"};
  }

  if (claimOk && !docOk) {
    if (apply) {
      await syncUserDocAccessFields(uid, {
        userType: USER_TYPE_CUSTOMER,
        ...(!data.status ? {status: "active"} : {}),
      });
    }
    return {
      uid,
      email,
      status: apply ? "synced-doc" : "would-sync-doc",
    };
  }

  if (apply) {
    await setCustomerAccessClaims(uid);
    await syncUserDocAccessFields(uid, {
      userType: USER_TYPE_CUSTOMER,
      ...(!data.status ? {status: "active"} : {}),
    });
  }

  const institution = data.institution || null;
  const channel = data.channel || null;
  const taggedC2b =
    institution === INSTITUTION_CUSTOMER_APP && channel === CHANNEL_C2B;

  return {
    uid,
    email,
    status: apply ? "backfilled" : "would-backfill",
    institution,
    channel,
    legacy: !taggedC2b,
  };
}

/**
 * @param {FirebaseFirestore.QueryDocumentSnapshot} userDoc
 * @param {Object} context
 * @returns {Promise<Object>}
 */
async function processUser(userDoc, context) {
  const uid = userDoc.id;
  const userData = userDoc.data() || {};
  const email = userData.email ? String(userData.email).trim().toLowerCase() : "";

  let claims = {};
  try {
    claims = await getCustomClaims(uid);
  } catch (err) {
    if (err.code === "auth/user-not-found") {
      return {uid, email, status: "auth-user-missing"};
    }
    throw err;
  }

  const reason = skipReason(
      uid,
      claims,
      userData,
      context.partnerOrgAdminUids,
      context.onboardingPartnerUids,
      context.platformAdminUids,
  );
  if (reason) {
    return {uid, email, status: reason};
  }

  if (hasCustomerClaim(claims) && userData.userType === USER_TYPE_CUSTOMER) {
    return {uid, email, status: "ok"};
  }

  return applyCustomerBackfill(uid, userData, context.apply);
}

/**
 * @param {string} uid
 * @param {Object} context
 * @returns {Promise<Object>}
 */
async function processSingleUid(uid, context) {
  const userSnap = await collection("users").doc(uid).get();
  if (!userSnap.exists) {
    return {uid, status: "firestore-user-missing"};
  }
  return processUser(userSnap, context);
}

/**
 * @param {string} email
 * @param {Object} context
 * @returns {Promise<Object>}
 */
async function processSingleEmail(email, context) {
  const normalized = email.trim().toLowerCase();
  let userRecord;
  try {
    userRecord = await admin.auth().getUserByEmail(normalized);
  } catch (err) {
    if (err.code === "auth/user-not-found") {
      return {email: normalized, status: "auth-user-missing"};
    }
    throw err;
  }
  return processSingleUid(userRecord.uid, context);
}

async function main() {
  const { apply, help, uid, email } = parseArgs(process.argv.slice(2));
  if (help) {
    usage();
    process.exit(0);
  }

  if (uid && email) {
    console.error("Use only one of --uid or --email.");
    process.exit(1);
  }

  console.log(apply ?
    "Running in APPLY mode (writes enabled)." :
    "Dry-run mode (pass --apply to write repairs).");

  const context = {
    apply,
    partnerOrgAdminUids: await loadPartnerOrgAdminUids(),
    onboardingPartnerUids: await loadOnboardingPartnerUids(),
    platformAdminUids: await loadPlatformAdminUids(),
  };

  /** @type {Object[]} */
  const rows = [];

  if (email) {
    rows.push(await processSingleEmail(email, context));
  } else if (uid) {
    rows.push(await processSingleUid(uid, context));
  } else {
    const snap = await collection("users").get();
    console.log(`Scanning ${snap.size} users/{uid} document(s).\n`);
    for (const userDoc of snap.docs) {
      rows.push(await processUser(userDoc, context));
    }
  }

  /** @type {Record<string, number>} */
  const counts = {};
  for (const row of rows) {
    counts[row.status] = (counts[row.status] || 0) + 1;
    console.log(JSON.stringify(row));
  }

  console.log("\nSummary:");
  for (const [status, count] of Object.entries(counts).sort()) {
    console.log(`  ${status}: ${count}`);
  }

  const actionable = rows.filter((row) =>
    row.status.startsWith("would-") ||
    row.status === "auth-user-missing" ||
    row.status === "firestore-user-missing",
  );

  if (!apply && actionable.length) {
    console.log(
        `\n${actionable.length} user(s) can be repaired. Re-run with --apply to write.`,
    );
    process.exitCode = 1;
  }

  if (apply) {
    const repaired = rows.filter((row) =>
      row.status === "backfilled" || row.status === "synced-doc",
    );
    if (repaired.length) {
      console.log(
          "\nUsers must sign out/in (or refresh ID token) for new claims to apply.",
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
