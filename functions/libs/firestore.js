/**
 * @fileoverview Firestore client and collection references for TruePay backend.
 * Use this in services for consistent access; existing utils/firestore.js remains for balance/RTDB sync.
 */

const admin = require("../admin");
const config = require("../config");

const firestore = admin.firestore();
const { FieldValue } = admin.firestore;

/**
 * Get Firestore instance
 * @returns {admin.firestore.Firestore}
 */
function getFirestore() {
  return firestore;
}

/**
 * Get a collection reference by config key
 * @param {string} key - Key from config.collections (e.g. 'users', 'partners')
 * @returns {admin.firestore.CollectionReference}
 */
function collection(key) {
  const name = config.collections[key];
  if (!name) throw new Error(`Unknown collection key: ${key}`);
  return firestore.collection(name);
}

/**
 * Server timestamp for Firestore writes
 */
function serverTimestamp() {
  return FieldValue.serverTimestamp();
}

module.exports = {
  firestore,
  getFirestore,
  collection,
  serverTimestamp,
  FieldValue,
};
