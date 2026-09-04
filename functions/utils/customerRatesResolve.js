/**
 * @fileoverview Customer FX: KES-denominated price book + Send→Get quotes.
 *
 * RATE ENGINE INVARIANT:
 * Every canonical book rate represents the KES value of exactly one unit of the
 * currency. Public Send→Get rates are derived as Get-units per one Send-unit.
 * No canonical rate may be interpreted as units-per-USDT.
 *
 * buyRate / sellRate on a currency row = platformBuyRate / platformSellRate in KES
 * per 1 unit (API keeps buyRate/sellRate names for compatibility).
 *
 * Customer sells SEND, receives GET → Exchange `rate` = sellRate of SEND/GET
 * where sellRate = KES_send.sell / KES_get.buy.
 *
 * Legacy keys (USDT/ETB, ETB/KES) are read-only compatibility → normalized to ETB.
 * New writes store canonical currency keys only (+ optional explicit SEND/GET overrides).
 */

const {ratesEqual} = require("./money");

/** Numeraire for the customer price book. */
const BASE_CURRENCY = "KES";
const RATE_MEANING = "KES_PER_UNIT";

/**
 * Only USDT/{QUOTE} was the admin “pair” legacy shape for KES-per-unit rows.
 * Do NOT treat USD/… or USDC/… as legacy hubs — those are explicit Get-per-Send overrides.
 */
const LEGACY_HUB_PREFIXES = Object.freeze(["USDT"]);

/**
 * @param {unknown} row
 * @returns {{ buyRate: number, sellRate: number }|null}
 */
function asValidPairRates(row) {
  if (!row || typeof row !== "object") return null;
  const buyRate = Number(row.buyRate);
  const sellRate = Number(row.sellRate);
  if (!Number.isFinite(buyRate) || !Number.isFinite(sellRate) || buyRate <= 0 || sellRate <= 0) {
    return null;
  }
  return {buyRate, sellRate};
}

/**
 * @param {{ buyRate: number, sellRate: number }} rates
 * @returns {{ buyRate: number, sellRate: number }}
 */
