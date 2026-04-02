/**
 * Script to set admin claim for a user
 *
 * Usage:
 *   Option A (service account key):
 *     node set-admin-claim.js <userId> --key ./serviceAccountKey.json
 *
 *   Option B (Application Default Credentials, after 'gcloud auth application-default login'):
 *     node set-admin-claim.js <userId>
 *
 * Example:
 *   node set-admin-claim.js r1ppbrcVv4bb8Y0HZqBQzrAbNBj1 --key ./serviceAccountKey.json
 */

const admin = require("firebase-admin");

// Parse args
const args = process.argv.slice(2);
const userId = args[0];
const keyFlagIndex = args.indexOf("--key");
const keyPath = keyFlagIndex !== -1 ? args[keyFlagIndex + 1] : null;

if (!userId) {
  console.error("❌ Error: User ID is required");
  console.log("\nUsage:");
  console.log("  node set-admin-claim.js <userId> [--key <serviceAccountKey.json>]");
  console.log("\nExample:");
  console.log("  node set-admin-claim.js r1ppbrcVv4bb8Y0HZqBQzrAbNBj1 --key ./serviceAccountKey.json");
  process.exit(1);
}

// Initialize Firebase Admin
try {
  if (keyPath) {
    // Option A: explicit service account key
    const serviceAccount = require(keyPath.startsWith("/") ? keyPath : require("path").resolve(keyPath));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: serviceAccount.project_id || "truepay-72060",
    });
    console.log(`🔑 Using service account key: ${keyPath}`);
  } else {
    // Option B: Application Default Credentials
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: process.env.GOOGLE_CLOUD_PROJECT || "truepay-72060",
    });
    console.log("🔑 Using Application Default Credentials (ADC)");
  }
} catch (initError) {
  console.error("❌ Firebase Admin init failed:", initError.message);
  printHelp();
  process.exit(1);
}

function printHelp() {
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 HOW TO FIX
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

OPTION A — Service Account Key (easiest):
  1. Go to Firebase Console → Project Settings → Service Accounts
  2. Click "Generate new private key" → save as serviceAccountKey.json
  3. Run:
       node set-admin-claim.js ${userId || "<userId>"} --key ./serviceAccountKey.json

OPTION B — Google Cloud ADC:
  1. Install gcloud CLI: https://cloud.google.com/sdk/docs/install
  2. Run:  gcloud auth application-default login
  3. Run:  node set-admin-claim.js ${userId || "<userId>"}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
}

async function setAdminClaim(uid) {
  try {
    // Verify the user exists first
    const userRecord = await admin.auth().getUser(uid);
    console.log(`\n✅ Found user: ${userRecord.email || uid}`);
    console.log(`   Current claims: ${JSON.stringify(userRecord.customClaims || {})}`);

    // Set admin: true claim
    await admin.auth().setCustomUserClaims(uid, {admin: true});

    // Verify claim was set
    const updated = await admin.auth().getUser(uid);
    console.log(`\n🎉 Admin claim set successfully!`);
    console.log(`   New claims: ${JSON.stringify(updated.customClaims)}`);
    console.log(`\n⚠️  IMPORTANT: The user must sign out and sign back in for the`);
    console.log(`   new token (with admin claim) to be issued.\n`);
  } catch (error) {
    console.error(`\n❌ Error setting admin claim:`, error.message);
    if (error.message.includes("Project Id") || error.message.includes("credential")) {
      printHelp();
    }
    process.exit(1);
  }
}

setAdminClaim(userId)
  .then(() => {
    console.log("Done!");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Failed:", err.message);
    process.exit(1);
  });
