/**
 * @fileoverview Server-authoritative Exchange/swap fee configuration.
 *
 * Convention (matches historical createSwapOrder debit model):
 *   fee is charged in SEND currency
 *   totalDebit = sendAmount + feeAmount
 *   grossGetAmount = sendAmount × exchangeRate
 *   netGetAmount = grossGetAmount  (fee does NOT reduce Get)
 *
 * Fee rate is read from Firestore config/fees:
 *   swapFeeRate  — decimal (e.g. 0.005 for 0.5%)  [preferred]
 *   swapFee      — percent  (e.g. 0.5 for 0.5%)
 * Default: 0 (customer KES book already embeds spread/commission; do not
 * silently apply Binance serviceFee / arbitrageFee to swaps).
 */

const admin = require("../admin");
const config = require("../config");
const {Decimal, roundAmount, toDecimal} = require("../utils/money");

const firestore = admin.firestore();

/**
 * @returns {Promise<{ feeRate: number, source: string }>}
 */
async function getSwapFeeRate() {
  try {
    const snap = await firestore.collection(config.collections.config).doc("fees").get();
    if (snap.exists) {
      const data = snap.data() || {};
      if (data.swapFeeRate != null && Number.isFinite(Number(data.swapFeeRate))) {
        const r = Number(data.swapFeeRate);
        if (r < 0 || r > 1) {
          throw new Error("INVALID_FEE_CONFIG: swapFeeRate must be between 0 and 1");
        }
        return {feeRate: r, source: "config.fees.swapFeeRate"};
      }
      if (data.swapFee != null && Number.isFinite(Number(data.swapFee))) {
        const r = Number(data.swapFee) / 100;
        if (r < 0 || r > 1) {
          throw new Error("INVALID_FEE_CONFIG: swapFee percent must be between 0 and 100");
        }
        return {feeRate: r, source: "config.fees.swapFee"};
      }
    }
  } catch (err) {
    if (err.code === "INVALID_FEE_CONFIG" || String(err.message).includes("INVALID_FEE_CONFIG")) {
      throw err;
    }
    console.warn("swapFeeService: failed to load fees config:", err.message);
  }
  return {feeRate: 0, source: "default_zero"};
}

/**
 * Compute fee breakdown for a Send→Get swap.
 *
 * @param {Object} params
 * @param {string|number} params.sendAmount
 * @param {string} params.sendCurrency
 * @param {string} params.getCurrency
 * @param {string|number} params.exchangeRate Get per 1 Send
 * @param {number} [params.feeRate] optional override (server only; never from client)
 * @returns {Promise<{
 *   sendAmount: string,
 *   exchangeRate: string,
 *   grossGetAmount: string,
 *   netGetAmount: string,
 *   feeRate: number,
 *   feeAmount: string,
 *   feeCurrency: string,
 *   totalDebit: string,
 *   feeSource: string,
 *   feeConvention: string,
 * }>}
 */
async function computeSwapFeeBreakdown(params) {
  const sendCurrency = String(params.sendCurrency || "").toUpperCase();
  const getCurrency = String(params.getCurrency || "").toUpperCase();
  const sendDec = toDecimal(params.sendAmount);
  const rateDec = toDecimal(params.exchangeRate);

  let feeRate;
  let feeSource;
  if (params.feeRate != null && Number.isFinite(Number(params.feeRate))) {
    feeRate = Number(params.feeRate);
    feeSource = "server_override";
  } else {
    const loaded = await getSwapFeeRate();
    feeRate = loaded.feeRate;
    feeSource = loaded.source;
  }

  const feeAmountDec = sendDec.mul(feeRate);
  const totalDebitDec = sendDec.plus(feeAmountDec);
  const grossGetDec = sendDec.mul(rateDec);
  // Fee on SEND side — Get is not reduced
  const netGetDec = grossGetDec;

  return {
    sendAmount: roundAmount(sendDec, sendCurrency),
    exchangeRate: rateDec.toFixed(),
    grossGetAmount: roundAmount(grossGetDec, getCurrency),
    netGetAmount: roundAmount(netGetDec, getCurrency),
    feeRate,
    feeAmount: roundAmount(feeAmountDec, sendCurrency),
    feeCurrency: sendCurrency,
    totalDebit: roundAmount(totalDebitDec, sendCurrency),
    feeSource,
    feeConvention: "FEE_ON_SEND",
  };
}

module.exports = {
  getSwapFeeRate,
  computeSwapFeeBreakdown,
  Decimal,
};
