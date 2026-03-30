/**
 * @fileoverview When config/customerRates has impossible USDT↔fiat values (e.g. USDT/KES ≈ 1),
 * backfill from Binance P2P so public /rates and /customer-rates stay usable.
 */

const config = require("../config");
const ratesLib = require("../libs/rates");

/**
 * Minimum plausible "fiat per 1 USDT" for supported African fiats.
 * Config values below this are treated as mis-entered or unit-swapped.
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
 * Mutates rates map: fixes USDT/KES (and other supported fiats) when stored rates are implausible.
 *
 * @param {Record<string, { buyRate?: number, sellRate?: number }>} ratesObj
 * @returns {Promise<void>}
 */
async function sanitizeRatesObject(ratesObj) {
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
        before: { buyRate: r.buyRate, sellRate: r.sellRate },
        after: fixed,
      });
    } catch (e) {
      console.error(`customerRatesSanitize: could not fix ${pair}:`, e.message);
    }
  }
}

/**
 * @param {string} currencyPair e.g. USDT/KES
 * @param {{ buyRate: number, sellRate: number }} pairRates
 * @returns {Promise<{ buyRate: number, sellRate: number }>}
 */
async function maybeFixResolvedPair(currencyPair, pairRates) {
  if (!currencyPair || !currencyPair.includes("/") || !pairRates) return pairRates;
  const [base, quote] = currencyPair.split("/");
  if (base !== config.binance.defaultAsset) return pairRates;
  if (typeof pairRates.buyRate !== "number" || typeof pairRates.sellRate !== "number") return pairRates;
  if (!isImplausibleUsdtAgainstFiat(quote, pairRates.buyRate, pairRates.sellRate)) return pairRates;
  try {
    return await fillUsdtFiatFromBinance(quote);
  } catch (e) {
    console.error("maybeFixResolvedPair:", e.message);
    return pairRates;
  }
}

module.exports = {
  sanitizeRatesObject,
  maybeFixResolvedPair,
  isImplausibleUsdtAgainstFiat,
  MIN_PLAUSIBLE_USDT_FIAT,
};
