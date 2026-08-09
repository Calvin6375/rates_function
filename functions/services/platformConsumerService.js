/**
 * @fileoverview Platform super-admin reads for consumer (customer app) users — Firestore users collection.
 * Used by b2bPortal /platform/* for a unified operations dashboard alongside B2B partners.
 */

const admin = require("../admin");
const { collection } = require("../libs/firestore");
const config = require("../config");
const { getCustomClaims } = require("../utils/customClaimsMerge");
const {
  parseAccessFromToken,
  normalizePartnerRole,
  legacyPartnerRoleFromNormalized,
} = require("../utils/accessControl");
const b2bWalletBalanceSync = require("./b2bWalletBalanceSync");

const MAX_PAGE = 100;
const ONBOARDING_COL = "onboarding";
const INSTITUTION_PARTNER_DASHBOARD = "PartnerDashboard";
const CHANNEL_B2B = "B2B";

/**
 * @param {{ institution?: string|null, channel?: string|null }} user
 * @returns {boolean}
 */
function isB2BDashboardProfile(user) {
  return user.channel === CHANNEL_B2B &&
    user.institution === INSTITUTION_PARTNER_DASHBOARD;
}

/**
 * Resolve partner linkage from Auth claims and, for B2B dashboard profiles,
 * onboarding.registeredPartnerId when the partner doc exists.
 *
 * @param {string} uid
 * @param {boolean} checkOnboardingFallback
 * @returns {Promise<{ partnerId: string|null, partnerRole: string|null, userType: string|null, role: string|null }>}
 */
async function resolvePartnerContextForUid(uid, checkOnboardingFallback) {
  let partnerId = null;
  let partnerRole = null;
  let userType = null;
  let role = null;

  try {
    const claims = await getCustomClaims(uid);
    const access = parseAccessFromToken(claims);
    userType = access.userType;
    role = access.role;
    if (typeof claims.partnerId === "string" && claims.partnerId.trim()) {
      partnerId = claims.partnerId.trim();
    }
    if (access.role && partnerId) {
      partnerRole = legacyPartnerRoleFromNormalized(access.role);
    } else if (typeof claims.partnerRole === "string" && claims.partnerRole.trim()) {
      partnerRole = claims.partnerRole.trim();
      role = role || normalizePartnerRole(partnerRole);
    }
    if (!userType && partnerId) {
      userType = "partner";
    }
  } catch (err) {
    if (err.code !== "auth/user-not-found") {
      throw err;
    }
  }

  if (!partnerId && checkOnboardingFallback) {
    const obSnap = await collection(ONBOARDING_COL).doc(uid).get();
    const registeredPartnerId = obSnap.exists ?
      obSnap.data()?.registeredPartnerId :
      null;
    if (registeredPartnerId && typeof registeredPartnerId === "string") {
      const candidate = registeredPartnerId.trim();
      if (candidate) {
        const partnerSnap = await collection("partners").doc(candidate).get();
        if (partnerSnap.exists) {
          partnerId = candidate;
        }
      }
    }
  }

  return { partnerId, partnerRole, userType, role };
}

/**
 * @param {Object[]} users
 * @returns {Promise<Object[]>}
 */
async function enrichUsersWithPartnerContext(users) {
  if (!users.length) {
    return users;
  }

  const contexts = await Promise.all(
      users.map((user) => resolvePartnerContextForUid(
          user.userId,
          isB2BDashboardProfile(user),
      )),
  );

  const partnerIds = [
    ...new Set(contexts.map((ctx) => ctx.partnerId).filter(Boolean)),
  ];
  /** @type {Record<string, string|null>} */
  const nameByPartnerId = {};
  if (partnerIds.length) {
    const refs = partnerIds.map((id) => collection("partners").doc(id));
    const snaps = await admin.firestore().getAll(...refs);
    for (const snap of snaps) {
      if (snap.exists) {
        const name = snap.data()?.name;
        nameByPartnerId[snap.id] =
          name != null && String(name).trim() ? String(name).trim() : null;
      }
    }
  }

  const walletByPartnerId =
    await b2bWalletBalanceSync.loadPartnerWalletBalancesByIds(partnerIds);

  return users.map((user, index) => {
    const ctx = contexts[index];
    const { partnerId, partnerRole, userType, role } = ctx;
    const isB2b = b2bWalletBalanceSync.isB2bDashboardUser(user);
    const partnerBalances = partnerId ? walletByPartnerId[partnerId] : null;
    // Enterprise (B2B) tab must show partner org wallet — same source as GET /portal/wallet.
    const USD = isB2b && partnerBalances ? partnerBalances.USD : (user.USD ?? 0);
    const KES = isB2b && partnerBalances ? partnerBalances.KES : (user.KES ?? 0);
    const USDT = isB2b && partnerBalances ? partnerBalances.USDT : (user.USDT ?? 0);
    // If partner wallet is empty but users doc still has legacy credit, show legacy
    // until GET /portal/wallet migrates it (so admin still sees the 50k).
    const legacyKes = Number(user.KES ?? 0) || 0;
    const legacyUsd = Number(user.USD ?? 0) || 0;
    const legacyUsdt = Number(user.USDT ?? 0) || 0;
    const useLegacyOverlay = isB2b && partnerBalances &&
      partnerBalances.KES === 0 && partnerBalances.USD === 0 &&
      partnerBalances.USDT === 0 &&
      (legacyKes > 0 || legacyUsd > 0 || legacyUsdt > 0);

    return {
      ...user,
      userType: userType || user.userType || null,
      role: role || user.role || null,
      partnerId,
      partnerRole,
      partnerName: partnerId ? (nameByPartnerId[partnerId] ?? null) : null,
      USD: useLegacyOverlay ? legacyUsd : USD,
      KES: useLegacyOverlay ? legacyKes : KES,
      USDT: useLegacyOverlay ? legacyUsdt : USDT,
      walletSource: isB2b ?
        (useLegacyOverlay ? "users_legacy" : "partner_wallet") :
        "user",
    };
  });
}

