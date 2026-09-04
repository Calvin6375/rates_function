/**
 * @fileoverview C2B FX — convert client amounts to KES for Paystack checkout.
 * Wallet credit uses the original (requested) currency; Paystack is always charged in KES.
 */

const admin = require("../../admin");
const config = require("../../config");
const rateService = require("../rateService");
const { C2B_PAYSTACK_CURRENCY } = require("../../utils/fundingTypes");
const { normalizeKesBook, getKesPerUnit } = require("../../utils/customerRatesResolve");

/** Fallback peg only when customer book has no USD/USDT row (uses Binance USDT/KES). */
const USDT_PEGGED = new Set(["USD", "USDT"]);

const CUSTOMER_RATES_META_KEYS = new Set([
  "updatedAt",
  "updatedBy",
  "rateVersion",
  "baseCurrency",
  "rateMeaning",
  "countries",
  "currencies",
  "createdAt",
  "createdBy",
]);

/** Paystack Kenya hosted checkout rejects sub-shilling charges. */
const MIN_PAYSTACK_KES = 1;

/** Default C2B top-up cap (wallet credit, KES equivalent). */
const DEFAULT_C2B_MAX_TOPUP_KES = 50000;

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
 * KES charged per 1 unit when the customer is buying `currency` (Paystack in KES).
 * Prefer sellRate (platform sells the unit); fall back to buyRate if only one side is set.
 *
 * @param {{ buyRate?: number, sellRate?: number }|null} row
 * @returns {number|null}
 */
function kesChargeRateFromRow(row) {
  if (!row || typeof row !== "object") return null;
  const sellRate = Number(row.sellRate);
  const buyRate = Number(row.buyRate);
  if (Number.isFinite(sellRate) && sellRate > 0) return sellRate;
  if (Number.isFinite(buyRate) && buyRate > 0) return buyRate;
  return null;
}

/**
 * @param {FirebaseFirestore.DocumentData|null|undefined} data
 * @returns {Record<string, unknown>}
 */
