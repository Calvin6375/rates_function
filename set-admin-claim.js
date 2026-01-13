/**
 * Script to set admin claim for a user
 * Usage: node set-admin-claim.js <userId>
 * 
 * Example: node set-admin-claim.js T1wAFhSWtvXDGrRQz2yD7efxSZ52
 */

// Use the admin instance from functions directory
const admin = require("./functions/admin");

async function setAdminClaim(userId) {
  try {
    // Verify user exists
    const userRecord = await admin.auth().getUser(userId);
    console.log(`Found user: ${userRecord.email || userRecord.uid}`);

    // Set admin claim
    await admin.auth().setCustomUserClaims(userId, {admin: true});
    console.log(`✅ Admin claim set successfully for user: ${userId}`);
    console.log(`\n⚠️  IMPORTANT: User must sign out and sign back in for the changes to take effect.`);
    console.log(`   The new token will include the admin claim.\n`);
  } catch (error) {
    console.error(`❌ Error setting admin claim:`, error.message);
    process.exit(1);
  }
}

// Get userId from command line arguments
const userId = process.argv[2];

if (!userId) {
  console.error("❌ Error: User ID is required");
  console.log("Usage: node set-admin-claim.js <userId>");
  console.log("Example: node set-admin-claim.js T1wAFhSWtvXDGrRQz2yD7efxSZ52");
  process.exit(1);
}

setAdminClaim(userId)
    .then(() => {
      console.log("Done!");
      process.exit(0);
    })
    .catch((error) => {
      console.error("Failed:", error);
      process.exit(1);
    });

