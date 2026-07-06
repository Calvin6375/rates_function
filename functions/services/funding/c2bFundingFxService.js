/**
 * @fileoverview C2B FX — convert client amounts to KES for Paystack checkout.
 */

const rateService = require("../rateService");
const { C2B_PAYSTACK_CURRENCY } = require("../../utils/fundingTypes");

const SUPPORTED_INPUT_CURRENCIES = Object.freeze(["USD", "KES"]);

/**
 * @param {number} amount
 * @returns {number}
 */
function roundMajorUnits(amount) {
  return Math.round(Number(amount) * 100) / 100;
}

/**
 * Convert a C2B top-up amount to KES for Paystack initialize.
 *
 * @param {number} amount Client amount in requested currency
 * @param {string} [currency] USD or KES
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

  if (!SUPPORTED_INPUT_CURRENCIES.includes(requestedCurrency)) {
    throw new Error(
        `C2B top-up supports ${SUPPORTED_INPUT_CURRENCIES.join(", ")} only`,
    );
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

  const rates = await rateService.getRates("KES", "USDT");
  const fxRate = Number(rates.customerPrice || rates.marketPrice || 0);
  if (!fxRate || fxRate <= 0) {
    throw new Error("FX rate unavailable for USD → KES");
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
  SUPPORTED_INPUT_CURRENCIES,
  convertToKesForPaystack,
};