function extractRatesMap(data) {
  if (!data || typeof data !== "object") return {};
  if (data.rates && typeof data.rates === "object" && !Array.isArray(data.rates)) {
    return data.rates;
  }
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    if (CUSTOMER_RATES_META_KEYS.has(key)) continue;
    if (value && typeof value === "object" && !Array.isArray(value) &&
        (value.buyRate != null || value.sellRate != null)) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * @returns {Promise<Object>}
 */
async function loadCustomerRates() {
  const snap = await admin.firestore()
      .collection(config.collections.config)
      .doc("customerRates")
      .get();
  if (!snap.exists) return {};
  return extractRatesMap(snap.data() || {});
}

/**
 * @param {Record<string, unknown>} customerRates
 * @param {string} currency
 * @returns {number|null}
 */
function kesPerUnitFromCustomerBook(customerRates, currency) {
  const {book} = normalizeKesBook(customerRates);
  const fromBook = getKesPerUnit(book, currency);
  const fromCanonical = kesChargeRateFromRow(fromBook);
  if (fromCanonical) return fromCanonical;

  const raw = customerRates[currency] || customerRates[currency.toLowerCase()];
  return kesChargeRateFromRow(raw);
}

/**
 * KES per 1 unit of `currency` from the customer KES book, then market fallback.
 * @param {string} currency
 * @returns {Promise<number>}
 */
async function resolveKesPerUnit(currency) {
  if (currency === C2B_PAYSTACK_CURRENCY) {
    return 1;
  }

  const customerRates = await loadCustomerRates();
  const fromBook = kesPerUnitFromCustomerBook(customerRates, currency);
  if (fromBook) {
    return fromBook;
  }

  const kesRates = await rateService.getRates("KES", "USDT");
  const kesPerUsdt = Number(kesRates.customerPrice || kesRates.marketPrice || 0);
  if (!kesPerUsdt || kesPerUsdt <= 0) {
    throw new Error("FX rate unavailable for → KES (USDT/KES)");
  }

  if (USDT_PEGGED.has(currency)) {
    return kesPerUsdt;
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

  throw new Error(
      `FX rate unavailable for ${currency} → KES. ` +
      `Add ${currency} to P2P customer rates (KES per 1 ${currency}) to enable this top-up.`,
  );
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
    const amountKes = roundMajorUnits(numericAmount);
    if (amountKes < MIN_PAYSTACK_KES) {
      throw new Error(`Amount must be at least ${MIN_PAYSTACK_KES} KES for Paystack checkout`);
    }
    return {
      requestedAmount: numericAmount,
      requestedCurrency,
      amountKes,
      paystackCurrency: C2B_PAYSTACK_CURRENCY,
      fxRate: 1,
    };
  }

  const fxRate = await resolveKesPerUnit(requestedCurrency);
  if (!fxRate || fxRate <= 0) {
    throw new Error(`FX rate unavailable for ${requestedCurrency} → KES`);
  }

  const amountKes = roundMajorUnits(numericAmount * fxRate);
  if (amountKes < MIN_PAYSTACK_KES) {
    throw new Error(
        `Converted amount ${amountKes} KES is below Paystack minimum ` +
        `(${MIN_PAYSTACK_KES} KES) for ${numericAmount} ${requestedCurrency}`,
    );
  }

  return {
    requestedAmount: numericAmount,
    requestedCurrency,
    amountKes,
    paystackCurrency: C2B_PAYSTACK_CURRENCY,
    fxRate,
  };
}

/**
 * @returns {number}
 */
function getC2bMaxTopupKes() {
  const n = Number(config.funding && config.funding.maxTopupKes);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_C2B_MAX_TOPUP_KES;
}

/**
 * Format an amount for customer-facing errors (grouped thousands).
 * @param {number} amount
 * @param {string} currency
 * @returns {string}
 */
function formatCustomerAmount(amount, currency) {
  const n = Number(amount);
  const code = String(currency || "KES").toUpperCase();
  const fraction = code === "KES" && Number.isInteger(n) ? 0 : 2;
  const formatted = n.toLocaleString("en-US", {
    minimumFractionDigits: fraction,
    maximumFractionDigits: fraction,
  });
  return `${formatted} ${code}`;
}

/**
 * Largest amount in `currency` that still converts to ≤ maxKes.
 * @param {number} maxKes
 * @param {number} fxRate KES per 1 unit
 * @returns {number}
 */
function maxAmountForCurrency(maxKes, fxRate) {
  const rate = Number(fxRate);
  if (!Number.isFinite(rate) || rate <= 0 || rate === 1) {
    return roundMajorUnits(maxKes);
  }
  return Math.floor((maxKes / rate) * 100) / 100;
}

/**
 * Reject C2B top-ups whose KES equivalent exceeds the cap.
 * Message names the limit in KES and in the currency the customer entered.
 *
 * @param {{
 *   amountKes: number,
 *   requestedAmount?: number,
 *   requestedCurrency?: string,
 *   fxRate?: number,
 * }} charge
 * @param {number} [maxKes]
 */
function assertC2bTopupWithinMaxKes(charge, maxKes = getC2bMaxTopupKes()) {
  const amountKes = Number(charge && charge.amountKes);
  if (!Number.isFinite(amountKes) || amountKes <= maxKes) {
    return;
  }

  const requestedCurrency = String(
      (charge && charge.requestedCurrency) || C2B_PAYSTACK_CURRENCY,
  ).toUpperCase();
  const fxRate = Number(charge && charge.fxRate) || 1;
  const maxKesLabel = formatCustomerAmount(maxKes, C2B_PAYSTACK_CURRENCY);

  let message;
  if (requestedCurrency === C2B_PAYSTACK_CURRENCY) {
    message =
      `The maximum top-up is ${maxKesLabel}. ` +
      `Enter ${maxKesLabel} or less.`;
  } else {
    const maxInCcy = maxAmountForCurrency(maxKes, fxRate);
    const maxCcyLabel = formatCustomerAmount(maxInCcy, requestedCurrency);
    message =
      `The maximum top-up is ${maxKesLabel} ` +
      `(${maxCcyLabel} at the current rate). ` +
      `Enter ${maxCcyLabel} or less.`;
  }

  const err = new Error(message);
  err.statusCode = 400;
  err.code = "TOPUP_LIMIT_EXCEEDED";
  err.maxTopupKes = maxKes;
  err.maxTopupCurrency = requestedCurrency;
  throw err;
}

module.exports = {
  USDT_PEGGED,
  MIN_PAYSTACK_KES,
  DEFAULT_C2B_MAX_TOPUP_KES,
  convertToKesForPaystack,
  resolveKesPerUnit,
  roundMajorUnits,
  extractRatesMap,
  kesChargeRateFromRow,
  getC2bMaxTopupKes,
  formatCustomerAmount,
  maxAmountForCurrency,
  assertC2bTopupWithinMaxKes,
};