function invertPairRates(rates) {
  return {
    buyRate: 1 / rates.sellRate,
    sellRate: 1 / rates.buyRate,
  };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeCurrencyCode(value) {
  return String(value || "").toUpperCase().trim();
}

/**
 * @param {string} code
 * @returns {boolean}
 */
function isCurrencyCode(code) {
  return /^[A-Z]{2,10}$/.test(code);
}

/**
 * Warn when admin spreads look inconsistent across the book (do not auto-fix).
 * @param {string} code
 * @param {{ buyRate: number, sellRate: number }} row
 */
function warnSuspiciousSpread(code, row) {
  if (row.buyRate === row.sellRate) return;
  // Informational only — platform buy/sell may be buy>sell or buy<sell by convention
  if (row.buyRate > 0 && row.sellRate > 0) {
    const ratio = Math.max(row.buyRate, row.sellRate) / Math.min(row.buyRate, row.sellRate);
    if (ratio > 1.25) {
      console.warn("customerRates: wide spread", {currency: code, ...row, ratio});
    }
  }
}

/**
 * Normalize raw Firestore `rates` into KES book + explicit pair overrides.
 *
 * Precedence for a currency's KES row:
 * 1. canonical currency key ("ETB")
 * 2. CURRENCY/KES or KES/CURRENCY
 * 3. legacy USDT/ETB (etc.)
 *
 * If canonical and a lower-precedence source differ → keep canonical, record conflict.
 *
 * Explicit SEND/GET overrides (e.g. ETB/USDC) are Get-per-Send, never KES-per-unit.
 *
 * @param {Record<string, unknown>} rates
 * @returns {{
 *   book: Record<string, { buyRate: number, sellRate: number }>,
 *   exactPairs: Record<string, { buyRate: number, sellRate: number }>,
 *   conflicts: Array<{ currency: string, canonical: Object, other: Object, source: string }>,
 *   baseCurrency: string,
 *   rateMeaning: string,
 * }}
 */
function normalizeKesBook(rates) {
  const ratesMap = rates && typeof rates === "object" ? rates : {};
  const canonical = {};
  const viaKesPair = {};
  const viaLegacy = {};
  const exactPairs = {};
  const conflicts = [];

  for (const [rawKey, rawRow] of Object.entries(ratesMap)) {
    const row = asValidPairRates(rawRow);
    if (!row) continue;
    const key = String(rawKey || "").toUpperCase().trim();
    if (!key) continue;

    if (!key.includes("/")) {
      if (isCurrencyCode(key)) {
        canonical[key] = row;
        warnSuspiciousSpread(key, row);
      }
      continue;
    }

    const [left, right] = key.split("/");
    if (!isCurrencyCode(left) || !isCurrencyCode(right)) continue;

    if (right === BASE_CURRENCY) {
      viaKesPair[left] = row;
      continue;
    }
    if (left === BASE_CURRENCY) {
      viaKesPair[right] = invertPairRates(row);
      continue;
    }
    if (LEGACY_HUB_PREFIXES.includes(left) && right !== left) {
      viaLegacy[right] = {row, sourceKey: key};
      continue;
    }

    // Explicit Get-per-Send override (not a KES book row)
    exactPairs[`${left}/${right}`] = row;
  }

  const book = {};

  function assign(code, row, source) {
    if (!book[code]) {
      book[code] = row;
      return;
    }
    if (!ratesEqual(book[code].buyRate, row.buyRate) ||
        !ratesEqual(book[code].sellRate, row.sellRate)) {
      conflicts.push({
        currency: code,
        canonical: book[code],
        other: row,
        source,
      });
      console.warn("customerRates: conflicting representations; keeping higher-precedence value", {
        currency: code,
        kept: book[code],
        ignored: row,
        ignoredSource: source,
      });
    }
  }

  // Precedence 1: canonical
  for (const [code, row] of Object.entries(canonical)) {
    assign(code, row, "canonical");
  }
  // Precedence 2: C/KES
  for (const [code, row] of Object.entries(viaKesPair)) {
    if (canonical[code]) {
      assign(code, row, "CURRENCY/KES");
    } else {
      assign(code, row, "CURRENCY/KES");
    }
  }
  // Precedence 3: legacy USDT/C
  for (const [code, meta] of Object.entries(viaLegacy)) {
    if (book[code]) {
      assign(code, meta.row, meta.sourceKey);
    } else {
      assign(code, meta.row, meta.sourceKey);
    }
  }

  if (!book[BASE_CURRENCY]) {
    book[BASE_CURRENCY] = {buyRate: 1, sellRate: 1};
  }

  return {
    book,
    exactPairs,
    conflicts,
    baseCurrency: BASE_CURRENCY,
    rateMeaning: RATE_MEANING,
  };
}

/**
 * @param {Record<string, { buyRate: number, sellRate: number }>} book
 * @param {string} currency
 * @returns {{ buyRate: number, sellRate: number }|null}
 */
function getKesPerUnit(book, currency) {
  const code = normalizeCurrencyCode(currency);
  if (!code) return null;
  if (code === BASE_CURRENCY) {
    return {buyRate: 1, sellRate: 1};
  }
  return asValidPairRates(book[code]);
}

/**
 * Cross Send→Get from KES book (Get units per 1 Send).
 * buyRate  = KES_send.buy  / KES_get.sell
 * sellRate = KES_send.sell / KES_get.buy
 *
 * @param {{ buyRate: number, sellRate: number }} kesSend
 * @param {{ buyRate: number, sellRate: number }} kesGet
 * @returns {{ buyRate: number, sellRate: number }}
 */
function crossFromKes(kesSend, kesGet) {
  return {
    buyRate: kesSend.buyRate / kesGet.sellRate,
    sellRate: kesSend.sellRate / kesGet.buyRate,
  };
}

/**
 * Resolve Get-per-Send for a pair. Does NOT decide settleable (see settlementCapabilityService).
 *
 * @param {Record<string, unknown>} rates
 * @param {string} currencyPair
 * @returns {{
 *   buyRate: number,
 *   sellRate: number,
 *   resolvedPair: string,
 *   source: string,
 *   numeraire: string,
 *   rateUnit: string,
 *   quotable: boolean,
 * }|null}
 */
function resolveCustomerPair(rates, currencyPair) {
  if (!currencyPair || typeof currencyPair !== "string" || !currencyPair.includes("/")) {
    return null;
  }
  const [rawSend, rawGet] = currencyPair.split("/");
  const send = normalizeCurrencyCode(rawSend);
  const get = normalizeCurrencyCode(rawGet);
  if (!send || !get || !isCurrencyCode(send) || !isCurrencyCode(get)) return null;

  const resolvedPair = `${send}/${get}`;
  const meta = {
    numeraire: BASE_CURRENCY,
    rateUnit: `${get}_PER_${send}`,
    quotable: true,
  };

  if (send === get) {
    return {
      buyRate: 1,
      sellRate: 1,
      resolvedPair,
      source: "identity",
      ...meta,
    };
  }

  const {book, exactPairs} = normalizeKesBook(rates);

  const exact = asValidPairRates(exactPairs[resolvedPair]);
  if (exact) {
    return {...exact, resolvedPair, source: "admin_exact", ...meta};
  }

  const inverseExact = asValidPairRates(exactPairs[`${get}/${send}`]);
  if (inverseExact) {
    return {
      ...invertPairRates(inverseExact),
      resolvedPair,
      source: "admin_inverse",
      ...meta,
    };
  }

  const kesSend = getKesPerUnit(book, send);
  const kesGet = getKesPerUnit(book, get);
  if (!kesSend || !kesGet) {
    return null;
  }

  const crossed = crossFromKes(kesSend, kesGet);
  if (
    !Number.isFinite(crossed.buyRate) ||
    !Number.isFinite(crossed.sellRate) ||
    crossed.buyRate <= 0 ||
    crossed.sellRate <= 0
  ) {
    return null;
  }

  return {
    ...crossed,
    resolvedPair,
    source: "admin_cross",
    ...meta,
  };
}

/**
 * @param {Record<string, unknown>} rates
 * @returns {string[]}
 */
function listCurrenciesFromRates(rates) {
  const {book} = normalizeKesBook(rates);
  return Object.keys(book).sort();
}

/**
 * Expand pair map for GET /rates (derived views; not persisted).
 * Includes CURRENCY/KES legs and crosses — not dual-written to Firestore.
 *
 * @param {Record<string, unknown>} rates
 * @returns {Record<string, { buyRate: number, sellRate: number }>}
 */
function expandRatesWithCrosses(rates) {
  const {book, exactPairs} = normalizeKesBook(rates);
  const out = {};

  for (const [code, row] of Object.entries(book)) {
    out[`${code}/${BASE_CURRENCY}`] = {...row};
    if (code !== BASE_CURRENCY) {
      out[`${BASE_CURRENCY}/${code}`] = invertPairRates(row);
    }
  }

  for (const [pair, row] of Object.entries(exactPairs)) {
    out[pair] = {...row};
  }

  const codes = Object.keys(book);
  for (let i = 0; i < codes.length; i++) {
    for (let j = 0; j < codes.length; j++) {
      if (i === j) continue;
      const pair = `${codes[i]}/${codes[j]}`;
      if (out[pair]) continue;
      const resolved = resolveCustomerPair(rates, pair);
      if (!resolved) continue;
      out[pair] = {buyRate: resolved.buyRate, sellRate: resolved.sellRate};
    }
  }

  return out;
}

/**
 * Admin write normalization: canonical currency keys + explicit overrides only.
 * Does NOT write USDT/C or C/KES mirrors.
 *
 * Drop canonical keys and any pair that includes a removed currency (USDT/UGX, UGX/KES, ETB/UGX).
 *
 * @param {Record<string, unknown>} rates
 * @param {unknown} removeCurrencies
 * @returns {{ rates: Record<string, unknown>, removedKeys: string[], codes: string[] }}
 */
function omitCurrenciesFromRates(rates, removeCurrencies) {
  const codes = [];
  if (Array.isArray(removeCurrencies)) {
    for (const raw of removeCurrencies) {
      const code = normalizeCurrencyCode(raw);
      if (isCurrencyCode(code) && !codes.includes(code)) codes.push(code);
    }
  }
  const codeSet = new Set(codes);
  const src = rates && typeof rates === "object" ? rates : {};
  if (!codeSet.size) {
    return {rates: {...src}, removedKeys: [], codes};
  }

  const out = {};
  const removedKeys = [];
  for (const [rawKey, row] of Object.entries(src)) {
    const key = String(rawKey || "").toUpperCase().trim();
    let drop = codeSet.has(key);
    if (!drop && key.includes("/")) {
      const [left, right] = key.split("/");
      drop = codeSet.has(left) || codeSet.has(right);
    }
    if (drop) {
      removedKeys.push(rawKey);
      continue;
    }
    out[rawKey] = row;
  }
  return {rates: out, removedKeys, codes};
}

/**
 * @param {Record<string, unknown>} incomingRates
 * @param {Record<string, unknown>} [existingRates]
 * @param {{ rateVersion?: number, removeCurrencies?: unknown }} [options]
 * @returns {{
 *   rates: Record<string, { buyRate: number, sellRate: number }>,
 *   baseCurrency: string,
 *   rateMeaning: string,
 *   rateVersion: number,
 *   conflicts: Array<Object>,
 *   removedKeys: string[],
 * }}
 */
function normalizeRatesForStorage(incomingRates, existingRates = {}, options = {}) {
  const omitted = omitCurrenciesFromRates(existingRates || {}, options.removeCurrencies);
  const mergedRaw = {...omitted.rates, ...(incomingRates || {})};
  const {book, exactPairs, conflicts} = normalizeKesBook(mergedRaw);
  const rates = {};

  for (const [code, row] of Object.entries(book)) {
    if (!Number.isFinite(row.buyRate) || row.buyRate <= 0 ||
        !Number.isFinite(row.sellRate) || row.sellRate <= 0) {
      throw new Error(`Invalid rates for ${code}: buyRate and sellRate must be > 0`);
    }
    rates[code] = {buyRate: row.buyRate, sellRate: row.sellRate};
  }

  for (const [pair, row] of Object.entries(exactPairs)) {
    rates[pair] = {buyRate: row.buyRate, sellRate: row.sellRate};
  }

  const prev = Number(options.rateVersion);
  const rateVersion = (Number.isFinite(prev) ? prev : 0) + 1;

  return {
    rates,
    baseCurrency: BASE_CURRENCY,
    rateMeaning: RATE_MEANING,
    rateVersion,
    conflicts,
    removedKeys: omitted.removedKeys,
  };
}

/**
 * @param {Record<string, unknown>} query
 * @param {Object} [options]
 */
function parseSendGetQuery(query, options = {}) {
  const q = query && typeof query === "object" ? query : {};
  const send = normalizeCurrencyCode(q.send ?? q.from);
  const get = normalizeCurrencyCode(q.get ?? q.to);
  const defaultPair = options.defaultPair || `USDT/${BASE_CURRENCY}`;

  if ((send && !get) || (!send && get)) {
    return {
      ok: false,
      error: "INVALID_CURRENCY",
      message: "Provide both send and get currency codes (e.g. send=ETB&get=USDC)",
    };
  }

  if (send && get) {
    if (!isCurrencyCode(send) || !isCurrencyCode(get)) {
      return {
        ok: false,
        error: "INVALID_CURRENCY",
        message: "send and get must be currency codes (e.g. ETB, USDC)",
      };
    }
    return {
      ok: true,
      sendCurrency: send,
      getCurrency: get,
      currencyPair: `${send}/${get}`,
      via: "sendGet",
    };
  }

  const rawPair = String(q.currencyPair || "").toUpperCase().trim();
  if (rawPair.includes("/")) {
    const [base, quote] = rawPair.split("/");
    const sendCurrency = normalizeCurrencyCode(base);
    const getCurrency = normalizeCurrencyCode(quote);
    if (!sendCurrency || !getCurrency || !isCurrencyCode(sendCurrency) || !isCurrencyCode(getCurrency)) {
      return {
        ok: false,
        error: "INVALID_CURRENCY",
        message: "currencyPair must look like SEND/GET (e.g. ETB/USDC)",
      };
    }
    return {
      ok: true,
      sendCurrency,
      getCurrency,
      currencyPair: `${sendCurrency}/${getCurrency}`,
      via: "currencyPair",
    };
  }

  const [defSend, defGet] = defaultPair.split("/");
  return {
    ok: true,
    sendCurrency: normalizeCurrencyCode(defSend),
    getCurrency: normalizeCurrencyCode(defGet),
    currencyPair: `${normalizeCurrencyCode(defSend)}/${normalizeCurrencyCode(defGet)}`,
    via: "default",
  };
}

/**
 * Exchange payload. Customer sells Send → rate = sellRate (Get per 1 Send).
 *
 * @param {Object} params
 * @returns {Object}
 */
function buildSendGetRatePayload({
  sendCurrency,
  getCurrency,
  pairRates,
  source,
  updatedAt = null,
  numeraire = BASE_CURRENCY,
  rateUnit = null,
  quotable = true,
  settleable = false,
  rateVersion = null,
  conflicts = null,
}) {
  const buyRate = Number(pairRates.buyRate);
  const sellRate = Number(pairRates.sellRate);
  const rate = sellRate;
  let displayRate = String(rate);
  if (Number.isFinite(rate)) {
    const fixed = Math.abs(rate) >= 1 ? rate.toFixed(4) : rate.toFixed(6);
    displayRate = fixed.replace(/\.?0+$/, "");
  }

  const payload = {
    sendCurrency,
    getCurrency,
    currencyPair: `${sendCurrency}/${getCurrency}`,
    buyRate,
    sellRate,
    /** @deprecated alias — same as buyRate; platform acquires 1 unit paying this many KES */
    platformBuyRate: buyRate,
    /** @deprecated alias — same as sellRate; platform sells 1 unit charging this many KES */
    platformSellRate: sellRate,
    rate,
    rateSide: "sell",
    exchangeRate: rate,
    display: `1 ${sendCurrency} = ${displayRate} ${getCurrency}`,
    source,
    numeraire,
    rateMeaning: RATE_MEANING,
    rateUnit: rateUnit || `${getCurrency}_PER_${sendCurrency}`,
    quotable,
    settleable,
    updatedAt,
  };
  if (rateVersion != null) payload.rateVersion = rateVersion;
  if (conflicts && conflicts.length) payload.rateConflicts = conflicts;
  return payload;
}

/**
 * @param {Record<string, unknown>} rates
 * @returns {Record<string, { buyRate: number, sellRate: number }>}
 */
function toCurrencyBook(rates) {
  return {...normalizeKesBook(rates).book};
}

module.exports = {
  BASE_CURRENCY,
  RATE_MEANING,
  LEGACY_HUB_PREFIXES,
  asValidPairRates,
  invertPairRates,
  normalizeCurrencyCode,
  isCurrencyCode,
  normalizeKesBook,
  getKesPerUnit,
  crossFromKes,
  resolveCustomerPair,
  listCurrenciesFromRates,
  expandRatesWithCrosses,
  omitCurrenciesFromRates,
  normalizeRatesForStorage,
  parseSendGetQuery,
  buildSendGetRatePayload,
  toCurrencyBook,
};
