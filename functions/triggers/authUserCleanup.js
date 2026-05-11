/**
 * @fileoverview Auth user deleted: remove matching Firestore and RTDB data.
 * Deployed Cloud Function name: **onAuthUserDeleted** (see functions/index.js).
 *
 * Runs only when a user is **removed from Firebase Authentication** (Console,
 * Admin SDK single delete, or client deleteAccount). It does **not** scan for
 * Firestore rows whose Auth user was deleted before this existed — use the
 * admin callable **pruneOrphanFirestoreUsers** for that.
 *
 * Uses v1 Auth triggers; v2 identity has no user delete lifecycle hook yet.
 */

const functions = require("firebase-functions/v1");
const config = require("../config");
const {deleteUserDataAcrossStores} = require("../libs/userAuthDataCleanup");

exports.onAuthUserDeleted = functions
    .region(config.region)
    .runWith({
      memory: "512MB",
      timeoutSeconds: 300,
    })
    .auth.user()
    .onDelete(async (user) => {
      const uid = user.uid;
      console.log(`🗑️ Auth user deleted, cleaning up data for uid=${uid}`);
      await deleteUserDataAcrossStores(uid, {requireUsersDocRemoved: true});
      console.log(`✅ Auth delete cleanup finished for uid=${uid}`);
    });
