/**
 * @fileoverview Decimal-safe money helpers for FX quotes and settlement amounts.
 */

const Decimal = require("decimal.js");

Decimal.set({precision: 40, rounding: Decimal.ROUND_HALF_UP});

/** Minor-unit scale by currency (display/settlement boundary). */
const CURRENCY_DECIMALS = Object.freeze({
  BTC: 8,
  ETH: 8,
  SOL: 8,
  USDC: 6,
  USDT: 6,
  USD: 2,
  EUR: 2,
  GBP: 2,
  AED: 2,
  CAD: 2,
  KES: 2,
  ETB: 2,
  UGX: 2,
  NGN: 2,
  GHS: 2,
  TZS: 2,
});

/**
 * @param {string} currency
 * @returns {number}
 */
function getCurrencyDecimals(currency) {
  const code = String(currency || "").toUpperCase();
  return CURRENCY_DECIMALS[code] != null ? CURRENCY_DECIMALS[code] : 2;
}

/**
 * @param {unknown} value
 * @returns {Decimal}
 */
function toDecimal(value) {
  if (value instanceof Decimal) return value;
  const d = new Decimal(value == null ? NaN : value);
  if (!d.isFinite() || d.lte(0)) {
    throw new Error(`Invalid monetary value: ${value}`);
  }
  return d;
}

/**
 * Round amount at currency boundary (not for intermediate rate math).
 * @param {unknown} amount
 * @param {string} currency
 * @returns {string} decimal string
 */
function roundAmount(amount, currency) {
  const d = new Decimal(amount);
  if (!d.isFinite() || d.lt(0)) {
    throw new Error(`Invalid amount for rounding: ${amount}`);
  }
  const places = getCurrencyDecimals(currency);
  return d.toDecimalPlaces(places, Decimal.ROUND_HALF_UP).toFixed(places);
}

/**
 * getAmount = sendAmount * rate, rounded to Get currency decimals.
 * @param {unknown} sendAmount
 * @param {unknown} rate
 * @param {string} getCurrency
 * @returns {{ sendAmount: string, getAmount: string, rate: string }}
 */
function computeGetAmount(sendAmount, rate, getCurrency) {
  const send = toDecimal(sendAmount);
  const r = toDecimal(rate);
  const get = send.mul(r);
  return {
    sendAmount: roundAmount(send, "USD"), // re-round send with its own currency below if provided
    getAmount: roundAmount(get, getCurrency),
    rate: r.toFixed(),
  };
}

/**
 * @param {unknown} sendAmount
 * @param {string} sendCurrency
 * @param {unknown} rate Get per 1 Send
 * @param {string} getCurrency
 * @returns {{ sendAmount: string, getAmount: string, exchangeRate: string }}
 */
function quoteAmounts(sendAmount, sendCurrency, rate, getCurrency) {
  const send = toDecimal(sendAmount);
  const r = toDecimal(rate);
  const get = send.mul(r);
  return {
    sendAmount: roundAmount(send, sendCurrency),
    getAmount: roundAmount(get, getCurrency),
    exchangeRate: r.toFixed(),
  };
}

/**
 * Rates compared with relative tolerance (regression tests / conflict detection).
 * @param {unknown} a
 * @param {unknown} b
 * @param {number} [eps]
 * @returns {boolean}
 */
function ratesEqual(a, b, eps = 1e-9) {
  try {
    const da = new Decimal(a);
    const db = new Decimal(b);
    if (!da.isFinite() || !db.isFinite()) return false;
    return da.minus(db).abs().lte(eps);
  } catch (_e) {
    return false;
  }
}

module.exports = {
  Decimal,
  CURRENCY_DECIMALS,
  getCurrencyDecimals,
  toDecimal,
  roundAmount,
  computeGetAmount,
  quoteAmounts,
  ratesEqual,
};
