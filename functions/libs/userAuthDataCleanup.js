/**
 * @fileoverview Remove Firestore + RTDB data for a Firebase Auth uid.
 * Used by onAuthUserDeleted and by admin user deletion.
 *
 * Hard-delete must free the Auth email/phone. Listing uses Firestore
 * `users/{docId}`; if that id is not the Auth uid, delete-by-uid skips Auth
 * and signup fails with email-already-exists.
 */

const admin = require("../admin");
const config = require("../config");

const firestore = admin.firestore();

/**
 * @param {Object} docRef Firestore document reference
 * @return {Promise<Object>}
 */
async function recursiveDeleteIfExists(docRef) {
  try {
    const snap = await docRef.get();
    if (!snap.exists) {
      return {path: docRef.path, deleted: false};
    }
    await firestore.recursiveDelete(docRef);
    return {path: docRef.path, deleted: true};
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    return {path: docRef.path, deleted: false, error: msg};
  }
}

/**
 * @param {string} path
 * @return {Promise<void>}
 */
async function removeRtdbPathIfAny(path) {
  try {
    const ref = admin.database().ref(path);
    const snap = await ref.once("value");
    if (snap.exists()) {
      await ref.remove();
    }
  } catch (err) {
    console.warn(`⚠️ RTDB cleanup skipped or failed for ${path}:`, err.message);
  }
}

/**
 * @param {string} email
 * @returns {string}
 */
function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function looksLikeEmail(value) {
  return String(value || "").includes("@");
}

/**
 * @param {string} id
 * @returns {boolean}
 */
function looksLikeAuthUid(id) {
  const s = String(id || "").trim();
  return s.length > 0 && s.length <= 128 && !s.includes("@");
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isAuthNotFound(err) {
  const code = err && err.code;
  return code === "auth/user-not-found" ||
    code === "auth/invalid-uid" ||
    code === "auth/invalid-email" ||
    code === "auth/invalid-phone-number";
}

/**
 * @param {string} raw
 * @returns {string[]}
 */
function phoneLookupVariants(raw) {
  const s = String(raw || "").trim();
  if (!s) return [];
  const out = new Set([s]);
  const digits = s.replace(/[^\d+]/g, "");
  if (digits) out.add(digits);
  if (digits && !digits.startsWith("+")) {
    out.add(`+${digits}`);
  }
  return [...out];
}

/**
 * @param {string} uid
 * @returns {Promise<import("firebase-admin/auth").UserRecord|null>}
 */
async function getAuthUserByUid(uid) {
  try {
    return await admin.auth().getUser(uid);
  } catch (err) {
    if (isAuthNotFound(err)) return null;
    throw err;
  }
}

/**
 * @param {string} email
 * @returns {Promise<import("firebase-admin/auth").UserRecord|null>}
 */
async function getAuthUserByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized || !looksLikeEmail(normalized)) return null;
  try {
    return await admin.auth().getUserByEmail(normalized);
  } catch (err) {
    if (isAuthNotFound(err)) return null;
    throw err;
  }
}

/**
 * @param {string} phone
 * @returns {Promise<import("firebase-admin/auth").UserRecord|null>}
 */
async function getAuthUserByPhone(phone) {
  if (!phone) return null;
  try {
    return await admin.auth().getUserByPhoneNumber(phone);
  } catch (err) {
    if (isAuthNotFound(err)) return null;
    throw err;
  }
}

/**
 * Collect Auth UIDs that still occupy this account's email/phone.
 *
 * @param {string} userId Firestore users doc id or Auth uid
 * @returns {Promise<{
 *   uids: string[],
 *   emails: string[],
 *   phones: string[],
 * }>}
 */
async function resolveAuthIdentitiesForDelete(userId) {
  const uids = new Set();
  const emails = new Set();
  const phones = new Set();
  const targetId = String(userId || "").trim();

  if (!targetId) {
    return {uids: [], emails: [], phones: []};
  }

  const userSnap = await firestore.collection(config.collections.users).doc(targetId).get();
  const profile = userSnap.exists ? (userSnap.data() || {}) : {};
  if (profile.email) {
    const rawEmail = String(profile.email).trim();
    if (rawEmail) emails.add(rawEmail);
    emails.add(normalizeEmail(profile.email));
  }
  if (profile.phoneNumber) {
    for (const p of phoneLookupVariants(profile.phoneNumber)) phones.add(p);
  }
  if (profile.phone) {
    for (const p of phoneLookupVariants(profile.phone)) phones.add(p);
  }

  if (looksLikeEmail(targetId)) {
    emails.add(normalizeEmail(targetId));
  }
  if (looksLikeAuthUid(targetId)) {
    uids.add(targetId);
  }

  if (looksLikeAuthUid(targetId)) {
    const byUid = await getAuthUserByUid(targetId);
    if (byUid) {
      uids.add(byUid.uid);
      if (byUid.email) emails.add(normalizeEmail(byUid.email));
      if (byUid.phoneNumber) {
        for (const p of phoneLookupVariants(byUid.phoneNumber)) phones.add(p);
      }
    }
  }

  for (const email of [...emails]) {
    const byEmail = await getAuthUserByEmail(email);
    if (byEmail) {
      uids.add(byEmail.uid);
      if (byEmail.phoneNumber) {
        for (const p of phoneLookupVariants(byEmail.phoneNumber)) phones.add(p);
      }
    }
  }

  for (const phone of [...phones]) {
    const byPhone = await getAuthUserByPhone(phone);
    if (byPhone) {
      uids.add(byPhone.uid);
      if (byPhone.email) emails.add(normalizeEmail(byPhone.email));
    }
  }

  return {
    uids: [...uids],
    emails: [...emails].filter(Boolean),
    phones: [...phones].filter(Boolean),
  };
}

