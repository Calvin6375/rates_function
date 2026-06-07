/**
 * @fileoverview Wallet service: user wallet balances, partner wallets, balance updates, RTDB sync.
 * User wallets: source of truth remains Firestore users collection (backwards compatible).
 * Partner wallets: stored in wallets collection with ownerType: 'partner'.
 */

const admin = require("../admin");
const config = require("../config");
const { collection, serverTimestamp } = require("../libs/firestore");
const { ref } = require("../libs/realtime");
const { syncBalanceToRealtimeDatabase } = require("../utils/firestore");

const ledgerService = require("./ledger/ledgerService");
const circleRailAdapter = require("./circle/circleRailAdapter");

const OWNER_TYPES = Object.freeze({ user: "user", partner: "partner" });
const DEFAULT_BALANCES = { USD: 0, KES: 0, USDT: 0 };

/**
 * Get user wallet balances from Firestore (users collection).
 * Preserves existing structure for consumer app.
 *
 * @param {string} userId - Firebase user ID
 * @returns {Promise<{ USD: number, KES: number, USDT: number }|null>}
 */
async function getUserWalletBalances(userId) {
  const userDoc = await admin.firestore().collection(config.collections.users).doc(userId).get();
  if (!userDoc.exists) return null;
  const d = userDoc.data();
  return {
    USD: Number(d.usdBalance ?? d.USD ?? 0),
    KES: Number(d.kesBalance ?? d.KES ?? 0),
    USDT: Number(d.usdtBalance ?? d.USDT ?? 0),
  };
}

/**
 * Get or create partner wallet document in wallets collection.
 *
 * @param {string} partnerId - Partner ID
 * @returns {Promise<{ walletId: string, balances: Object }>}
 */
async function getOrCreatePartnerWallet(partnerId) {
  const col = collection("wallets");
  const snapshot = await col.where("ownerType", "==", OWNER_TYPES.partner).where("ownerId", "==", partnerId).limit(1).get();
  if (!snapshot.empty) {
    const doc = snapshot.docs[0];
    const data = doc.data();
    return {
      walletId: doc.id,
      balances: data.balances || { ...DEFAULT_BALANCES },
    };
  }
  const walletId = `wallet_partner_${partnerId}_${Date.now()}`;
  await col.doc(walletId).set({
    ownerType: OWNER_TYPES.partner,
    ownerId: partnerId,
    balances: { ...DEFAULT_BALANCES },
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return { walletId, balances: { ...DEFAULT_BALANCES } };
}

/**
 * Get partner wallet by partner ID
 *
 * @param {string} partnerId
 * @returns {Promise<{ walletId: string, balances: Object }|null>}
 */
async function getPartnerWallet(partnerId) {
  const snapshot = await collection("wallets")
    .where("ownerType", "==", OWNER_TYPES.partner)
    .where("ownerId", "==", partnerId)
    .limit(1)
    .get();
  if (snapshot.empty) return null;
  const doc = snapshot.docs[0];
  const data = doc.data();
  return {
    walletId: doc.id,
    balances: data.balances || { ...DEFAULT_BALANCES },
  };
}

/**
 * Update partner wallet balance (single currency). Uses Firestore transaction.
 *
 * @param {string} partnerId - Partner ID
 * @param {string} currency - USD | KES | USDT
 * @param {number} delta - Positive for credit, negative for debit
 * @param {Object} [options] - { allowNegative: boolean }
 * @returns {Promise<{ previousBalance: number, newBalance: number }>}
 */
async function updatePartnerWalletBalance(partnerId, currency, delta, options = {}) {
  const col = collection("wallets");
  const snapshot = await col.where("ownerType", "==", OWNER_TYPES.partner).where("ownerId", "==", partnerId).limit(1).get();
  if (snapshot.empty) {
    const { walletId } = await getOrCreatePartnerWallet(partnerId);
    const docRef = col.doc(walletId);
    const current = 0;
    const newBalance = Math.max(0, current + delta) || (options.allowNegative ? current + delta : 0);
    if (newBalance < 0 && !options.allowNegative) throw new Error("Insufficient partner wallet balance");
    await docRef.update({
      [`balances.${currency}`]: newBalance,
      updatedAt: serverTimestamp(),
    });
    return { previousBalance: current, newBalance };
  }
  const docRef = snapshot.docs[0].ref;
  let result;
  await admin.firestore().runTransaction(async (tx) => {
    const doc = await tx.get(docRef);
    if (!doc.exists) throw new Error("Partner wallet not found");
    const data = doc.data();
    const balances = data.balances || { ...DEFAULT_BALANCES };
    const current = Number(balances[currency] ?? 0);
    const newBalance = current + delta;
    if (newBalance < 0 && !options.allowNegative) throw new Error("Insufficient partner wallet balance");
    tx.update(docRef, {
      [`balances.${currency}`]: newBalance,
      updatedAt: serverTimestamp(),
    });
    result = { previousBalance: current, newBalance };
  });
  return result;
}

/**
 * Sync user balances to Realtime DB (for Flutter app). Delegates to existing util.
 *
 * @param {string} userId - User ID
 * @param {string} [currency='USD'] - Currency that was updated (triggers full sync of all)
 */
async function syncUserBalanceToRealtime(userId, currency = "USD") {
  await syncBalanceToRealtimeDatabase(userId, currency);
}

/**
 * Cache rates in Realtime DB for frontend (e.g. wallet/rates).
 *
 * @param {Object} rates - Key-value of rate data to cache
 */
async function cacheRatesInRealtime(rates) {
  const r = ref("wallet/rates");
  await r.set(rates);
}

/**
 * Get Circle USDC balance for a user.
 *
 * @param {string} userId
 * @returns {Promise<number>}
 */
async function getCryptoBalance(userId) {
  const wallet = await circleRailAdapter.getWallet(userId);
  if (!wallet) return 0;
  return ledgerService.getAvailableBalance(userId, "USDC");
}

/**
 * Aggregate fiat + crypto balances for a user.
 *
 * @param {string} userId
 * @returns {Promise<{ fiat: { USD: number, KES: number, USDT: number }, crypto: { USDC: number } }|null>}
 */
async function getBalances(userId) {
  const fiat = await getUserWalletBalances(userId);
  if (!fiat) return null;
  const usdc = await getCryptoBalance(userId);
  return {
    fiat,
    crypto: {
      USDC: usdc,
    },
  };
}

module.exports = {
  OWNER_TYPES,
  getUserWalletBalances,
  getCryptoBalance,
  getBalances,
  getOrCreatePartnerWallet,
  getPartnerWallet,
  updatePartnerWalletBalance,
  syncUserBalanceToRealtime,
  cacheRatesInRealtime,
};
