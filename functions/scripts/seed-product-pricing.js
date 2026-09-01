#!/usr/bin/env node
/**
 * Seed config/productPricing with all products disabled (live defaults).
 * Idempotent: skips if the document already exists unless --force.
 *
 * Usage (from functions/):
 *   GOOGLE_APPLICATION_CREDENTIALS=... node scripts/seed-product-pricing.js
 *   GOOGLE_APPLICATION_CREDENTIALS=... node scripts/seed-product-pricing.js --apply
 *   GOOGLE_APPLICATION_CREDENTIALS=... node scripts/seed-product-pricing.js --apply --force
 */

require("../admin");

const {collection, serverTimestamp} = require("../libs/firestore");
const config = require("../config");
const {
  CONFIG_DOC,
  buildLiveDefaults,
} = require("../services/pricing/productPricingService");

/**
 * @param {string[]} argv
 * @returns {{ apply: boolean, force: boolean, help: boolean }}
 */
function parseArgs(argv) {
  return {
    apply: argv.includes("--apply"),
    force: argv.includes("--force"),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

function usage() {
  console.log(`
Seed config/${CONFIG_DOC} (all products disabled / zero fees)

Options:
  --apply     Write the document (default: dry-run)
  --force     Overwrite if document already exists
  --help, -h  Show help
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const ref = collection(config.collections.config).doc(CONFIG_DOC);
  const snap = await ref.get();
  const products = buildLiveDefaults();

  console.log(`Document: config/${CONFIG_DOC}`);
  console.log(`Exists: ${snap.exists}`);
  console.log(`Products: ${Object.keys(products).join(", ")}`);
  console.log("All enabled=false, feePercent=0, flatFeeKes=0");

  if (!args.apply) {
    console.log("\nDry-run only. Re-run with --apply to write.");
    return;
  }

  if (snap.exists && !args.force) {
    console.log("\nDocument already exists; skipping (use --force to overwrite).");
    return;
  }

  await ref.set({
    schemaVersion: 1,
    products,
    updatedAt: serverTimestamp(),
    updatedBy: "seed-product-pricing",
  }, {merge: !args.force});

  console.log("\nSeeded successfully.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
