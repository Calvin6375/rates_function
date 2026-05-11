/**
 * @fileoverview Remove Firestore + RTDB data for a Firebase Auth uid.
 * Used by onAuthUserDeleted and by admin orphan pruning.
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
};
