/**
 * @fileoverview Safari Card payout fee calculation.
 */

const config = require("../../config");
const { PAYOUT_TYPES } = require("../../utils/safariCardPayoutTypes");

/**
 * @param {SafariCardPayoutType} payoutType
 * @returns {number}
 */
function getConfiguredFlatFee(payoutType) {
  const fees = config.safariCardPayoutFees || {};
  switch (payoutType) {
    case PAYOUT_TYPES.MPESA_B2C:
      return Number(fees.mpesaB2c || 0);
    case PAYOUT_TYPES.MPESA_B2B:
      return Number(fees.mpesaB2b || 0);
    case PAYOUT_TYPES.BANK:
      return Number(fees.bank || 0);
    default:
      return 0;
  }
}

/**
 * @param {Object} params
 * @param {string} params.userId
 * @param {SafariCardPayoutType} params.payoutType
 * @param {number} params.amount
 * @param {string} params.currency
 * @returns {{ amount: number, fee: number, totalDebit: number, currency: string }}
 */
function calculatePayoutFee(params) {
  const amount = Number(params.amount);
  const currency = String(params.currency || "KES").toUpperCase();
  const fee = Math.max(0, getConfiguredFlatFee(params.payoutType));
  const totalDebit = amount + fee;

  return {
    amount,
    fee,
    totalDebit,
    currency,
  };
}

module.exports = {
  calculatePayoutFee,
  getConfiguredFlatFee,
};
