/**
 * @fileoverview Sanitize customer emails before Paystack initialize.
 * Paystack rejects invalid addresses (e.g. gmail.coma) with 400.
 */

const {
  looksLikeEmail,
  suggestEmailCorrection,
  isValidCustomerEmail,
} = require("./emailValidation");

const FALLBACK_PAYSTACK_EMAIL = "tourist@truepay.africa";

/**
 * @param {unknown} raw
 * @param {string} [fallback]
 * @returns {{ email: string, usedFallback: boolean, corrected: boolean }}
 */
function resolvePaystackCustomerEmail(raw, fallback = FALLBACK_PAYSTACK_EMAIL) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) {
    return {email: fallback, usedFallback: true, corrected: false};
  }

  const suggested = suggestEmailCorrection(trimmed);
  if (!suggested || !looksLikeEmail(suggested)) {
    return {email: fallback, usedFallback: true, corrected: false};
  }

  const original = trimmed.toLowerCase();
  return {
    email: suggested,
    usedFallback: false,
    corrected: suggested !== original,
  };
}

/**
 * @param {string} message
 * @returns {boolean}
 */
function isPaystackInvalidEmailError(message) {
  return /invalid email/i.test(String(message || ""));
}

/**
 * Prefer a saved profile email over a stale app/Auth address after admin edits.
 * @param {Array<unknown>} candidates
 * @returns {{ email: string, usedFallback: boolean, corrected: boolean, source: string }}
 */
function pickPaystackCustomerEmail(candidates) {
  let correctedPick = null;
  const labels = ["profile", "token", "client"];
  const list = Array.isArray(candidates) ? candidates : [];

  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    if (raw == null || String(raw).trim() === "") continue;
    const resolved = resolvePaystackCustomerEmail(raw);
    if (resolved.usedFallback || !isValidCustomerEmail(resolved.email)) continue;
    const source = labels[i] || `candidate_${i}`;
    if (!resolved.corrected) {
      return {...resolved, source};
    }
    if (!correctedPick) {
      correctedPick = {...resolved, source};
    }
  }

  if (correctedPick) return correctedPick;
  return {...resolvePaystackCustomerEmail(null), source: "fallback"};
}

module.exports = {
  FALLBACK_PAYSTACK_EMAIL,
  resolvePaystackCustomerEmail,
  pickPaystackCustomerEmail,
  isPaystackInvalidEmailError,
};
