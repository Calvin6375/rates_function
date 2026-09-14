/**
 * @fileoverview Turnkey-backed customer wallet provisioning (one EVM address per user).
 * The company treasury address is never assigned to a customer.
 */

const {collection, serverTimestamp} = require("../../../libs/firestore");
const turnkeyClient = require("./turnkeyClient");
const {getFujiNetwork, isTreasuryAddress, normalizeAddress} = require("../evm/fujiNetwork");
const {walletProvisioningFailure} = require("../cryptoErrors");

const PROVIDER = "turnkey";
const ASSET = "USDC";
const STATUS_LIVE = "live";

/**
 * @param {string} userId
 * @returns {string}
 */
function walletNameForUser(userId) {
  return `truepay-user-${userId}`;
}

/**
 * @param {string} userId
 * @returns {Promise<Object|null>}
 */
async function getWallet(userId) {
  const snap = await collection("cryptoWallets")
      .where("userId", "==", userId)
      .where("provider", "==", PROVIDER)
      .limit(1)
      .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return {id: doc.id, ...doc.data()};
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
 * @param {string} name
 * @returns {Promise<{ walletId: string, address: string }|null>}
 */
async function findExistingTurnkeyWallet(client, name) {
  const response = await client.getWallets({});
  const wallets = response.wallets || [];
  const match = wallets.find((row) => row.walletName === name);
  if (!match) return null;

  const accounts = await client.getWalletAccounts({walletId: match.walletId});
  const address = accounts.accounts?.[0]?.address;
  if (!address) return null;
  return {walletId: match.walletId, address};
}

/**
 * @param {string} userId
 * @returns {Promise<{ walletId: string, address: string }>}
 */
async function provisionTurnkeyWallet(userId) {
  const {DEFAULT_ETHEREUM_ACCOUNTS} = require("@turnkey/sdk-server");
  const client = turnkeyClient.getApiClient();
  const name = walletNameForUser(userId);

  try {
    const created = await client.createWallet({
      walletName: name,
      accounts: DEFAULT_ETHEREUM_ACCOUNTS,
    });
    const walletId = created.walletId;
    const address = created.addresses?.[0];
    if (!walletId || !address) {
      throw walletProvisioningFailure("Turnkey createWallet returned no address");
    }
    return {walletId, address};
  } catch (err) {
    if (err && err.code === "WALLET_PROVISIONING_FAILURE") throw err;
    const recovered = await findExistingTurnkeyWallet(client, name).catch(() => null);
    if (recovered) return recovered;
    throw walletProvisioningFailure(err.message || "createWallet failed");
  }
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

  if (!turnkeyClient.isTurnkeyConfigured()) {
    throw walletProvisioningFailure("Turnkey is not configured");
  }

  const {walletId, address} = await provisionTurnkeyWallet(userId);
  if (isTreasuryAddress(address)) {
    throw walletProvisioningFailure("Refusing to assign the treasury address to a customer");
  }

  const assigned = await getWalletByAddress(address);
  if (assigned && assigned.userId !== userId) {
    throw walletProvisioningFailure("Address already assigned to another customer");
  }

  const network = getFujiNetwork();
  const walletDoc = {
    userId,
    provider: PROVIDER,
    walletId,
    turnkeyWalletId: walletId,
    address,
    addressLower: normalizeAddress(address),
    chain: network.chainLabel,
    blockchain: network.blockchain,
    network: network.network,
    chainId: network.chainId,
    asset: ASSET,
    status: STATUS_LIVE,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  const docRef = await collection("cryptoWallets").add(walletDoc);
  return {
    id: docRef.id,
    ...walletDoc,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

module.exports = {
  PROVIDER,
  ASSET,
  walletNameForUser,
  createWallet,
  getWallet,
  getWalletByProviderId,
  getWalletByAddress,
};
