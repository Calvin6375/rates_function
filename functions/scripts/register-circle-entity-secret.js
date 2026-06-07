#!/usr/bin/env node
/**
 * Register a Circle entity secret (encrypts + registers with Circle API).
 *
 * You generated the RAW hex secret in Node — keep that safe. This script
 * encrypts it and registers with Circle so wallet creation works. You do NOT
 * paste the raw hex into the Circle dashboard.
 *
 * Usage (from functions/):
 *   CIRCLE_API_KEY="TEST_API_KEY:..." \
 *   CIRCLE_ENTITY_SECRET="dc4a1f2848004d3148b4e526e558649a931a306e063d1c8c3b5230538ac5cfe7" \
 *   node scripts/register-circle-entity-secret.js
 *
 * Manual dashboard paste only (prints ciphertext, does not call Circle):
 *   ... node scripts/register-circle-entity-secret.js --ciphertext-only
 */

const fs = require("fs");
const path = require("path");
const {
  registerEntitySecretCiphertext,
  generateEntitySecretCiphertext,
} = require("@circle-fin/developer-controlled-wallets");

const RECOVERY_DIR = path.join(__dirname, "..", "recovery");

function parseArgs(argv) {
  const ciphertextOnly = argv.includes("--ciphertext-only");
  const help = argv.includes("--help") || argv.includes("-h");
  return { ciphertextOnly, help };
}

function usage() {
  console.log(`
Circle entity secret registration

Environment variables:
  CIRCLE_API_KEY          Circle test/live API key from console.circle.com
  CIRCLE_ENTITY_SECRET    64-char hex raw entity secret (NOT ciphertext)

Options:
  --ciphertext-only       Print encrypted ciphertext for manual dashboard paste
  --help                  Show this message

After registration, upload the RAW secret to Firebase (not the ciphertext):
  printf '%s' "$CIRCLE_ENTITY_SECRET" | firebase functions:secrets:set CIRCLE_ENTITY_SECRET --data-file=-

Then redeploy:
  firebase deploy --only functions:cryptoApi,functions:onUserCreated,functions:handleCircleWebhook,functions:reconcileCircleLedger
`);
}

function validateEntitySecret(entitySecret) {
  const trimmed = String(entitySecret || "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error(
        "CIRCLE_ENTITY_SECRET must be a 64-character hex string (32 bytes).",
    );
  }
  return trimmed;
}

async function main() {
  const { ciphertextOnly, help } = parseArgs(process.argv.slice(2));
  if (help) {
    usage();
    return;
  }

  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = validateEntitySecret(process.env.CIRCLE_ENTITY_SECRET);

  if (!apiKey) {
    throw new Error("Set CIRCLE_API_KEY to your Circle API key.");
  }

  if (ciphertextOnly) {
    const ciphertext = generateEntitySecretCiphertext({ apiKey, entitySecret });
    console.log("\nPaste ONLY this into Circle Console → Entity Secret Ciphertext:\n");
    console.log(ciphertext);
    console.log("\nDo NOT paste the raw hex. Store raw hex in Firebase CIRCLE_ENTITY_SECRET.\n");
    return;
  }

  if (!fs.existsSync(RECOVERY_DIR)) {
    fs.mkdirSync(RECOVERY_DIR, { recursive: true });
  }

  console.log("Registering entity secret with Circle (encrypt + API register)...");
  const response = await registerEntitySecretCiphertext({
    apiKey,
    entitySecret,
    recoveryFileDownloadPath: RECOVERY_DIR,
  });

  console.log("\n✅ Entity secret registered with Circle.");
  if (response.data?.recoveryFile) {
    console.log("   Recovery file metadata received (saved under functions/recovery/).");
  }
  console.log("\nNext steps:");
  console.log("  1. Back up functions/recovery/ somewhere secure (NOT in git).");
  console.log("  2. Upload RAW secret to Firebase:");
  console.log('     printf \'%s\' "$CIRCLE_ENTITY_SECRET" | firebase functions:secrets:set CIRCLE_ENTITY_SECRET --data-file=-');
  console.log("  3. Redeploy crypto functions (see --help).");
  console.log("\n⚠️  Never commit CIRCLE_ENTITY_SECRET or recovery files.\n");
}

main().catch((err) => {
  console.error("\n❌ Registration failed:", err.message);
  if (String(err.message).includes("already been set")) {
    console.error("   Entity secret is already registered. Use Circle Console recovery flow to rotate, or keep the existing secret in Firebase.");
  }
  process.exit(1);
});
