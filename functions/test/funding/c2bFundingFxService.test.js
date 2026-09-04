/**
 * @fileoverview Unit tests for C2B FX conversion to KES.
 */

jest.mock("../../services/rateService");
jest.mock("../../admin", () => {
  const state = {snap: {exists: false, data: () => ({})}};
  const firestore = jest.fn(() => ({
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        get: jest.fn(async () => state.snap),
      })),
    })),
  }));
  firestore.__state = state;
  return {firestore};
});

const admin = require("../../admin");
const rateService = require("../../services/rateService");
const {
  convertToKesForPaystack,
  extractRatesMap,
  assertC2bTopupWithinMaxKes,
} = require("../../services/funding/c2bFundingFxService");

describe("c2bFundingFxService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    admin.firestore.__state.snap = {exists: false, data: () => ({})};
    rateService.getRates.mockImplementation(async (fiat) => {
      if (fiat === "KES") {
        return {customerPrice: 130, marketPrice: 128};
      }
      if (fiat === "GBP") {
        return {customerPrice: 0.79, marketPrice: 0.78};
      }
      if (fiat === "EUR") {
        return {customerPrice: 0.92, marketPrice: 0.91};
      }
      throw new Error(`No rate for ${fiat}`);
    });
  });

  it("passes through KES amounts unchanged", async () => {
    const result = await convertToKesForPaystack(200, "KES");

    expect(result).toEqual({
      requestedAmount: 200,
      requestedCurrency: "KES",
      amountKes: 200,
      paystackCurrency: "KES",
      fxRate: 1,
    });
    expect(rateService.getRates).not.toHaveBeenCalled();
  });

  it("converts USD to KES using customer price", async () => {
    const result = await convertToKesForPaystack(25, "USD");

    expect(result.requestedAmount).toBe(25);
    expect(result.requestedCurrency).toBe("USD");
    expect(result.amountKes).toBe(3250);
    expect(result.paystackCurrency).toBe("KES");
    expect(result.fxRate).toBe(130);
    expect(rateService.getRates).toHaveBeenCalledWith("KES", "USDT");
  });

  it("converts GBP to KES via USDT cross rate", async () => {
    const result = await convertToKesForPaystack(10, "GBP");

    // 10 GBP * (130 KES/USDT / 0.79 GBP/USDT)
    expect(result.requestedAmount).toBe(10);
    expect(result.requestedCurrency).toBe("GBP");
    expect(result.paystackCurrency).toBe("KES");
    expect(result.fxRate).toBeCloseTo(130 / 0.79, 5);
    expect(result.amountKes).toBeCloseTo(round2(10 * (130 / 0.79)), 2);
    expect(rateService.getRates).toHaveBeenCalledWith("KES", "USDT");
    expect(rateService.getRates).toHaveBeenCalledWith("GBP", "USDT");
  });

  it("converts ETB to KES from the customer P2P book (not Binance)", async () => {
    admin.firestore.__state.snap = {
      exists: true,
      data: () => ({
        rates: {
          ETB: {buyRate: 1.4415, sellRate: 1.4327},
        },
      }),
    };

    const result = await convertToKesForPaystack(600, "ETB");

    expect(result.requestedAmount).toBe(600);
    expect(result.requestedCurrency).toBe("ETB");
    expect(result.paystackCurrency).toBe("KES");
    expect(result.fxRate).toBe(1.4327);
    expect(result.amountKes).toBe(round2(600 * 1.4327));
    expect(rateService.getRates).not.toHaveBeenCalled();
  });

  it("converts ETB using a one-sided book row", async () => {
    admin.firestore.__state.snap = {
      exists: true,
      data: () => ({
        rates: {
          ETB: {sellRate: 1.5},
        },
      }),
    };

    const result = await convertToKesForPaystack(600, "ETB");
    expect(result.fxRate).toBe(1.5);
    expect(result.amountKes).toBe(900);
  });

  it("reads rates stored at the document root", () => {
    const rates = extractRatesMap({
      updatedAt: "x",
      ETB: {buyRate: 1.4, sellRate: 1.5},
    });
    expect(rates.ETB).toEqual({buyRate: 1.4, sellRate: 1.5});
  });

  it("rejects ETB when it is missing from the book and Binance", async () => {
    await expect(convertToKesForPaystack(600, "ETB")).rejects.toThrow(/Add ETB to P2P/);
  });

  it("rejects invalid currency codes", async () => {
    await expect(convertToKesForPaystack(100, "GB")).rejects.toThrow("Invalid currency");
  });

  it("rejects non-positive amounts", async () => {
    await expect(convertToKesForPaystack(0, "KES")).rejects.toThrow("positive number");
  });
});

describe("assertC2bTopupWithinMaxKes", () => {
  it("allows amounts at the 50,000 KES cap", () => {
    expect(() => assertC2bTopupWithinMaxKes({
      amountKes: 50000,
      requestedCurrency: "KES",
      fxRate: 1,
    })).not.toThrow();
  });

  it("tells KES customers the exact KES maximum", () => {
    expect(() => assertC2bTopupWithinMaxKes({
      amountKes: 50000.01,
      requestedAmount: 50000.01,
      requestedCurrency: "KES",
      fxRate: 1,
    })).toThrow(/The maximum top-up is 50,000 KES\. Enter 50,000 KES or less\./);
  });

  it("tells USD customers the equivalent maximum in USD", () => {
    expect(() => assertC2bTopupWithinMaxKes({
      amountKes: 65000,
      requestedAmount: 500,
      requestedCurrency: "USD",
      fxRate: 130,
    })).toThrow(
        /The maximum top-up is 50,000 KES \(384\.61 USD at the current rate\)\. Enter 384\.61 USD or less\./,
    );
  });
});

/**
 * @param {number} n
 * @returns {number}
 */
function round2(n) {
  return Math.round(n * 100) / 100;
}
