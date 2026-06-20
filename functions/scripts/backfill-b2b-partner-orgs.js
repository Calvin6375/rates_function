#!/usr/bin/env node
/**
 * Audit and repair B2B dashboard users missing a linked partner org.
 *
 * Finds `users` with institution PartnerDashboard + channel B2B, then for each:
 * - ok: partnerId claim and partners/{id} exist
 * - repair-claims: onboarding or orgAdminUid links to a partner but claims missing
 * - link-existing: partner row exists with orgAdminUid but onboarding not linked
 * - create-partner: no partner row — creates pending_review org (self-serve path)
 * - broken / manual: needs human review
 *
 * Usage (from functions/):
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json node scripts/backfill-b2b-partner-orgs.js
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json node scripts/backfill-b2b-partner-orgs.js --apply
 *
 * Default is dry-run (prints actions only).
 */

require("../admin");

const { collection, serverTimestamp } = require("../libs/firestore");
const { getCustomClaims } = require("../utils/customClaimsMerge");
const partnerService = require("../services/partnerService");
const b2bMemberService = require("../services/b2bMemberService");
const b2bOnboardingService = require("../services/b2bOnboardingService");

const INSTITUTION_PARTNER_DASHBOARD = "PartnerDashboard";
const CHANNEL_B2B = "B2B";
const ONBOARDING_COL = "onboarding";

/**
 * @param {string[]} argv
 * @returns {{ apply: boolean, help: boolean }}
 */
