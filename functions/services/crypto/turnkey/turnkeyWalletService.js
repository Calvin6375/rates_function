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

  const {wallet} = await hierarchicalAccountService.allocateCustomerDepositAddress(userId);
  return wallet;
}

module.exports = {
  PROVIDER,
  ASSET,
  walletNameForUser,
  createWallet,
  getWallet,
  getWalletByProviderId,
  getWalletByAddress,
  readTurnkeyAccountId,
};