/**
 * @param {FirebaseFirestore.QueryDocumentSnapshot} doc
 * @returns {Object}
 */
function serializeConsumerUserSummary(doc) {
  const d = doc.data();
  const userBalances = b2bWalletBalanceSync.readUserCurrencyBalances(d || {});
  return {
    userId: doc.id,
    email: d.email ?? null,
    name: d.name ?? d.firstName ?? null,
    phoneNumber: d.phoneNumber ?? null,
    country: d.country ?? null,
    kycStatus: d.kycStatus ?? null,
    balance: d.balance != null ? Number(d.balance) : null,
    fiatBalance: d.fiatBalance != null ? Number(d.fiatBalance) : null,
    cryptoBalance: d.cryptoBalance != null ? Number(d.cryptoBalance) : null,
    currency: d.currency ?? null,
    /** Per-currency balances (users doc; B2B list may overlay partner wallet). */
    USD: userBalances.USD,
    KES: userBalances.KES,
    USDT: userBalances.USDT,
    institution: d.institution ?? null,
    channel: d.channel ?? null,
    createdAt: d.createdAt?.toDate?.()?.toISOString() ?? null,
    updatedAt: d.updatedAt?.toDate?.()?.toISOString() ?? null,
  };
}

/**
 * @param {FirebaseFirestore.DocumentSnapshot} doc
 * @returns {Object|null}
 */
function serializeConsumerUserDetail(doc) {
  if (!doc.exists) return null;
  const d = doc.data();
  const kycData = d.kycData;
  const kycSummary =
    kycData && typeof kycData === "object"
      ? Object.keys(kycData).length > 20
        ? { _truncated: true, keys: Object.keys(kycData) }
        : kycData
      : kycData ?? null;

  return {
    userId: doc.id,
    email: d.email ?? null,
    name: d.name ?? d.firstName ?? null,
    phoneNumber: d.phoneNumber ?? null,
    country: d.country ?? null,
    kycStatus: d.kycStatus ?? null,
    kycData: kycSummary,
    balance: d.balance != null ? Number(d.balance) : null,
    fiatBalance: d.fiatBalance != null ? Number(d.fiatBalance) : null,
    cryptoBalance: d.cryptoBalance != null ? Number(d.cryptoBalance) : null,
    currency: d.currency ?? null,
    role: d.role ?? null,
    institution: d.institution ?? null,
    channel: d.channel ?? null,
    createdAt: d.createdAt?.toDate?.()?.toISOString() ?? null,
    updatedAt: d.updatedAt?.toDate?.()?.toISOString() ?? null,
  };
}

/**
 * Paginate consumer users by document ID (stable, no composite index).
 *
 * @param {number} [pageLimit=50]
 * @param {string|null} [startAfterUserId]
 * @returns {Promise<{ users: Object[], nextCursor: string|null }>}
 */
async function listConsumerUsers(pageLimit = 50, startAfterUserId = null) {
  const lim = Math.min(Math.max(parseInt(String(pageLimit), 10) || 50, 1), MAX_PAGE);
  const col = collection("users");
  const FieldPath = admin.firestore.FieldPath;
  let q = col.orderBy(FieldPath.documentId()).limit(lim);
  if (startAfterUserId && typeof startAfterUserId === "string") {
    q = q.startAfter(startAfterUserId);
  }
  const snap = await q.get();
  const summaries = snap.docs.map((doc) => serializeConsumerUserSummary(doc));
  const users = await enrichUsersWithPartnerContext(summaries);
  const nextCursor = snap.docs.length === lim ? snap.docs[snap.docs.length - 1].id : null;
  return { users, nextCursor };
}

/**
 * @param {string} userId
 * @returns {Promise<Object|null>}
 */
async function getConsumerUser(userId) {
  const doc = await collection("users").doc(userId).get();
  const detail = serializeConsumerUserDetail(doc);
  if (!detail) {
    return null;
  }
  const [enriched] = await enrichUsersWithPartnerContext([detail]);
  return enriched;
}

/**
 * Aggregate counts for platform dashboard (read-only).
 *
 * @returns {Promise<{ consumerUserCount: number, partnerCount: number }>}
 */
async function getPlatformOverviewCounts() {
  const usersCol = admin.firestore().collection(config.collections.users);
  const partnersCol = admin.firestore().collection(config.collections.partners);
  const [usersSnap, partnersSnap] = await Promise.all([usersCol.count().get(), partnersCol.count().get()]);
  return {
    consumerUserCount: usersSnap.data().count,
    partnerCount: partnersSnap.data().count,
  };
}

module.exports = {
  listConsumerUsers,
  getConsumerUser,
  getPlatformOverviewCounts,
  MAX_PAGE,
};
