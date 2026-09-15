/**
 * @fileoverview Idempotent per-customer Fuji USDC deposit addresses.
 * Reuses Turnkey wallet provisioning and cryptoWallets mapping.
 */

const admin = require("../../../admin");
const {collection} = require("../../../libs/firestore");
const turnkeyWalletService = require("./turnkeyWalletService");
const hierarchicalAccountService = require("./turnkeyHierarchicalAccountService");
const {getFujiNetwork, isTreasuryAddress, isValidEvmAddress, normalizeAddress} = require("../evm/fujiNetwork");
const {unsupportedNetwork} = require("../cryptoErrors");

const SUPPORTED_NETWORK = "avalanche-fuji";
const PRODUCTION_NETWORK = "avalanche";
const ASSET = "USDC";

class DepositAddressError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "DepositAddressError";
    this.code = code;
  }
}

/**
 * @param {unknown} network
 * @returns {string}
 */
function assertSupportedNetwork(network) {
  const value = String(network || "").trim().toLowerCase();
  if (value !== SUPPORTED_NETWORK) {
    const err = unsupportedNetwork(value || "unknown");
    throw new DepositAddressError(err.code, err.message);
  }
  return SUPPORTED_NETWORK;
}

/**
 * @param {unknown} userId
 * @returns {string}
 */
function assertUserId(userId) {
  const value = String(userId || "").trim();
  if (!value) {
    throw new DepositAddressError("INVALID_USER", "userId is required");
  }
  return value;
}

/**
 * @param {string} userId
 * @returns {Promise<void>}
 */
async function assertUserExists(userId) {
  const userDoc = await collection("users").doc(userId).get();
  if (userDoc.exists) return;
  try {
    await admin.auth().getUser(userId);
  } catch (_err) {
    throw new DepositAddressError("INVALID_USER", "User not found");
  }
}

/**
 * @param {Object} wallet
 * @returns {{ depositAddress: string, turnkeyWalletId: string|null, turnkeyAccountId: string|null, status: string, network: string, asset: string }}
 */
function sanitizeWallet(wallet) {
  const network = getFujiNetwork();
  return {
    depositAddress: wallet.address,
    turnkeyWalletId: wallet.turnkeyWalletId || wallet.walletId || null,
    turnkeyAccountId: wallet.turnkeyAccountId || wallet.walletAccountId || null,
    status: wallet.status || "live",
    network: wallet.network || network.network,
    asset: wallet.asset || ASSET,
  };
}

/**
 * @param {Object} wallet
 * @returns {Promise<string|null>}
 */
async function ensureTurnkeyAccountId(wallet) {
  if (wallet.turnkeyAccountId) return wallet.turnkeyAccountId;
  const walletId = wallet.turnkeyWalletId || wallet.walletId;
  if (!walletId) return null;
  const turnkeyClient = require("./turnkeyClient");
  if (!turnkeyClient.isTurnkeyConfigured()) return null;
  const client = turnkeyClient.getApiClient();
  const accountId = await turnkeyWalletService.readTurnkeyAccountId(
      client,
      walletId,
      wallet.address,
  );
  if (accountId && wallet.id) {
    await collection("cryptoWallets").doc(wallet.id).set({
      turnkeyAccountId: accountId,
    }, {merge: true});
  }
  return accountId;
}

/**
 * @param {{ userId: unknown, asset?: unknown, network?: unknown }} params
 * @returns {Promise<Object>}
 */
async function getOrCreateCustomerDepositAddress(params = {}) {
  const asset = String(params.asset || ASSET).toUpperCase();
  if (asset !== ASSET) {
    throw new DepositAddressError("WRONG_ASSET", "Only USDC deposit addresses are supported");
  }
  return getOrCreateUserDepositAddress(params.userId, params.network || SUPPORTED_NETWORK);
}

/**
 * @param {unknown} userId
 * @param {unknown} network
 * @returns {Promise<Object>}
 */
