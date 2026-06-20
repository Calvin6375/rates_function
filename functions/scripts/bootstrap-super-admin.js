#!/usr/bin/env node
/**
 * Bootstrap the built-in platform super-admin (email only — no password in code).
 *
 * Creates Firebase Auth user if missing, assigns claims:
 *   { userType: "admin", role: "super_admin" }
 * Writes platformAdmins/{uid} and users/{uid}.
 *
 * After running, set the password in Firebase Console → Authentication
 * (or send a password-reset email) and rotate on first login.
 *
 * Usage (from functions/):
 *   GOOGLE_APPLICATION_CREDENTIALS=... node scripts/bootstrap-super-admin.js
 *   GOOGLE_APPLICATION_CREDENTIALS=... node scripts/bootstrap-super-admin.js --apply
 *
 * Default is dry-run.
 */

require("../admin");

const admin = require("../admin");
const {
  SUPER_ADMIN_EMAIL,
  ADMIN_ROLE_SUPER,
  setAdminAccessClaims,
  syncUserDocAccessFields,
  PLATFORM_ADMINS_COL,
} = require("../utils/accessControl");
const { collection, serverTimestamp } = require("../libs/firestore");

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
Bootstrap platform super-admin (${SUPER_ADMIN_EMAIL})

Options:
  --apply     Create user and assign claims (default: dry-run)
  --help, -h  Show help

Never stores a password. After --apply, set password in Firebase Console.
`);
}

async function main() {
  const { apply, help } = parseArgs(process.argv.slice(2));
  if (help) {
    usage();
    process.exit(0);
  }

  console.log(apply ? "APPLY mode" : "Dry-run mode (pass --apply to write)");
  console.log(`Super-admin email: ${SUPER_ADMIN_EMAIL}\n`);

  let userRecord;
  try {
    userRecord = await admin.auth().getUserByEmail(SUPER_ADMIN_EMAIL);
    console.log(`Auth user exists: uid=${userRecord.uid}`);
  } catch (e) {
    if (e.code !== "auth/user-not-found") {
      throw e;
    }
    if (!apply) {
      console.log("Auth user does not exist — would create without password.");
      console.log("\nNext steps after --apply:");
      console.log("  1. Firebase Console → Authentication → set password for this email");
      console.log("  2. Sign in and rotate password on first use");
      process.exit(0);
    }
    userRecord = await admin.auth().createUser({
      email: SUPER_ADMIN_EMAIL,
      emailVerified: true,
      disabled: false,
    });
    console.log(`Created Auth user: uid=${userRecord.uid}`);
  }

  const uid = userRecord.uid;

  if (!apply) {
    console.log("Would assign claims: { userType: admin, role: super_admin }");
    console.log(`Would write ${PLATFORM_ADMINS_COL}/${uid} and users/${uid}`);
    process.exit(0);
  }

  await setAdminAccessClaims(uid, ADMIN_ROLE_SUPER, uid);

  await collection("users").doc(uid).set(
      {
        uid,
        email: SUPER_ADMIN_EMAIL,
        name: userRecord.displayName || "Platform Super Admin",
        userType: "admin",
        role: ADMIN_ROLE_SUPER,
        status: "Active",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
      {merge: true},
  );

  await syncUserDocAccessFields(uid, {
    userType: "admin",
    role: ADMIN_ROLE_SUPER,
    status: "Active",
  });

  console.log("\nBootstrap complete.");
  console.log("Set password in Firebase Console if this account has never logged in.");
  console.log("User must sign out/in to refresh ID token claims.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
