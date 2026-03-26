/**
 * @fileoverview Platform super-admin reads for consumer (customer app) users — Firestore users collection.
 * Used by b2bPortal /platform/* for a unified operations dashboard alongside B2B partners.
 */

const admin = require("../admin");
const { collection } = require("../libs/firestore");
const config = require("../config");

const MAX_PAGE = 100;

/**
 * @param {FirebaseFirestore.QueryDocumentSnapshot} doc
 * @returns {Object}
 */
function serializeConsumerUserSummary(doc) {
  const d = doc.data();
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
  const users = snap.docs.map((doc) => serializeConsumerUserSummary(doc));
  const nextCursor = snap.docs.length === lim ? snap.docs[snap.docs.length - 1].id : null;
  return { users, nextCursor };
}

/**
 * @param {string} userId
 * @returns {Promise<Object|null>}
 */
async function getConsumerUser(userId) {
  const doc = await collection("users").doc(userId).get();
  return serializeConsumerUserDetail(doc);
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