async function getOrCreateUserDepositAddress(userId, network) {
  const uid = assertUserId(userId);
  const resolvedNetwork = assertSupportedNetwork(network);
  await assertUserExists(uid);

  const existing = await hierarchicalAccountService.findLiveCustomerWallet(uid) ||
    await turnkeyWalletService.getWallet(uid, {network: SUPPORTED_NETWORK});
  if (existing && existing.address) {
    if (isTreasuryAddress(existing.address)) {
      throw new DepositAddressError(
          "TREASURY_ADDRESS",
          "Refusing to assign the treasury address to a customer",
      );
    }
    if (!isValidEvmAddress(existing.address)) {
      throw new DepositAddressError("INVALID_ADDRESS", "Stored deposit address is invalid");
    }
    const accountId = await ensureTurnkeyAccountId(existing);
    const sanitized = sanitizeWallet({...existing, turnkeyAccountId: accountId});
    return {
      success: true,
      created: false,
      userId: uid,
      network: resolvedNetwork,
      asset: ASSET,
      depositAddress: sanitized.depositAddress,
      turnkeyWalletId: sanitized.turnkeyWalletId,
      turnkeyAccountId: sanitized.turnkeyAccountId,
      status: sanitized.status,
    };
  }

  const allocated = await hierarchicalAccountService.allocateCustomerDepositAddress(uid);
  const wallet = allocated.wallet;
  if (isTreasuryAddress(wallet.address)) {
    throw new DepositAddressError(
        "TREASURY_ADDRESS",
        "Refusing to assign the treasury address to a customer",
    );
  }
  if (!isValidEvmAddress(wallet.address)) {
    throw new DepositAddressError("INVALID_ADDRESS", "Turnkey returned an invalid deposit address");
  }
  if (normalizeAddress(wallet.address) === normalizeAddress(getFujiNetwork().treasuryAddress)) {
    throw new DepositAddressError(
        "TREASURY_ADDRESS",
        "Refusing to assign the treasury address to a customer",
    );
  }

  const accountId = wallet.turnkeyAccountId || await ensureTurnkeyAccountId(wallet);
  const sanitized = sanitizeWallet({...wallet, turnkeyAccountId: accountId});
    return {
      success: true,
      created: allocated.created !== false,
    userId: uid,
    network: resolvedNetwork,
    asset: ASSET,
    depositAddress: sanitized.depositAddress,
    turnkeyWalletId: sanitized.turnkeyWalletId,
    turnkeyAccountId: sanitized.turnkeyAccountId,
    status: sanitized.status,
  };
}

/**
 * Lazy production Avalanche USDC address. After the production mapping is live,
 * this user's Fuji/dev cryptoWallets records are deleted.
 * @param {unknown} userId
 * @returns {Promise<Object>}
 */
async function getOrCreateProductionCustomerDepositAddress(userId) {
  const uid = assertUserId(userId);
  await assertUserExists(uid);
  const allocated = await hierarchicalAccountService.allocateProductionCustomerDepositAddress(uid);
  const wallet = allocated.wallet;
  if (isTreasuryAddress(wallet.address)) {
    throw new DepositAddressError(
        "TREASURY_ADDRESS",
        "Refusing to assign the treasury address to a customer",
    );
  }
  if (!isValidEvmAddress(wallet.address)) {
    throw new DepositAddressError("INVALID_ADDRESS", "Turnkey returned an invalid deposit address");
  }
  await turnkeyWalletService.deleteFujiCustomerWallets(uid);
  return {
    success: true,
    created: allocated.created === true,
    userId: uid,
    environment: "production",
    network: PRODUCTION_NETWORK,
    asset: ASSET,
    address: wallet.address,
    status: wallet.status || "live",
    turnkeyWalletId: wallet.turnkeyWalletId || wallet.walletId ||
      hierarchicalAccountService.PRODUCTION_PARENT_WALLET_ID,
    derivationIndex: wallet.derivationIndex,
  };
}

/**
 * Future scanner lookup: network + recipient address → user mapping.
 * @param {unknown} network
 * @param {unknown} address
 * @returns {Promise<Object|null>}
 */
async function getUserByDepositAddress(network, address) {
  const resolvedNetwork = assertSupportedNetwork(network);
  const wallet = await turnkeyWalletService.getWalletByAddress(address);
  if (!wallet) return null;
  if (wallet.network && wallet.network !== resolvedNetwork) return null;
  return wallet;
}

module.exports = {
  SUPPORTED_NETWORK,
  PRODUCTION_NETWORK,
  ASSET,
  DepositAddressError,
  assertSupportedNetwork,
  getOrCreateUserDepositAddress,
  getOrCreateCustomerDepositAddress,
  getOrCreateProductionCustomerDepositAddress,
  getUserByDepositAddress,
};