/**
 * @param {string} uid
 * @returns {Promise<boolean>}
 */
async function deleteAuthUserIfExists(uid) {
  try {
    await admin.auth().deleteUser(uid);
    return true;
  } catch (err) {
    if (isAuthNotFound(err)) return false;
    throw err;
  }
}

/**
 * Remove legacy `customerWallets` rows keyed by auto-id (email field).
 *
 * @param {string[]} emails
 * @returns {Promise<number>}
 */
async function deleteCustomerWalletsByEmails(emails) {
  let deleted = 0;
  const col = firestore.collection(config.collections.customerWallets);
  for (const email of emails) {
    if (!email) continue;
    const snap = await col.where("email", "==", email).limit(50).get();
    for (const doc of snap.docs) {
      await doc.ref.delete();
      deleted += 1;
    }
  }
  return deleted;
}

/**
 * Extra `users` docs that share the email but a different document id.
 *
 * @param {string[]} emails
 * @param {Set<string>} already
 * @returns {Promise<string[]>}
 */
async function findUserDocIdsByEmails(emails, already) {
  const extra = [];
  const col = firestore.collection(config.collections.users);
  for (const email of emails) {
    if (!email) continue;
    const snap = await col.where("email", "==", email).limit(50).get();
    for (const doc of snap.docs) {
      if (!already.has(doc.id)) extra.push(doc.id);
    }
  }
  return extra;
}

/**
 * Delete Auth (by uid, email, and phone) then Firestore/RTDB so the email
 * can be used to sign up again.
 *
 * @param {string} userId
 * @param {Object} [opts]
 * @param {string[]} [opts.protectedUids] Never delete these Auth users
 * @returns {Promise<{
 *   authDeletedUids: string[],
 *   dataDeletedUids: string[],
 *   emails: string[],
 * }>}
 */
async function purgeUserAccount(userId, opts = {}) {
  const protectedUids = new Set(
      (opts.protectedUids || []).filter(Boolean).map((id) => String(id)),
  );
  const identities = await resolveAuthIdentitiesForDelete(userId);
  const authDeletedUids = [];
  const dataUids = new Set(identities.uids);
  dataUids.add(String(userId || "").trim());

  for (const uid of identities.uids) {
    if (!uid || protectedUids.has(uid)) continue;
    const deleted = await deleteAuthUserIfExists(uid);
    if (deleted) authDeletedUids.push(uid);
  }

  const extraDocs = await findUserDocIdsByEmails(
      identities.emails,
      dataUids,
  );
  for (const extraId of extraDocs) dataUids.add(extraId);

  const dataDeletedUids = [];
  for (const uid of dataUids) {
    if (!uid || protectedUids.has(uid)) continue;
    await deleteUserDataAcrossStores(uid, {requireUsersDocRemoved: true});
    dataDeletedUids.push(uid);
  }

  await deleteCustomerWalletsByEmails(identities.emails);

  return {
    authDeletedUids,
    dataDeletedUids,
    emails: identities.emails,
  };
}

/**
 * Delete users/{uid}, transactions/{uid}, onboarding/{uid},
 * customerWallets/{uid}, and best-effort RTDB paths for this uid.
 *
 * @param {string} uid
 * @param {Object} [opts]
 * @param {boolean} [opts.requireUsersDocRemoved] Default true: throw if
 *     users/{uid} exists but recursive delete fails.
 * @return {Promise<void>}
 */
async function deleteUserDataAcrossStores(uid, opts = {}) {
  const ru = opts.requireUsersDocRemoved;
  const requireUsers = ru === undefined ? true : ru;

  const usersCol = config.collections.users;
  const txCol = config.collections.transactions;
  const onboardingCol = config.collections.onboarding;
  const legacyWalletsCol = config.collections.customerWallets;

  const userDoc = firestore.collection(usersCol).doc(uid);
  const userSnap = await userDoc.get();
  const userResult = await recursiveDeleteIfExists(userDoc);

  if (requireUsers && userSnap.exists && !userResult.deleted) {
    const detail = userResult.error || "unknown";
    throw new Error(`Failed to delete Firestore users/${uid}: ${detail}`);
  }

  const txDoc = firestore.collection(txCol).doc(uid);
  const obDoc = firestore.collection(onboardingCol).doc(uid);
  const cwDoc = firestore.collection(legacyWalletsCol).doc(uid);

  const firestoreTasks = [
    recursiveDeleteIfExists(txDoc),
    recursiveDeleteIfExists(obDoc),
    recursiveDeleteIfExists(cwDoc),
  ];

  const fsResults = await Promise.allSettled(firestoreTasks);
  fsResults.forEach((r, i) => {
    if (r.status === "rejected") {
      const msg = r.reason && r.reason.message ? r.reason.message : r.reason;
      console.error(`❌ Firestore cleanup task ${i} failed for ${uid}:`, msg);
    } else if (r.value.error) {
      const p = r.value.path;
      const errMsg = r.value.error;
      console.error(`❌ Firestore cleanup path for ${uid}: ${p}: ${errMsg}`);
    } else if (r.value.deleted) {
      console.log(`✅ Removed Firestore subtree: ${r.value.path}`);
    }
  });

  await Promise.all([
    removeRtdbPathIfAny(`users/${uid}`),
    removeRtdbPathIfAny(`wallet/${uid}`),
    removeRtdbPathIfAny(`wallet/balance/${uid}`),
    removeRtdbPathIfAny(`balances/${uid}`),
  ]);
}

module.exports = {
  deleteUserDataAcrossStores,
  purgeUserAccount,
  resolveAuthIdentitiesForDelete,
  normalizeEmail,
};
