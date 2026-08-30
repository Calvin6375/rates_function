/**
 * @fileoverview Market-leg helpers for true USDT↔fiat Binance pairs.
 *
 * Customer P2P rates are a **KES-per-unit** book (see customerRatesResolve.js).
 * Do NOT call sanitizeRatesObject on that book — values like USDT/ETB = 1.44
 * mean KES per ETB, not ETB per USDT, and must not be overwritten by Binance.
 *
 * These helpers remain for optional market-data repair only when the caller
 * knows the map is literally "fiat units per 1 USDT".
 */

const config = require("../config");
const ratesLib = require("../libs/rates");

/**
 * Minimum plausible "fiat per 1 USDT" for supported African fiats.
 */
const MIN_PLAUSIBLE_USDT_FIAT = {
  KES: 50,
  NGN: 200,
  GHS: 8,
};

/**
 * @param {string} fiat
 * @param {number} buyRate
 * @param {number} sellRate
 * @returns {boolean}
 */
function isImplausibleUsdtAgainstFiat(fiat, buyRate, sellRate) {
  const min = MIN_PLAUSIBLE_USDT_FIAT[fiat];
  if (min == null) return false;
  if (typeof buyRate !== "number" || typeof sellRate !== "number") return true;
  return Math.max(buyRate, sellRate) < min;
}

/**
 * @param {string} fiat
 * @returns {Promise<{ buyRate: number, sellRate: number }>}
 */
async function fillUsdtFiatFromBinance(fiat) {
  const asset = config.binance.defaultAsset;
  const binance = await ratesLib.getBinanceRatesLogic(fiat, asset);
  const mid = Number(binance.customerPrice);
  if (!Number.isFinite(mid) || mid <= 0) {
    throw new Error(`Invalid Binance customerPrice for ${asset}/${fiat}`);
  }
  const halfSpread = 0.002;
  return {
    buyRate: mid * (1 + halfSpread),
    sellRate: mid * (1 - halfSpread),
  };
}

/**
 * No-op for the KES customer book. Kept so existing imports do not break.
 * Pass `{ forceMarketUsdtFiat: true }` only for maps that are literally fiat-per-USDT.
 *
 * @param {Record<string, { buyRate?: number, sellRate?: number }>} ratesObj
 * @param {{ forceMarketUsdtFiat?: boolean }} [options]
 * @returns {Promise<void>}
 */
async function sanitizeRatesObject(ratesObj, options = {}) {
  if (!options.forceMarketUsdtFiat) {
    return;
  }
  const asset = config.binance.defaultAsset;
  const fiats = config.binance.supportedFiats || [];
  for (const fiat of fiats) {
    const pair = `${asset}/${fiat}`;
    const r = ratesObj[pair];
    if (!r || typeof r.buyRate !== "number" || typeof r.sellRate !== "number") continue;
    if (!isImplausibleUsdtAgainstFiat(fiat, r.buyRate, r.sellRate)) continue;
    try {
      const fixed = await fillUsdtFiatFromBinance(fiat);
      ratesObj[pair] = fixed;
      const inv = `${fiat}/${asset}`;
      ratesObj[inv] = {
        buyRate: 1 / fixed.sellRate,
        sellRate: 1 / fixed.buyRate,
      };
      console.warn(`customerRatesSanitize: replaced implausible ${pair} using Binance`, {
        before: {buyRate: r.buyRate, sellRate: r.sellRate},
        after: fixed,
      });
    } catch (e) {
      console.error(`customerRatesSanitize: could not fix ${pair}:`, e.message);
    }
  }
}

/**
 * Disabled for KES-book pairs. Never rewrite admin customer quotes.
 * @param {string} currencyPair
 * @param {{ buyRate: number, sellRate: number }} pairRates
 * @returns {Promise<{ buyRate: number, sellRate: number }>}
 */
async function maybeFixResolvedPair(currencyPair, pairRates) {
  return pairRates;
}

module.exports = {
  sanitizeRatesObject,
  maybeFixResolvedPair,
  isImplausibleUsdtAgainstFiat,
  MIN_PLAUSIBLE_USDT_FIAT,
};
