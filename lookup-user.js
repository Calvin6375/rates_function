/**
 * Look up Firebase Auth user by email and set admin claim
 * Usage: node lookup-user.js <email> --key ./serviceAccountKey.json [--set-admin]
 * Example: node lookup-user.js calvinrumba8@gmail.com --key ./serviceAccountKey.json --set-admin
 */

const admin = require("firebase-admin");
const path = require("path");

const args = process.argv.slice(2);
const email = args[0];
const keyFlagIndex = args.indexOf("--key");
const keyPath = keyFlagIndex !== -1 ? args[keyFlagIndex + 1] : null;
const setAdmin = args.includes("--set-admin");

if (!email) {
  console.error("Usage: node lookup-user.js <email> --key ./serviceAccountKey.json [--set-admin]");
  process.exit(1);
}

if (!keyPath) {
  console.error("❌ --key <path> is required");
  process.exit(1);
}

const serviceAccount = require(path.resolve(keyPath));
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: serviceAccount.project_id,
});

async function run() {
  try {
    const userRecord = await admin.auth().getUserByEmail(email);
    console.log(`\n✅ Found user: ${userRecord.email}`);
    console.log(`   UID:           ${userRecord.uid}`);
    console.log(`   Current claims: ${JSON.stringify(userRecord.customClaims || {})}`);

    if (setAdmin) {
      await admin.auth().setCustomUserClaims(userRecord.uid, { admin: true });
      const updated = await admin.auth().getUser(userRecord.uid);
      console.log(`\n🎉 Admin claim set!`);
      console.log(`   New claims: ${JSON.stringify(updated.customClaims)}`);
      console.log(`\n⚠️  User must sign out and sign back in for the new token to include the claim.\n`);
    } else {
      console.log(`\n💡 Re-run with --set-admin to grant admin privileges.\n`);
      console.log(`   node lookup-user.js ${email} --key ${keyPath} --set-admin\n`);
    }
  } catch (err) {
    if (err.code === "auth/user-not-found") {
      console.error(`❌ No user found with email: ${email}`);
    } else {
      console.error("❌ Error:", err.message);
    }
    process.exit(1);
  }
}

run().then(() => process.exit(0));
