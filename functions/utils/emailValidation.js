/**
 * @fileoverview Shared customer email validation (C2B signup + Paystack).
 * Rejects typo domains Paystack refuses (e.g. gmail.coma).
 */

const DOMAIN_TYPOS = Object.freeze({
  "gmail.coma": "gmail.com",
  "gmail.con": "gmail.com",
  "gmail.cm": "gmail.com",
  "gmail.coom": "gmail.com",
  "gmail.comm": "gmail.com",
  "gmail.cmo": "gmail.com",
  "gmal.com": "gmail.com",
  "gmial.com": "gmail.com",
  "googlemail.coma": "gmail.com",
  "yahoo.coma": "yahoo.com",
  "hotmail.coma": "hotmail.com",
  "outlook.coma": "outlook.com",
});

const BAD_TLDS = new Set(["coma", "con", "cmo", "comm", "comn", "cpm"]);

/**
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeEmailInput(raw) {
  return String(raw || "").trim().toLowerCase();
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,24}$/.test(value);
}

/**
 * @param {string} domain
 * @returns {string}
 */
function correctDomainTypos(domain) {
  const d = String(domain || "").toLowerCase();
  if (DOMAIN_TYPOS[d]) return DOMAIN_TYPOS[d];
  if (d.endsWith(".coma")) return `${d.slice(0, -5)}.com`;
  return d;
}

/**
 * @param {unknown} raw
 * @returns {string|null} corrected address, or null if shape is unusable
 */
function suggestEmailCorrection(raw) {
  const trimmed = normalizeEmailInput(raw);
  const at = trimmed.lastIndexOf("@");
  if (at < 1 || at === trimmed.length - 1) return null;
  const local = trimmed.slice(0, at);
  const domain = correctDomainTypos(trimmed.slice(at + 1));
  const email = `${local}@${domain}`;
  return looksLikeEmail(email) ? email : null;
}

/**
 * Signup / profile emails must be deliverable-looking, not just regex-shaped.
 * @param {unknown} raw
 * @returns {boolean}
 */
function isValidCustomerEmail(raw) {
  const email = normalizeEmailInput(raw);
  if (email.length < 5 || email.length > 254) return false;
  if (!looksLikeEmail(email)) return false;
  if (email.includes("..")) return false;

  const at = email.lastIndexOf("@");
  const domain = email.slice(at + 1);
  if (DOMAIN_TYPOS[domain]) return false;
  if (domain.endsWith(".coma")) return false;

  const tld = domain.split(".").pop();
  if (BAD_TLDS.has(tld)) return false;
  return true;
}

/**
 * @param {unknown} raw
 * @returns {{ ok: boolean, email?: string, error?: string }}
 */
function validateCustomerEmail(raw) {
  const trimmed = String(raw == null ? "" : raw).trim();
  if (!trimmed) {
    return {ok: false, error: "A valid email is required"};
  }
  if (isValidCustomerEmail(trimmed)) {
    return {ok: true, email: normalizeEmailInput(trimmed)};
  }
  const suggestion = suggestEmailCorrection(trimmed);
  if (suggestion && suggestion !== normalizeEmailInput(trimmed)) {
    return {
      ok: false,
      error: `Invalid email address. Did you mean ${suggestion}?`,
    };
  }
  return {ok: false, error: "A valid email is required"};
}

module.exports = {
  DOMAIN_TYPOS,
  BAD_TLDS,
  normalizeEmailInput,
  looksLikeEmail,
  correctDomainTypos,
  suggestEmailCorrection,
  isValidCustomerEmail,
  validateCustomerEmail,
};
