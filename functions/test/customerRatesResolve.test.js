/**
 * @fileoverview KES-numeraire customer rate book + Send/Get crosses + storage.
 */

const {
  resolveCustomerPair,
  expandRatesWithCrosses,
  normalizeKesBook,
  parseSendGetQuery,
  buildSendGetRatePayload,
  normalizeRatesForStorage,
  getKesPerUnit,
  BASE_CURRENCY,
} = require("../utils/customerRatesResolve");
const {getPairCapabilities} = require("../services/settlementCapabilityService");
const {quoteAmounts, ratesEqual} = require("../utils/money");

/** Legacy admin shape: USDT/C keys, values = KES per 1 C */
const legacyRates = {
  "USDT/ETB": {buyRate: 1.4415, sellRate: 1.4327},
  "USDT/USDC": {buyRate: 129.5, sellRate: 128.15},
  "USDT/EUR": {buyRate: 138, sellRate: 143},
  "USDT/USD": {buyRate: 129.5, sellRate: 128.15},
  "USDT/KES": {buyRate: 1, sellRate: 1},
};

const canonicalRates = {
  ETB: {buyRate: 1.4415, sellRate: 1.4327},
  USDC: {buyRate: 129.5, sellRate: 128.15},
  EUR: {buyRate: 138, sellRate: 143},
  USD: {buyRate: 129.5, sellRate: 128.15},
  KES: {buyRate: 1, sellRate: 1},
};

describe("normalizeKesBook", () => {
  it("treats USDT/ETB as KES per ETB (legacy read)", () => {
    const {book, rateMeaning} = normalizeKesBook(legacyRates);
    expect(rateMeaning).toBe("KES_PER_UNIT");
    expect(book.ETB).toEqual({buyRate: 1.4415, sellRate: 1.4327});
    expect(book.USDC).toEqual({buyRate: 129.5, sellRate: 128.15});
    expect(book.KES.buyRate).toBe(1);
  });

  it("prefers canonical key over conflicting legacy", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const {book, conflicts} = normalizeKesBook({
      ETB: {buyRate: 1.5, sellRate: 1.4},
      "USDT/ETB": {buyRate: 1.4415, sellRate: 1.4327},
    });
    expect(book.ETB).toEqual({buyRate: 1.5, sellRate: 1.4});
    expect(conflicts.length).toBeGreaterThan(0);
    warn.mockRestore();
  });

  it("keeps explicit ETB/USDC as override, not book", () => {
    const {book, exactPairs} = normalizeKesBook({
      ...canonicalRates,
      "ETB/USDC": {buyRate: 0.02, sellRate: 0.019},
    });
    expect(book.ETB.buyRate).toBe(1.4415);
    expect(exactPairs["ETB/USDC"].sellRate).toBe(0.019);
  });
});

describe("resolveCustomerPair (KES cross)", () => {
  it("ETB → USDC ≈ 0.01106 (not 0.6937)", () => {
    const result = resolveCustomerPair(legacyRates, "ETB/USDC");
    expect(result).not.toBeNull();
    expect(result.source).toBe("admin_cross");
    expect(result.numeraire).toBe("KES");
    expect(result.rateUnit).toBe("USDC_PER_ETB");
    expect(result.sellRate).toBeCloseTo(1.4327 / 129.5, 6);
    expect(result.sellRate).toBeCloseTo(0.011063, 5);
    expect(result.sellRate).not.toBeCloseTo(1 / 1.4415, 3);
    expect(result.sellRate).not.toBe(1);
  });

  it("customer Send ETB Get USDC uses sellRate as rate", () => {
    const result = resolveCustomerPair(canonicalRates, "ETB/USDC");
    const payload = buildSendGetRatePayload({
      sendCurrency: "ETB",
      getCurrency: "USDC",
      pairRates: result,
      source: result.source,
      rateUnit: result.rateUnit,
    });
    expect(payload.rate).toBe(result.sellRate);
    expect(payload.rateSide).toBe("sell");
    expect(payload.platformSellRate).toBe(result.sellRate);
  });

  it("USDC → ETB ≈ 88.90 on sell side", () => {
    const result = resolveCustomerPair(legacyRates, "USDC/ETB");
    expect(result.source).toBe("admin_cross");
    expect(result.sellRate).toBeCloseTo(128.15 / 1.4415, 4);
  });

  it("EUR → USDC via KES book", () => {
    const result = resolveCustomerPair(legacyRates, "EUR/USDC");
    expect(result.sellRate).toBeCloseTo(143 / 129.5, 5);
  });

  it("USD → USDC with equal KES legs", () => {
    const result = resolveCustomerPair(canonicalRates, "USD/USDC");
    expect(result.sellRate).toBeCloseTo(128.15 / 129.5, 5);
  });

  it("missing USDC returns null (MISSING_RATE) — never 1 or 0.6937", () => {
    const result = resolveCustomerPair(
        {"USDT/ETB": legacyRates["USDT/ETB"]},
        "ETB/USDC",
    );
    expect(result).toBeNull();
  });

  it("identity KES → KES is 1", () => {
    const result = resolveCustomerPair(legacyRates, "KES/KES");
    expect(result).toMatchObject({buyRate: 1, sellRate: 1, source: "identity"});
  });

  it("respects explicit pair override", () => {
    const rates = {
      ...canonicalRates,
      "ETB/USDC": {buyRate: 0.02, sellRate: 0.019},
    };
    const result = resolveCustomerPair(rates, "ETB/USDC");
    expect(result.source).toBe("admin_exact");
    expect(result.sellRate).toBe(0.019);
  });

  it("respects inverse override", () => {
    const rates = {
      ...canonicalRates,
      "USDC/ETB": {buyRate: 90, sellRate: 88},
    };
    const result = resolveCustomerPair(rates, "ETB/USDC");
    expect(result.source).toBe("admin_inverse");
    expect(result.buyRate).toBeCloseTo(1 / 88, 8);
    expect(result.sellRate).toBeCloseTo(1 / 90, 8);
  });
});

