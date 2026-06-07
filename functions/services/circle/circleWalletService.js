/**
 * @fileoverview Circle wallet lifecycle: create, lookup, deposit address.
 */

const { collection, serverTimestamp } = require("../../libs/firestore");
const circleService = require("./circleService");

const PROVIDER = "circle";
const ASSET = "USDC";
const STATUS_LIVE = "live";

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
  return { id: doc.id, ...doc.data() };
}

/**
 * Resolve wallet set id for new wallets.
 * @returns {Promise<string>}
 */
async function resolveWalletSetId() {
  const configured = process.env.CIRCLE_WALLET_SET_ID;
  if (configured) {
    return configured;
  }

  const client = circleService.getSdkClient();
  const response = await client.createWalletSet({
    name: `TruePay-${circleService.getCircleEnv()}`,
  });
  const walletSetId = response.data?.walletSet?.id;
  if (!walletSetId) {
    throw new Error("Circle wallet set creation failed");
  }
  return walletSetId;
}

/**
 * Create a Circle developer-controlled wallet for a user.
 * Idempotent: returns existing wallet if already provisioned.
 *
 * @param {string} userId
 * @returns {Promise<Object>}
 */
async function createWallet(userId) {
  const existing = await getWallet(userId);
  if (existing) {
    return existing;
  }

  if (!circleService.isCircleConfigured()) {
    throw new Error("Circle is not configured");
  }

  const walletSetId = await resolveWalletSetId();
  const blockchain = circleService.getDefaultBlockchain();
  const client = circleService.getSdkClient();

  const walletResponse = await client.createWallets({
    walletSetId,
    blockchains: [blockchain],
    count: 1,
    accountType: "EOA",
  });

  const circleWallet = walletResponse.data?.wallets?.[0];
  if (!circleWallet?.id || !circleWallet?.address) {
    throw new Error("Circle wallet creation failed: missing wallet id or address");
  }

  const walletDoc = {
    userId,
    provider: PROVIDER,
    walletId: circleWallet.id,
    address: circleWallet.address,
    addressLower: String(circleWallet.address).toLowerCase(),
    chain: circleService.getDefaultChainLabel(),
    blockchain,
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

/**
 * Find wallet by Circle wallet id.
 * @param {string} circleWalletId
 * @returns {Promise<Object|null>}
 */
async function getWalletByCircleId(circleWalletId) {
  const snap = await collection("cryptoWallets")
      .where("walletId", "==", circleWalletId)
      .where("provider", "==", PROVIDER)
      .limit(1)
      .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ref: doc.ref, ...doc.data() };
}

/**
 * Find wallet by on-chain deposit address.
 * @param {string} address
 * @returns {Promise<Object|null>}
 */
async function getWalletByAddress(address) {
  const normalized = String(address || "").toLowerCase();
  if (!normalized) return null;

  const snap = await collection("cryptoWallets")
      .where("addressLower", "==", normalized)
      .where("provider", "==", PROVIDER)
      .limit(1)
      .get();

  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ref: doc.ref, ...doc.data() };
}

module.exports = {
  PROVIDER,
  ASSET,
  createWallet,
  getWallet,
  getWalletByCircleId,
  getWalletByAddress,
};