function parseArgs(argv) {
  return {
    apply: argv.includes("--apply"),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

function usage() {
  console.log(`
Backfill missing partner orgs for B2B dashboard signups

Options:
  --apply     Write repairs (default is dry-run)
  --help, -h  Show this help

Requires GOOGLE_APPLICATION_CREDENTIALS or gcloud application-default credentials.
`);
}

/**
 * @param {Object|null|undefined} onboarding
 * @param {Object|null|undefined} userData
 * @returns {string|null}
 */
function derivePartnerName(onboarding, userData) {
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
  if (owner && typeof owner === "object" && owner.businessName) {
    const name = String(owner.businessName).trim();
    if (name) {
      return name;
    }
  }
  if (userData?.name && String(userData.name).trim()) {
    return String(userData.name).trim();
  }
  if (userData?.email && String(userData.email).includes("@")) {
    const local = String(userData.email).split("@")[0].trim();
    if (local) {
      return local.replace(/[._+-]+/g, " ").trim() || null;
    }
  }
  return null;
}

/**
 * @param {string} uid
 * @param {string} partnerId
 * @returns {Promise<void>}
 */
async function linkOnboardingPartner(uid, partnerId) {
  await collection(ONBOARDING_COL).doc(uid).set(
      {
        registeredPartnerId: partnerId,
        updatedAt: serverTimestamp(),
      },
      {merge: true},
  );
}

/**
 * @returns {Promise<FirebaseFirestore.QueryDocumentSnapshot[]>}
 */
async function loadB2BDashboardUsers() {
  const snap = await collection("users").where("channel", "==", CHANNEL_B2B).get();
  return snap.docs.filter((doc) => {
    const institution = doc.data()?.institution;
    return institution === INSTITUTION_PARTNER_DASHBOARD;
  });
}

/**
 * @param {FirebaseFirestore.QueryDocumentSnapshot} userDoc
 * @param {boolean} apply
 * @returns {Promise<Object>}
 */
async function processUser(userDoc, apply) {
  const uid = userDoc.id;
  const userData = userDoc.data() || {};
  const email = userData.email ? String(userData.email).trim().toLowerCase() : "";

  let claims = {};
  try {
    claims = await getCustomClaims(uid);
  } catch (err) {
    if (err.code !== "auth/user-not-found") {
      throw err;
    }
    return {uid, email, status: "auth-user-missing"};
  }

  const claimPartnerId =
    typeof claims.partnerId === "string" && claims.partnerId.trim() ?
      claims.partnerId.trim() :
      null;

  const obSnap = await collection(ONBOARDING_COL).doc(uid).get();
  const onboarding = obSnap.exists ? obSnap.data() : null;
  const registeredPartnerId =
    onboarding?.registeredPartnerId ?
      String(onboarding.registeredPartnerId).trim() :
      null;

  if (claimPartnerId) {
    const partner = await partnerService.getPartner(claimPartnerId);
    if (partner) {
      return {uid, email, status: "ok", partnerId: claimPartnerId};
    }
    return {
      uid,
      email,
      status: "broken-claim",
      partnerId: claimPartnerId,
      message: "Custom claim partnerId points to missing partners doc",
    };
  }

  if (registeredPartnerId) {
    const partner = await partnerService.getPartner(registeredPartnerId);
    if (!partner) {
      return {
        uid,
        email,
        status: "missing-partner-doc",
        registeredPartnerId,
        message: "onboarding.registeredPartnerId has no partners row",
      };
    }
    if (partner.orgAdminUid && partner.orgAdminUid !== uid) {
      return {
        uid,
        email,
        status: "linked-to-other-org-admin",
        partnerId: registeredPartnerId,
        orgAdminUid: partner.orgAdminUid,
        message: "User is not org admin of registered partner",
      };
    }
    if (apply) {
      await b2bMemberService.setPartnerOrgAdmin(
          registeredPartnerId,
          uid,
          uid,
          {selfServe: true},
      );
    }
    return {
      uid,
      email,
      status: apply ? "repaired-claims" : "would-repair-claims",
      partnerId: registeredPartnerId,
    };
  }

  const byAdminSnap = await collection("partners")
      .where("orgAdminUid", "==", uid)
      .limit(1)
      .get();
  if (!byAdminSnap.empty) {
    const partnerId = byAdminSnap.docs[0].id;
    if (apply) {
      await linkOnboardingPartner(uid, partnerId);
      await b2bMemberService.setPartnerOrgAdmin(
          partnerId,
          uid,
          uid,
          {selfServe: true},
      );
    }
    return {
      uid,
      email,
      status: apply ? "linked-existing-partner" : "would-link-existing-partner",
      partnerId,
    };
  }

  const partnerName = derivePartnerName(onboarding, userData);
  if (!partnerName) {
    return {
      uid,
      email,
      status: "needs-manual-name",
      message: "No business name on onboarding and no usable profile fallback",
    };
  }

  if (apply) {
    const out = await b2bOnboardingService.registerSelfServePartner(uid, {
      name: partnerName,
      settlementCurrency: "KES",
    });
    return {
      uid,
      email,
      status: out.alreadyRegistered ? "already-registered" : "created-partner",
      partnerId: out.partnerId,
      partnerName,
    };
  }

  return {
    uid,
    email,
    status: "would-create-partner",
    partnerName,
  };
}

async function main() {
  const { apply, help } = parseArgs(process.argv.slice(2));
  if (help) {
    usage();
    process.exit(0);
  }

  console.log(apply ?
    "Running in APPLY mode (writes enabled)." :
    "Dry-run mode (pass --apply to write repairs).");

  const userDocs = await loadB2BDashboardUsers();
  console.log(`Found ${userDocs.length} B2B dashboard user(s).\n`);

  /** @type {Record<string, number>} */
  const counts = {};
  /** @type {Object[]} */
  const rows = [];

  for (const userDoc of userDocs) {
    const result = await processUser(userDoc, apply);
    rows.push(result);
    counts[result.status] = (counts[result.status] || 0) + 1;
    console.log(JSON.stringify(result));
  }

  console.log("\nSummary:");
  for (const [status, count] of Object.entries(counts).sort()) {
    console.log(`  ${status}: ${count}`);
  }

  const actionable = rows.filter((row) =>
    row.status.startsWith("would-") ||
    row.status === "needs-manual-name" ||
    row.status === "broken-claim" ||
    row.status === "missing-partner-doc" ||
    row.status === "linked-to-other-org-admin" ||
    row.status === "auth-user-missing",
  );

  if (!apply && actionable.length) {
    console.log(
        `\n${actionable.length} user(s) need attention. Re-run with --apply to auto-repair where possible.`,
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
