/**
 * @fileoverview Safari Card payout fee calculation.
 *
 * Precedence for Pay (MPESA_B2B Till / PayBill):
 *   product pricing (enabled) → env flat fee → 0
 * Other payout types keep env flat fees only.
 */

const config = require("../../config");
const {PAYOUT_TYPES} = require("../../utils/safariCardPayoutTypes");
const productPricingService = require("../pricing/productPricingService");

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
    case PAYOUT_TYPES.SAFARITAP_WALLET:
      return Number(fees.wallet || 0);
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
 * @param {Object} [params.recipient]
 * @returns {Promise<{
 *   amount: number,
 *   fee: number,
 *   totalDebit: number,
 *   currency: string,
 *   feeSource: string,
 *   pricingProductKey: string|null,
 * }>}
 */
async function calculatePayoutFee(params) {
  const amount = Number(params.amount);
  const currency = String(params.currency || "KES").toUpperCase();
  const productKey = productPricingService.resolveSafariPayProductKey(
      params.payoutType,
      params.recipient,
  );

  if (productKey) {
    const priced = await productPricingService.computeProductFee({
      productKey,
      amount,
      currency,
    });
    if (priced.applied) {
      return {
        amount,
        fee: priced.feeAmount,
        totalDebit: amount + priced.feeAmount,
        currency,
        feeSource: priced.source,
        pricingProductKey: productKey,
      };
    }
  }

  const fee = Math.max(0, getConfiguredFlatFee(params.payoutType));
  return {
    amount,
    fee,
    totalDebit: amount + fee,
    currency,
    feeSource: "env_flat_fee",
    pricingProductKey: productKey,
  };
}

module.exports = {
  calculatePayoutFee,
  getConfiguredFlatFee,
};
