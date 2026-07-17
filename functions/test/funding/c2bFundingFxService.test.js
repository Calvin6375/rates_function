/**
 * @fileoverview Unit tests for C2B FX conversion to KES.
 */

jest.mock("../../services/rateService");
jest.mock("../../admin", () => ({
  firestore: jest.fn(() => ({
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        get: jest.fn().mockResolvedValue({ exists: false, data: () => ({}) }),
      })),
    })),
  })),
}));

const rateService = require("../../services/rateService");
const { convertToKesForPaystack } = require("../../services/funding/c2bFundingFxService");

describe("c2bFundingFxService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    rateService.getRates.mockImplementation(async (fiat) => {
      if (fiat === "KES") {
        return { customerPrice: 130, marketPrice: 128 };
      }
      if (fiat === "GBP") {
        return { customerPrice: 0.79, marketPrice: 0.78 };
      }
      if (fiat === "EUR") {
        return { customerPrice: 0.92, marketPrice: 0.91 };
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

  it("rejects invalid currency codes", async () => {
    await expect(convertToKesForPaystack(100, "GB")).rejects.toThrow("Invalid currency");
  });

  it("rejects non-positive amounts", async () => {
    await expect(convertToKesForPaystack(0, "KES")).rejects.toThrow("positive number");
  });
});

/**
 * @param {number} n
 * @returns {number}
 */
function round2(n) {
  return Math.round(n * 100) / 100;
}
