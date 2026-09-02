/**
 * @fileoverview Safari Card payout fee calculation.
 *
 * Precedence:
 *   product pricing (enabled) → env flat fee → 0
 *
 * Product keys:
 *   MPESA_B2B Till → buy_goods
 *   MPESA_B2B PayBill → pay_bill
 *   MPESA_B2C / BANK / SAFARITAP_WALLET → send_ke
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
 *   feePercent: number,
 *   flatFeeKes: number,
 *   pricingApplied: boolean,
 * }>}
 */
async function calculatePayoutFee(params) {
  const amount = Number(params.amount);
  const currency = String(params.currency || "KES").toUpperCase();
  const productKey = productPricingService.resolveSafariPayoutProductKey(
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
        feePercent: Number(priced.feePercent) || 0,
        flatFeeKes: Number(priced.flatFee) || 0,
        pricingApplied: true,
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
    feePercent: 0,
    flatFeeKes: fee,
    pricingApplied: false,
  };
}

/**
 * Quote fee breakdown for C2B Send Money or Pay Review screens (no payout created).
 *
 * Pay (Till / PayBill): type=MPESA_B2B + recipient.accountType
 * Send Money: type=MPESA_B2C | SAFARITAP_WALLET | BANK
 *
 * @param {Object} params
 * @param {string} params.payoutType - e.g. MPESA_B2C, MPESA_B2B
 * @param {number} params.amount
 * @param {string} [params.currency="KES"]
 * @param {Object} [params.recipient]
 * @param {string} [params.accountType] - TillNumber | PayBill (Pay flow; merged into recipient)
 * @returns {Promise<Object>}
 */
async function quotePayoutBreakdown(params) {
  const payoutType = String(params.payoutType || "").trim();
  const amount = Number(params.amount);
  const currency = String(params.currency || "KES").toUpperCase();
  const recipient = {
    ...(params.recipient && typeof params.recipient === "object" ? params.recipient : {}),
  };
  if (params.accountType && !recipient.accountType) {
    recipient.accountType = String(params.accountType);
  }

  if (!payoutType) {
    const err = new Error("type (payoutType) is required");
    err.statusCode = 400;
    throw err;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    const err = new Error("amount must be a positive number");
    err.statusCode = 400;
    throw err;
  }

  const feeBreakdown = await calculatePayoutFee({
    userId: params.userId || null,
    payoutType,
    amount,
    currency,
    recipient,
  });

  const faceAmount = feeBreakdown.amount;
  const platformFee = feeBreakdown.fee;
  const paymentMethodFees = 0;
  const youWillPay = feeBreakdown.totalDebit;
  const isPay = payoutType === PAYOUT_TYPES.MPESA_B2B;
  const accountType = recipient.accountType ?
    String(recipient.accountType) :
    null;

  const formatLine = (value, cur) => {
    const n = Number(value) || 0;
    if (n <= 0) return "Free";
    return `${n.toFixed(2)} ${cur}`;
  };

  const faceLabel = isPay ? "You pay" : "You send";
  const faceKey = isPay ? "you_pay" : "you_send";

  return {
    type: payoutType,
    method: isPay ? "pay" : "send_money",
    accountType,
    /** Face amount to merchant / recipient */
    youPay: faceAmount,
    youSend: faceAmount,
    amount: faceAmount,
    recipientGets: faceAmount,
    currency,
    /** Platform fee (buy_goods / pay_bill / send_ke when live) */
    artoFees: platformFee,
    processingFees: platformFee,
    paymentMethodFees,
    youWillPay,
    totalDebit: youWillPay,
    feeAmount: platformFee,
    feePercent: feeBreakdown.feePercent,
    flatFeeKes: feeBreakdown.flatFeeKes,
    pricingApplied: feeBreakdown.pricingApplied,
    pricingProductKey: feeBreakdown.pricingProductKey,
    feeSource: feeBreakdown.feeSource,
    lines: [
      {
        key: faceKey,
        label: faceLabel,
        amount: faceAmount,
        currency,
        display: formatLine(faceAmount, currency),
      },
      {
        key: "arto_fees",
        label: "Arto+ fees",
        amount: platformFee,
        currency,
        display: formatLine(platformFee, currency),
      },
      {
        key: "payment_method_fees",
        label: "Payment method fees",
        amount: paymentMethodFees,
        currency,
        display: formatLine(paymentMethodFees, currency),
      },
      {
        key: "you_will_pay",
        label: "You will pay",
        amount: youWillPay,
        currency,
        display: formatLine(youWillPay, currency),
      },
    ],
  };
}

module.exports = {
  calculatePayoutFee,
  getConfiguredFlatFee,
  quotePayoutBreakdown,
};
