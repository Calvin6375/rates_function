#!/usr/bin/env node
/**
 * Replace Circle deposit-address mappings with Turnkey hierarchical addresses.
 *
 * Does NOT delete Firebase users or ledger balances.
 * Deletes only cryptoWallets documents where provider=circle, after a Turnkey
 * address exists for that user.
 *
 * Usage (from functions/):
 *   node scripts/migrate-circle-wallets-to-turnkey.js
 *   node scripts/migrate-circle-wallets-to-turnkey.js --apply
 *   node scripts/migrate-circle-wallets-to-turnkey.js --uid <userId> --apply
 *   node scripts/migrate-circle-wallets-to-turnkey.js --limit 50 --apply
 *
 * Requires ADC or GOOGLE_APPLICATION_CREDENTIALS, plus Turnkey env/secrets
 * when --apply will create new addresses.
 */

require("../admin");
const {
  migrateCircleWalletsToTurnkey,
} = require("../services/crypto/turnkey/migrateCircleWalletsToTurnkeyService");

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const uidIndex = argv.indexOf("--uid");
  const limitIndex = argv.indexOf("--limit");
  return {
    apply: argv.includes("--apply"),
    help: argv.includes("--help") || argv.includes("-h"),
    userId: uidIndex !== -1 ? String(argv[uidIndex + 1] || "").trim() || null : null,
    limit: limitIndex !== -1 ? Number(argv[limitIndex + 1]) : undefined,
  };
}

function usage() {
  console.log(`
Replace Circle cryptoWallets mappings with Turnkey deposit addresses.

This does NOT delete Firebase Auth users or ledger balances.

Options:
  --apply         Write changes (default is dry-run)
  --uid <userId>  Migrate one user
  --limit <n>     Max Circle wallet docs to scan (default 500)
  --help, -h      Show this help
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }
  const result = await migrateCircleWalletsToTurnkey({
    apply: args.apply,
    userId: args.userId,
    limit: args.limit,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.success ? 0 : 1);
}

main().catch((err) => {
  console.error(err.message || "Circle wallet migration failed");
  process.exit(1);
});
