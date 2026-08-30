/**
 * @fileoverview Supported currencies for apps/B2B — derived from the P2P rates book.
 *
 * Product rule: a currency present in `config/customerRates` is supported.
 * `GET /countries` keeps the legacy field name `countries` but values are
 * **currency codes** (ETB, KES, USDC), not ISO 3166-1 country codes.
 *
 * Writes: use PUT /api/config/fees (add/remove rate rows). The callable
 * `setSupportedCountries` is deprecated and rejected.
 */

const admin = require("../admin");
const config = require("../config");
const {listCurrenciesFromRates} = require("../utils/customerRatesResolve");

const firestore = admin.firestore();
/** @deprecated Legacy Firestore doc; no longer authoritative. */
const CONFIG_DOC_ID = "supportedCountries";
const CUSTOMER_RATES_DOC_ID = "customerRates";

/** @deprecated Kept for export compatibility; empty book no longer falls back to these. */
const DEFAULT_COUNTRY_CODES = Object.freeze([]);

const SET_DEPRECATED_MESSAGE =
  "Supported currencies are managed via P2P rates (PUT /api/config/fees). " +
  "Add or remove a currency rate instead of calling setSupportedCountries.";

/**
 * @returns {FirebaseFirestore.DocumentReference}
 */
function customerRatesRef() {
  return firestore.collection(config.collections.config).doc(CUSTOMER_RATES_DOC_ID);
}

/**
 * Build public payload from a customerRates document body (pure; testable).
 *
 * @param {FirebaseFirestore.DocumentData|null|undefined} data
 * @returns {{
 *   success: true,
 *   countries: string[],
 *   currencies: string[],
 *   source: "customerRates",
 *   rateVersion: number|null,
 *   updatedAt: string|null,
 *   isDefault: boolean,
 * }}
 */
function buildSupportedCurrenciesPayload(data) {
  const rates = data && typeof data.rates === "object" && data.rates ? data.rates : {};
  const currencies = listCurrenciesFromRates(rates);
  const rateVersion =
    data && Number.isFinite(Number(data.rateVersion)) ? Number(data.rateVersion) : null;
  // normalizeKesBook always injects KES; isDefault means "no admin rates stored yet".
  const hasStoredRates = Object.keys(rates).length > 0;

  let updatedAt = null;
  const rawUpdated = data && data.updatedAt;
  if (rawUpdated && typeof rawUpdated.toDate === "function") {
    updatedAt = rawUpdated.toDate().toISOString();
  } else if (typeof rawUpdated === "string") {
    updatedAt = rawUpdated;
  }

  return {
    success: true,
    // Legacy response field — now currency codes from the rates book.
    countries: currencies,
    currencies,
    source: "customerRates",
    rateVersion,
    updatedAt,
    isDefault: !hasStoredRates,
  };
}

/**
 * Public read: supported currency codes derived from config/customerRates.
 * @returns {Promise<ReturnType<typeof buildSupportedCurrenciesPayload>>}
 */
async function getSupportedCountries() {
  const snap = await customerRatesRef().get();
  if (!snap.exists) {
    return buildSupportedCurrenciesPayload(null);
  }
  return buildSupportedCurrenciesPayload(snap.data() || {});
}

/**
 * @deprecated Use PUT /api/config/fees to add/remove currency rates.
 * @param {string} _actorUid
 * @param {unknown} _countries
 * @param {{ replace?: boolean }} [_options]
 * @returns {Promise<never>}
 */
async function setSupportedCountries(_actorUid, _countries, _options = {}) {
  const err = new Error(SET_DEPRECATED_MESSAGE);
  err.code = "failed-precondition";
  err.deprecated = true;
  throw err;
}

module.exports = {
  getSupportedCountries,
  setSupportedCountries,
  buildSupportedCurrenciesPayload,
  SET_DEPRECATED_MESSAGE,
  DEFAULT_COUNTRY_CODES,
  CONFIG_DOC_ID,
  CUSTOMER_RATES_DOC_ID,
};
