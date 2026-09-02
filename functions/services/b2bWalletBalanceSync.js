/**
 * @fileoverview Align B2B Enterprise admin credits with partner wallets.
 * Legacy admin top-ups wrote to users/{uid}.kesBalance; partner dashboard
 * reads wallets (ownerType=partner). This module migrates and resolves that gap.
 */

const {collection, serverTimestamp} = require("../libs/firestore");
const {getCustomClaims} = require("../utils/customClaimsMerge");
const walletService = require("./walletService");

const INSTITUTION_PARTNER_DASHBOARD = "PartnerDashboard";
const CHANNEL_B2B = "B2B";
const CURRENCIES = ["USD", "KES", "USDT"];

/**
 * @param {Object|null|undefined} userData
 * @returns {boolean}
 */
function isB2bDashboardUser(userData) {
  if (!userData || typeof userData !== "object") return false;
  const institution = String(userData.institution || "").trim();
  const channel = String(userData.channel || "").trim();
  return channel === CHANNEL_B2B &&
    (institution === INSTITUTION_PARTNER_DASHBOARD ||
      /^partner\s*dash/i.test(institution));
}

/**
 * @param {Object} userData
 * @returns {{ USD: number, KES: number, USDT: number }}
 */
function readUserCurrencyBalances(userData) {
  const wallets = userData.wallets && typeof userData.wallets === "object" ?
    userData.wallets :
    {};
  return {
    USD: Number(userData.usdBalance ?? userData.USD ?? wallets.USD ?? 0) || 0,
    KES: Number(userData.kesBalance ?? userData.KES ?? wallets.KES ?? 0) || 0,
    USDT: Number(userData.usdtBalance ?? userData.USDT ?? wallets.USDT ?? 0) || 0,
  };
}

/**
 * Resolve partner org id for a B2B dashboard Firebase user.
 *
 * @param {string} uid
 * @param {Object|null|undefined} [userData]
 * @returns {Promise<string|null>}
 */
async function resolvePartnerIdForB2bUser(uid, userData = null) {
  let data = userData;
  if (!data) {
    const snap = await collection("users").doc(uid).get();
    if (!snap.exists) return null;
    data = snap.data() || {};
  }
  if (!isB2bDashboardUser(data)) {
    return null;
  }

  try {
    const claims = await getCustomClaims(uid);
    if (typeof claims.partnerId === "string" && claims.partnerId.trim()) {
      return claims.partnerId.trim();
    }
  } catch (err) {
    if (err.code !== "auth/user-not-found") {
      console.warn("resolvePartnerIdForB2bUser claims:", err.message);
    }
  }

  const obSnap = await collection("onboarding").doc(uid).get();
  const registered = obSnap.exists ? obSnap.data()?.registeredPartnerId : null;
  if (registered && typeof registered === "string" && registered.trim()) {
    const partnerId = registered.trim();
    const partnerSnap = await collection("partners").doc(partnerId).get();
    if (partnerSnap.exists) {
      return partnerId;
    }
  }
  return null;
}

/**
 * Move stranded users/{uid} balances into the partner wallet (once).
 *
 * @param {string} uid - Org admin / B2B dashboard user
 * @param {string} partnerId
 * @returns {Promise<{ migrated: boolean, moved?: Object, partnerId?: string }>}
 */
async function migrateLegacyUserBalancesToPartnerWallet(uid, partnerId) {
  if (!uid || !partnerId) {
    return {migrated: false};
  }

  const userRef = collection("users").doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    return {migrated: false};
  }
  const userData = userSnap.data() || {};
  if (!isB2bDashboardUser(userData)) {
    return {migrated: false};
  }

  const balances = readUserCurrencyBalances(userData);
  const hasLegacy =
    balances.USD > 0 || balances.KES > 0 || balances.USDT > 0;

  // Re-absorb stranded users.* balances even after a prior migration pass.
  // Mis-routed funding (creditUserFiat on the partner actor) can land AFTER the
  // one-shot flag was set when balances were zero — Send would stay at KSh 0.
  if (!hasLegacy) {
    if (userData.partnerWalletBalanceMigrated !== true) {
      await userRef.set(
          {
            partnerWalletBalanceMigrated: true,
            updatedAt: serverTimestamp(),
          },
          {merge: true},
      );
    }
    return {migrated: false};
  }

  await walletService.getOrCreatePartnerWallet(partnerId);
  /** @type {Record<string, number>} */
  const moved = {};
  for (const cur of CURRENCIES) {
    const amt = balances[cur];
    if (amt > 0) {
      await walletService.updatePartnerWalletBalance(partnerId, cur, amt);
      moved[cur] = amt;
    }
  }

  await userRef.set(
      {
        usdBalance: 0,
        USD: 0,
        kesBalance: 0,
        KES: 0,
        usdtBalance: 0,
        USDT: 0,
        wallets: {USD: 0, KES: 0, USDT: 0},
        partnerWalletBalanceMigrated: true,
        partnerWalletBalanceMigratedAt: serverTimestamp(),
        partnerWalletBalanceMigratedPartnerId: String(partnerId),
        updatedAt: serverTimestamp(),
      },
      {merge: true},
  );

  console.log("✅ Migrated legacy B2B user balances → partner wallet", {
    uid,
    partnerId,
    moved,
  });

  return {migrated: true, moved, partnerId: String(partnerId)};
}

/**
 * Ensure partner wallet is loaded after absorbing any legacy users/{uid} balances.
 *
 * @param {string} partnerId
 * @param {string} uid
 * @returns {Promise<{ walletId: string, balances: Object, migration?: Object }>}
 */
async function getPartnerWalletAfterLegacySync(partnerId, uid) {
  let migration = null;
  try {
    migration = await migrateLegacyUserBalancesToPartnerWallet(uid, partnerId);
  } catch (err) {
    console.warn("getPartnerWalletAfterLegacySync migrate:", err.message);
  }
  let wallet = await walletService.getPartnerWallet(partnerId);
  if (!wallet) {
    wallet = await walletService.getOrCreatePartnerWallet(partnerId);
  }
  return {
    walletId: wallet.walletId,
    balances: wallet.balances || {USD: 0, KES: 0, USDT: 0},
    ...(migration && migration.migrated ? {migration} : {}),
  };
}

/**
 * Batch-load partner wallet balances for many partner ids.
 *
 * @param {string[]} partnerIds
 * @returns {Promise<Record<string, { USD: number, KES: number, USDT: number }>>}
 */
async function loadPartnerWalletBalancesByIds(partnerIds) {
  /** @type {Record<string, { USD: number, KES: number, USDT: number }>} */
  const out = {};
  const unique = [...new Set(partnerIds.filter(Boolean).map(String))];
  await Promise.all(unique.map(async (partnerId) => {
    try {
      const wallet = await walletService.getPartnerWallet(partnerId);
      const b = wallet?.balances || {};
      out[partnerId] = {
        USD: Number(b.USD ?? 0) || 0,
        KES: Number(b.KES ?? 0) || 0,
        USDT: Number(b.USDT ?? 0) || 0,
      };
    } catch (_e) {
      out[partnerId] = {USD: 0, KES: 0, USDT: 0};
    }
  }));
  return out;
}

module.exports = {
  isB2bDashboardUser,
  readUserCurrencyBalances,
  resolvePartnerIdForB2bUser,
  migrateLegacyUserBalancesToPartnerWallet,
  getPartnerWalletAfterLegacySync,
  loadPartnerWalletBalancesByIds,
  INSTITUTION_PARTNER_DASHBOARD,
  CHANNEL_B2B,
};
