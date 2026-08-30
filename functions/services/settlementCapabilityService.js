/**
 * @fileoverview Settlement capability map — separate from rate quoting.
 *
 * Rate engine answers "what rate can I quote?"
 * This service answers "can createSwapOrder settle this pair today?"
 */

/** Currencies the legacy swap balance books can debit/credit. */
const SWAP_LEDGER_CURRENCIES = Object.freeze(["USDT", "USD", "KES"]);

/**
 * @param {string} currency
 * @returns {{
 *   currency: string,
 *   quotable: boolean,
 *   sendable: boolean,
 *   receivable: boolean,
 * }}
 */
function getCurrencyCapabilities(currency) {
  const code = String(currency || "").toUpperCase().trim();
  const onSwapLedger = SWAP_LEDGER_CURRENCIES.includes(code);
  return {
    currency: code,
    quotable: /^[A-Z]{2,10}$/.test(code),
    sendable: onSwapLedger,
    receivable: onSwapLedger,
  };
}

/**
 * @param {string} sendCurrency
 * @param {string} getCurrency
 * @returns {{
 *   quotable: boolean,
 *   settleable: boolean,
 *   send: ReturnType<typeof getCurrencyCapabilities>,
 *   get: ReturnType<typeof getCurrencyCapabilities>,
 * }}
 */
function getPairCapabilities(sendCurrency, getCurrency) {
  const send = getCurrencyCapabilities(sendCurrency);
  const get = getCurrencyCapabilities(getCurrency);
  return {
    quotable: send.quotable && get.quotable && send.currency !== get.currency,
    settleable: send.sendable && get.receivable && send.currency !== get.currency,
    send,
    get,
  };
}

/**
 * @param {string} sendCurrency
 * @param {string} getCurrency
 * @throws {Error} PAIR_NOT_SETTLEABLE
 */
function assertSettleablePair(sendCurrency, getCurrency) {
  const caps = getPairCapabilities(sendCurrency, getCurrency);
  if (!caps.settleable) {
    const err = new Error(
        `PAIR_NOT_SETTLEABLE: ${String(sendCurrency).toUpperCase()}→` +
        `${String(getCurrency).toUpperCase()} is quotable but not settleable via createSwapOrder`,
    );
    err.code = "PAIR_NOT_SETTLEABLE";
    throw err;
  }
  return caps;
}

module.exports = {
  SWAP_LEDGER_CURRENCIES,
  getCurrencyCapabilities,
  getPairCapabilities,
  assertSettleablePair,
};