describe("settlementCapabilityService", () => {
  it("ETB→USDC quotable but not settleable; USD→KES settleable", () => {
    const a = getPairCapabilities("ETB", "USDC");
    expect(a.quotable).toBe(true);
    expect(a.settleable).toBe(false);
    const b = getPairCapabilities("USD", "KES");
    expect(b.settleable).toBe(true);
  });
});

describe("expandRatesWithCrosses", () => {
  it("includes ETB/USDC cross without requiring stored USDT mirrors", () => {
    const expanded = expandRatesWithCrosses(canonicalRates);
    expect(expanded["ETB/KES"]).toEqual(canonicalRates.ETB);
    expect(expanded["ETB/USDC"].sellRate).toBeCloseTo(1.4327 / 129.5, 6);
  });
});

describe("normalizeRatesForStorage", () => {
  it("writes canonical currency keys only (no USDT/ETB mirrors)", () => {
    const stored = normalizeRatesForStorage({
      ETB: {buyRate: 1.44, sellRate: 1.43},
    });
    expect(stored.baseCurrency).toBe("KES");
    expect(stored.rates.ETB).toEqual({buyRate: 1.44, sellRate: 1.43});
    expect(stored.rates["USDT/ETB"]).toBeUndefined();
    expect(stored.rates["ETB/KES"]).toBeUndefined();
    expect(stored.rateVersion).toBe(1);
  });

  it("reads legacy USDT/C on merge then stores canonical", () => {
    const stored = normalizeRatesForStorage(
        {"USDT/USDC": {buyRate: 130, sellRate: 129}},
        {"USDT/ETB": {buyRate: 1.44, sellRate: 1.43}},
        {rateVersion: 3},
    );
    expect(stored.rateVersion).toBe(4);
    expect(getKesPerUnit(normalizeKesBook(stored.rates).book, "ETB").buyRate).toBe(1.44);
    expect(stored.rates.USDC.buyRate).toBe(130);
    expect(stored.rates["USDT/USDC"]).toBeUndefined();
  });

  it("preserves explicit SEND/GET overrides", () => {
    const stored = normalizeRatesForStorage(
        {"ETB/USDC": {buyRate: 0.02, sellRate: 0.019}},
        canonicalRates,
    );
    expect(stored.rates["ETB/USDC"].sellRate).toBe(0.019);
    expect(stored.rates.ETB.buyRate).toBe(1.4415);
  });
});

describe("money quoteAmounts", () => {
  it("rounds getAmount to USDC 6 dp", () => {
    const q = quoteAmounts(100000, "ETB", 0.0110633, "USDC");
    expect(q.sendAmount).toBe("100000.00");
    expect(Number(q.getAmount)).toBeCloseTo(1106.33, 2);
  });
});

describe("parseSendGetQuery", () => {
  it("maps send+get", () => {
    expect(parseSendGetQuery({send: "etb", get: "usdc"})).toMatchObject({
      ok: true,
      currencyPair: "ETB/USDC",
    });
  });
});
