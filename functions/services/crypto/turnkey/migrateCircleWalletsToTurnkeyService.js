/**
 * @fileoverview Replace Circle cryptoWallets mappings with Turnkey deposit addresses.
 * Does not delete Firebase Auth users, ledger entries, or Circle-hosted wallets.
 */

const {collection, serverTimestamp} = require("../../../libs/firestore");
const hierarchicalAccountService = require("./turnkeyHierarchicalAccountService");

const CIRCLE_PROVIDER = "circle";
const PAGE_SIZE = 200;

class CircleWalletMigrationError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "CircleWalletMigrationError";
    this.code = code;
  }
}

/**
 * @param {Object} [opts]
 * @returns {{ apply: boolean, userId: string|null, limit: number }}
 */
function normalizeOptions(opts = {}) {
  const userId = opts.userId ? String(opts.userId).trim() : "";
  const limit = Number(opts.limit);
  return {
    apply: opts.apply === true,
    userId: userId || null,
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 500,
  };
}

/**
 * @param {Object} [opts]
 * @returns {Promise<FirebaseFirestore.QuerySnapshot>}
 */
async function loadCircleWallets(opts) {
  let query = collection("cryptoWallets").where("provider", "==", CIRCLE_PROVIDER);
  if (opts.userId) {
    query = query.where("userId", "==", opts.userId);
  }
  return query.limit(opts.limit).get();
}

/**
 * @param {Object} wallet
 * @returns {Promise<Object>}
 */
async function planOne(wallet) {
  const existingTurnkey = wallet.userId ?
    await hierarchicalAccountService.findLiveCustomerWallet(wallet.userId) :
    null;
  return {
    userId: wallet.userId || null,
    circleWalletDocId: wallet.id,
    circleAddress: wallet.address || null,
    circleWalletId: wallet.walletId || null,
    existingTurnkeyAddress: existingTurnkey ? existingTurnkey.address : null,
    action: existingTurnkey ? "retire-circle-keep-turnkey" : "retire-circle-create-turnkey",
  };
}

/**
 * @param {Object} plan
 * @returns {Promise<Object>}
 */
async function applyOne(plan) {
  let turnkeyAddress = plan.existingTurnkeyAddress;
  let created = false;
  if (!turnkeyAddress) {
    if (!plan.userId) {
      throw new CircleWalletMigrationError("INVALID_USER", "Circle wallet is missing userId");
    }
    const allocated = await hierarchicalAccountService.allocateCustomerDepositAddress(plan.userId);
    turnkeyAddress = allocated.wallet.address;
    created = !!allocated.created;
  }

  await collection("cryptoWallets").doc(plan.circleWalletDocId).delete();
  await collection("cryptoWalletMigrations").add({
    userId: plan.userId,
    fromProvider: CIRCLE_PROVIDER,
    toProvider: "turnkey",
    oldAddress: plan.circleAddress,
    oldWalletId: plan.circleWalletId,
    oldWalletDocId: plan.circleWalletDocId,
    newAddress: turnkeyAddress,
    createdTurnkeyAddress: created,
    createdAt: serverTimestamp(),
  });

  return {
    ...plan,
    newAddress: turnkeyAddress,
    createdTurnkeyAddress: created,
    deletedCircleWallet: true,
  };
}

/**
 * @param {Object} [opts]
 * @returns {Promise<Object>}
 */
async function migrateCircleWalletsToTurnkey(opts = {}) {
  const options = normalizeOptions(opts);
  const snap = await loadCircleWallets(options);
  const results = [];
  const errors = [];

  for (const doc of snap.docs) {
    const wallet = {id: doc.id, ...doc.data()};
    try {
      const plan = await planOne(wallet);
      if (!options.apply) {
        results.push({...plan, applied: false});
        continue;
      }
      results.push({...await applyOne(plan), applied: true});
    } catch (err) {
      errors.push({
        userId: wallet.userId || null,
        circleWalletDocId: doc.id,
        error: err.message || "Migration failed",
      });
    }
  }

  return {
    success: errors.length === 0,
    apply: options.apply,
    scanned: snap.size,
    migrated: results.filter((row) => row.applied).length,
    planned: results.length,
    errors,
    results,
    notes: [
      "Firebase Auth users are not deleted.",
      "Ledger balances are not changed.",
      "Circle-hosted wallets are not deleted at Circle.",
      "Only TruePay cryptoWallets rows with provider=circle are removed.",
    ],
  };
}

module.exports = {
  CIRCLE_PROVIDER,
  PAGE_SIZE,
  CircleWalletMigrationError,
  normalizeOptions,
  migrateCircleWalletsToTurnkey,
};
