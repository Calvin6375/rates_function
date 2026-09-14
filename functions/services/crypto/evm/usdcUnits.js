/**
 * @fileoverview USDC amount helpers (6 decimals). Avoids float drift for on-chain units.
 */

const Decimal = require("decimal.js");

const USDC_DECIMALS = 6;
const USDC_FACTOR = new Decimal(10).pow(USDC_DECIMALS);

/**
 * @param {string|number} amount
 * @returns {boolean}
 */
function isValidUsdcAmount(amount) {
  try {
    const dec = new Decimal(amount);
    if (!dec.isFinite() || dec.lte(0)) return false;
    if (dec.decimalPlaces() > USDC_DECIMALS) return false;
    return true;
  } catch (_err) {
    return false;
  }
}

/**
 * @param {string|number} amount
 * @returns {bigint}
 */
function toUsdcUnits(amount) {
  if (!isValidUsdcAmount(amount)) {
    throw new Error("Invalid amount");
  }
  return BigInt(new Decimal(amount).mul(USDC_FACTOR).toFixed(0));
}

/**
 * @param {bigint|string|number} units
 * @returns {number}
 */
function fromUsdcUnits(units) {
  return Number(new Decimal(String(units)).div(USDC_FACTOR).toFixed(USDC_DECIMALS));
}

module.exports = {
  USDC_DECIMALS,
  isValidUsdcAmount,
  toUsdcUnits,
  fromUsdcUnits,
};
