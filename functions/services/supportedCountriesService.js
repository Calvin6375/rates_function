/**
 * @fileoverview Supported countries list (platform config in Firestore).
 * Read by consumer API and B2B; writes restricted to super-admin flow in adminActions.
 */

const admin = require("../admin");
const config = require("../config");

const firestore = admin.firestore();
const CONFIG_DOC_ID = "supportedCountries";

/** When no Firestore doc exists yet (ISO 3166-1 alpha-3) */
const DEFAULT_COUNTRY_CODES = ["KEN", "NGA", "GHA"];

/**
 * @returns {FirebaseFirestore.DocumentReference}
 */
function docRef() {
  return firestore.collection(config.collections.config).doc(CONFIG_DOC_ID);
}

/**
 * Normalize to unique uppercase ISO 3166-1 alpha-3 codes.
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeCountryCodes(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      continue;
    }
    const code = item.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) {
      throw new Error(`Invalid country code: ${item} (expected ISO 3166-1 alpha-3, e.g. ETH)`);
    }
    if (!seen.has(code)) {
      seen.add(code);
      out.push(code);
    }
  }
  return out;
}

/**
 * Public read: supported country codes for apps and B2B.
 * @returns {Promise<{ success: boolean, countries: string[], updatedAt: string|null, isDefault: boolean }>}
 */
async function getSupportedCountries() {
  const ref = docRef();
  const snap = await ref.get();
  if (!snap.exists) {
    return {
      success: true,
      countries: [...DEFAULT_COUNTRY_CODES],
      updatedAt: null,
      isDefault: true,
    };
  }
  const data = snap.data() || {};
  const raw = data.countries;
  let countries;
  try {
    countries = normalizeCountryCodes(raw);
  } catch (e) {
    console.error("supportedCountries: invalid stored data, falling back to default", e.message);
    countries = [...DEFAULT_COUNTRY_CODES];
  }
  if (countries.length === 0) {
    return {
      success: true,
      countries: [...DEFAULT_COUNTRY_CODES],
      updatedAt: data.updatedAt?.toDate?.()?.toISOString() || null,
      isDefault: true,
    };
  }
  return {
    success: true,
    countries,
    updatedAt: data.updatedAt?.toDate?.()?.toISOString() || null,
    isDefault: false,
  };
}

/**
 * Persist list (caller must enforce super-admin).
 * @param {string} actorUid
 * @param {string[]} countries
 * @returns {Promise<{ success: boolean, countries: string[], updatedAt: string }>}
 */
async function setSupportedCountries(actorUid, countries) {
  const normalized = normalizeCountryCodes(countries);
  if (normalized.length === 0) {
    throw new Error("countries must be a non-empty array of ISO 3166-1 alpha-3 codes (3 letters, e.g. ETH, KEN)");
  }
  if (normalized.length > 250) {
    throw new Error("Too many countries (max 250)");
  }

  const ref = docRef();
  const beforeSnap = await ref.get();
  const beforeData = beforeSnap.exists ? beforeSnap.data() : {};

  const updatePayload = {
    countries: normalized,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: actorUid,
  };

  await ref.set(updatePayload, { merge: true });

  const afterSnap = await ref.get();
  const afterData = afterSnap.data() || {};

  return {
    success: true,
    countries: afterData.countries || normalized,
    updatedAt: afterData.updatedAt?.toDate?.()?.toISOString() || new Date().toISOString(),
    updatedBy: actorUid,
    before: beforeData.countries || null,
  };
}

module.exports = {
  getSupportedCountries,
  setSupportedCountries,
  DEFAULT_COUNTRY_CODES,
  CONFIG_DOC_ID,
};
