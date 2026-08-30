/**
 * @fileoverview End-to-end ETB→USDC quote amounts (100,000 ETB → ~1,106.33 USDC).
 * Settlement remains PAIR_NOT_SETTLEABLE until USDC is on the swap ledger.
 */

const {
  resolveCustomerPair,
  buildSendGetRatePayload,
} = require("../utils/customerRatesResolve");
const {quoteAmounts} = require("../utils/money");
const {getPairCapabilities} = require("../services/settlementCapabilityService");

const book = {
  ETB: {buyRate: 1.4415, sellRate: 1.4327},
  USDC: {buyRate: 129.5, sellRate: 128.15},
};

describe("ETB → USDC Exchange quote (100,000 ETB)", () => {
  it("rate = ETB.sell / USDC.buy ≈ 0.0110633", () => {
    const resolved = resolveCustomerPair(book, "ETB/USDC");
    expect(resolved.source).toBe("admin_cross");
    expect(resolved.sellRate).toBeCloseTo(1.4327 / 129.5, 8);
    expect(resolved.sellRate).toBeCloseTo(0.01106332046332, 10);
    expect(resolved.sellRate).not.toBeCloseTo(1 / 1.4415, 3);
  });

  it("100000 ETB → ≈ 1106.33 USDC with decimal rounding", () => {
    const resolved = resolveCustomerPair(book, "ETB/USDC");
    const amounts = quoteAmounts(100000, "ETB", resolved.sellRate, "USDC");
    expect(amounts.sendAmount).toBe("100000.00");
    expect(Number(amounts.getAmount)).toBeCloseTo(1106.332046, 5);
    // USDC 6 dp boundary
    expect(amounts.getAmount).toMatch(/^\d+\.\d{6}$/);
  });

  it("payload rate matches locked quote math; settleable=false", () => {
    const resolved = resolveCustomerPair(book, "ETB/USDC");
    const caps = getPairCapabilities("ETB", "USDC");
    expect(caps.quotable).toBe(true);
    expect(caps.settleable).toBe(false);

    const payload = buildSendGetRatePayload({
      sendCurrency: "ETB",
      getCurrency: "USDC",
      pairRates: resolved,
      source: resolved.source,
      rateUnit: resolved.rateUnit,
      quotable: caps.quotable,
      settleable: caps.settleable,
    });
    expect(payload.rate).toBe(resolved.sellRate);
    expect(payload.rateSide).toBe("sell");
    expect(payload.settleable).toBe(false);

    const amounts = quoteAmounts(100000, "ETB", payload.rate, "USDC");
    expect(Number(amounts.getAmount)).toBeCloseTo(100000 * payload.rate, 5);
  });

  it("EUR and USD customer sides use sellRate of SEND/GET", () => {
    const rates = {
      ...book,
      EUR: {buyRate: 138, sellRate: 143},
      USD: {buyRate: 129.5, sellRate: 128.15},
    };
    const eurUsdc = resolveCustomerPair(rates, "EUR/USDC");
    expect(eurUsdc.sellRate).toBeCloseTo(143 / 129.5, 8);

    const usdKes = resolveCustomerPair({
      USD: {buyRate: 129.5, sellRate: 128.15},
      KES: {buyRate: 1, sellRate: 1},
    }, "USD/KES");
    expect(usdKes.sellRate).toBeCloseTo(128.15 / 1, 8);
  });
});
