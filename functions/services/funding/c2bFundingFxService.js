/**
 * @fileoverview C2B FX — convert client amounts to KES for Paystack checkout.
 * Wallet credit uses the original (requested) currency; Paystack is always charged in KES.
 */

const admin = require("../../admin");
const config = require("../../config");
const rateService = require("../rateService");
const { C2B_PAYSTACK_CURRENCY } = require("../../utils/fundingTypes");

/** Currencies treated as 1:1 with USDT for KES conversion. */
const USDT_PEGGED = new Set(["USD", "USDT"]);

/**
 * @param {number} amount
 * @returns {number}
 */
function roundMajorUnits(amount) {
  return Math.round(Number(amount) * 100) / 100;
}

/**
 * @param {string} currency
 * @returns {boolean}
 */
function isIsoCurrency(currency) {
  return /^[A-Z]{3}$/.test(currency);
}

/**
 * @returns {Promise<Object>}
 */
async function loadCustomerRates() {
  try {
    const snap = await admin.firestore()
        .collection(config.collections.config)
        .doc("customerRates")
        .get();
    if (!snap.exists) return {};
    const data = snap.data() || {};
    return data.rates && typeof data.rates === "object" ? data.rates : {};
  } catch (err) {
    console.warn("c2bFundingFx: customerRates lookup failed:", err.message);
    return {};
  }
}

/**
 * Prefer buyRate (customer pays) then sellRate for KES-per-unit pairs.
 * @param {Object} rates
 * @param {string} pair
 * @returns {number|null}
 */
function readPairRate(rates, pair) {
  const row = rates[pair];
  if (!row || typeof row !== "object") return null;
  const buy = Number(row.buyRate);
  const sell = Number(row.sellRate);
  if (Number.isFinite(buy) && buy > 0) return buy;
  if (Number.isFinite(sell) && sell > 0) return sell;
  return null;
}

/**
 * KES per 1 unit of `currency`.
 * @param {string} currency
 * @returns {Promise<number>}
 */
async function resolveKesPerUnit(currency) {
  if (currency === C2B_PAYSTACK_CURRENCY) {
    return 1;
  }

  const kesRates = await rateService.getRates("KES", "USDT");
  const kesPerUsdt = Number(kesRates.customerPrice || kesRates.marketPrice || 0);
  if (!kesPerUsdt || kesPerUsdt <= 0) {
    throw new Error("FX rate unavailable for → KES (USDT/KES)");
  }

  if (USDT_PEGGED.has(currency)) {
    return kesPerUsdt;
  }

  const customerRates = await loadCustomerRates();

  const direct = readPairRate(customerRates, `${currency}/KES`);
  if (direct) {
    return direct;
  }

  const inverse = readPairRate(customerRates, `KES/${currency}`);
  if (inverse) {
    return 1 / inverse;
  }

  const usdtViaConfig = readPairRate(customerRates, `USDT/${currency}`);
  if (usdtViaConfig) {
    // USDT/{currency} ≈ currency units per 1 USDT
    return kesPerUsdt / usdtViaConfig;
  }

  try {
    const srcRates = await rateService.getRates(currency, "USDT");
    const currencyPerUsdt = Number(srcRates.customerPrice || srcRates.marketPrice || 0);
    if (currencyPerUsdt > 0) {
      return kesPerUsdt / currencyPerUsdt;
    }
  } catch (err) {
    console.warn(`c2bFundingFx: Binance rate for ${currency} failed:`, err.message);
  }

  throw new Error(`FX rate unavailable for ${currency} → KES`);
}

/**
 * Convert a C2B top-up amount to KES for Paystack initialize.
 * Preserves requestedAmount/requestedCurrency for wallet credit after payment.
 *
 * @param {number} amount Client amount in requested currency
 * @param {string} [currency] Any ISO-4217 fiat (default USD)
 * @returns {Promise<{
 *   requestedAmount: number,
 *   requestedCurrency: string,
 *   amountKes: number,
 *   paystackCurrency: string,
 *   fxRate: number,
 * }>}
 */
async function convertToKesForPaystack(amount, currency = "USD") {
  const numericAmount = Number(amount);
  const requestedCurrency = String(currency || "USD").toUpperCase();

  if (!numericAmount || numericAmount <= 0) {
    throw new Error("Amount must be a positive number");
  }

  if (!isIsoCurrency(requestedCurrency)) {
    throw new Error(`Invalid currency code: ${requestedCurrency}`);
  }

  if (requestedCurrency === C2B_PAYSTACK_CURRENCY) {
    return {
      requestedAmount: numericAmount,
      requestedCurrency,
      amountKes: roundMajorUnits(numericAmount),
      paystackCurrency: C2B_PAYSTACK_CURRENCY,
      fxRate: 1,
    };
  }

  const fxRate = await resolveKesPerUnit(requestedCurrency);
  if (!fxRate || fxRate <= 0) {
    throw new Error(`FX rate unavailable for ${requestedCurrency} → KES`);
  }

  return {
    requestedAmount: numericAmount,
    requestedCurrency,
    amountKes: roundMajorUnits(numericAmount * fxRate),
    paystackCurrency: C2B_PAYSTACK_CURRENCY,
    fxRate,
  };
}

module.exports = {
  USDT_PEGGED,
  convertToKesForPaystack,
  resolveKesPerUnit,
  roundMajorUnits,
};
