/**
 * @fileoverview Unit tests for C2B FX conversion to KES.
 */

jest.mock("../../services/rateService");

const rateService = require("../../services/rateService");
const { convertToKesForPaystack } = require("../../services/funding/c2bFundingFxService");

describe("c2bFundingFxService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    rateService.getRates.mockResolvedValue({
      customerPrice: 130,
      marketPrice: 128,
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

  it("rejects unsupported currencies", async () => {
    await expect(convertToKesForPaystack(100, "NGN")).rejects.toThrow("USD, KES");
  });

  it("rejects non-positive amounts", async () => {
    await expect(convertToKesForPaystack(0, "KES")).rejects.toThrow("positive number");
  });
});
