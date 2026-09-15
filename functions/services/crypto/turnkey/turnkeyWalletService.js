/**
 * @fileoverview Turnkey-backed customer wallet provisioning (one EVM address per user).
 * The company treasury address is never assigned to a customer.
 */

const {collection} = require("../../../libs/firestore");
const {normalizeAddress} = require("../evm/fujiNetwork");
const {walletProvisioningFailure} = require("../cryptoErrors");
const hierarchicalAccountService = require("./turnkeyHierarchicalAccountService");

const PROVIDER = "turnkey";
const ASSET = "USDC";
const DEFAULT_NETWORK = "avalanche-fuji";
const PRODUCTION_NETWORK = "avalanche";

/**
 * @param {string} userId
 * @returns {string}
 */
function walletNameForUser(userId) {
  return `truepay-user-${userId}`;
}

/**
 * @param {string} userId
 * @param {{ network?: string, asset?: string }} [opts]
 * @returns {Promise<Object|null>}
 */
async function getWallet(userId, opts = {}) {
  const network = String(opts.network || DEFAULT_NETWORK).toLowerCase();
  const asset = String(opts.asset || ASSET).toUpperCase();
  const snap = await collection("cryptoWallets")
      .where("userId", "==", userId)
      .where("provider", "==", PROVIDER)
      .get();
  if (snap.empty) return null;
  const match = snap.docs
      .map((doc) => ({id: doc.id, ...doc.data()}))
      .find((row) => {
        const rowNetwork = String(row.network || DEFAULT_NETWORK).toLowerCase();
        return rowNetwork === network &&
          String(row.asset || ASSET).toUpperCase() === asset;
      });
  return match || null;
}

/**
 * @param {Object|null} wallet
 * @returns {boolean}
 */
function isLiveDepositWallet(wallet) {
  if (!wallet || !wallet.address) return false;
  const status = String(wallet.status || "live").toLowerCase();
  return status === "live" || status === "active";
}

/**
 * @param {Object|null} wallet
 * @returns {{ network: string, address: string, status: string }|null}
 */
function summarizeWallet(wallet) {
  if (!isLiveDepositWallet(wallet)) return null;
  return {
    network: wallet.network || DEFAULT_NETWORK,
    address: wallet.address,
    status: wallet.status || "live",
  };
}

/**
 * Read-only Fuji vs mainnet status. Never creates a wallet.
 * @param {string} userId
 * @returns {Promise<Object>}
 */
async function getCustomerWalletNetworkStatus(userId) {
  const uid = String(userId || "").trim();
  if (!uid) {
    throw walletProvisioningFailure("userId is required");
  }
  const [testnetWallet, mainnetWallet] = await Promise.all([
    getWallet(uid, {network: DEFAULT_NETWORK, asset: ASSET}),
    getWallet(uid, {network: PRODUCTION_NETWORK, asset: ASSET}),
  ]);
  const testnet = summarizeWallet(testnetWallet);
  const mainnet = summarizeWallet(mainnetWallet);
  const onTestnet = !!testnet;
  const hasMainnet = !!mainnet;
  return {
    success: true,
    userId: uid,
    onTestnet,
    hasMainnet,
    shouldCreateMainnet: onTestnet && !hasMainnet,
    testnet,
    mainnet,
  };
}

/**
 * Hard-delete this user's Fuji/dev cryptoWallets mappings and Fuji deposit intent.
 * Never deletes a production Avalanche wallet, the Fuji parent wallet, or the Fuji counter.
 * @param {string} userId
 * @returns {Promise<{ deleted: number, ids: string[] }>}
 */
async function deleteFujiCustomerWallets(userId) {
  const uid = String(userId || "").trim();
  if (!uid) return {deleted: 0, ids: []};

  const snap = await collection("cryptoWallets")
      .where("userId", "==", uid)
      .where("provider", "==", PROVIDER)
      .get();
  const ids = new Set();
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    if (String(data.userId || "") !== uid) continue;
    const network = String(data.network || DEFAULT_NETWORK).toLowerCase();
    if (network === PRODUCTION_NETWORK) continue;
    if (network !== DEFAULT_NETWORK) continue;
    ids.add(doc.id);
  }
  ids.add(`turnkey_${uid}_${DEFAULT_NETWORK}_${ASSET}`);
  ids.delete(`turnkey_${uid}_${PRODUCTION_NETWORK}_${ASSET}`);

  const deleted = [];
  for (const id of ids) {
    if (String(id).includes(`_${PRODUCTION_NETWORK}_`)) continue;
    await collection("cryptoWallets").doc(id).delete();
    deleted.push(id);
  }

  await collection("cryptoDepositIntents")
      .doc(`${uid}_${DEFAULT_NETWORK}_${ASSET}`)
      .delete()
      .catch(() => undefined);

  return {deleted: deleted.length, ids: deleted};
}

/**
 * @param {string} walletId
 * @returns {Promise<Object|null>}
 */
async function getWalletByProviderId(walletId) {
  const snap = await collection("cryptoWallets")
      .where("walletId", "==", walletId)
      .where("provider", "==", PROVIDER)
      .limit(1)
      .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return {id: doc.id, ref: doc.ref, ...doc.data()};
}

/**
 * @param {string} address
 * @returns {Promise<Object|null>}
 */
async function getWalletByAddress(address) {
  const normalized = normalizeAddress(address);
  if (!normalized) return null;

  const snap = await collection("cryptoWallets")
      .where("addressLower", "==", normalized)
      .limit(1)
      .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return {id: doc.id, ref: doc.ref, ...doc.data()};
}

/**
 * @param {Object} client
 * @param {string} walletId
 * @param {string} [address]
 * @returns {Promise<string|null>}
 */
async function readTurnkeyAccountId(client, walletId, address) {
  if (!walletId || typeof client.getWalletAccounts !== "function") return null;
  const accounts = await client.getWalletAccounts({walletId});
  const rows = accounts.accounts || [];
  const expected = normalizeAddress(address);
  const match = expected ?
    rows.find((row) => normalizeAddress(row.address) === expected) :
    rows[0];
  return (match && match.walletAccountId) || rows[0]?.walletAccountId || null;
}

/**
 * @param {string} userId
 * @returns {Promise<Object>}
 */
async function createWallet(userId) {
  if (!userId) {
    throw walletProvisioningFailure("userId is required");
  }

  const existing = await getWallet(userId);
  if (existing) {
    return existing;
  }

  const production = await getWallet(userId, {network: PRODUCTION_NETWORK});
  if (isLiveDepositWallet(production)) {
    throw walletProvisioningFailure(
        "Fuji deposit addresses are not created after a production address exists",
    );
  }

  const {wallet} = await hierarchicalAccountService.allocateCustomerDepositAddress(userId);
  return wallet;
}

module.exports = {
  PROVIDER,
  ASSET,
  walletNameForUser,
  createWallet,
  getWallet,
  getCustomerWalletNetworkStatus,
  deleteFujiCustomerWallets,
  getWalletByProviderId,
  getWalletByAddress,
  readTurnkeyAccountId,
};
