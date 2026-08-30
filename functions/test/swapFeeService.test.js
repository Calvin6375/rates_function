/**
 * @fileoverview Server-authoritative swap fee breakdown (FEE_ON_SEND).
 */

jest.mock("../admin", () => ({
  firestore: jest.fn(() => ({
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        get: jest.fn().mockResolvedValue({
          exists: true,
          data: () => ({swapFeeRate: 0.01}),
        }),
      })),
    })),
  })),
}));

jest.mock("../config", () => ({
  collections: {config: "config"},
}));

const {computeSwapFeeBreakdown} = require("../services/swapFeeService");

describe("swapFeeService FEE_ON_SEND", () => {
  it("fee on send; Get unchanged by fee", async () => {
    const b = await computeSwapFeeBreakdown({
      sendAmount: 100000,
      sendCurrency: "ETB",
      getCurrency: "USDC",
      exchangeRate: 1.4327 / 129.5,
    });
    expect(b.feeConvention).toBe("FEE_ON_SEND");
    expect(b.feeRate).toBe(0.01);
    expect(Number(b.feeAmount)).toBe(1000); // 1% of 100000 ETB
    expect(Number(b.totalDebit)).toBe(101000);
    expect(Number(b.grossGetAmount)).toBeCloseTo(1106.332046, 5);
    expect(b.netGetAmount).toBe(b.grossGetAmount);
    expect(b.feeCurrency).toBe("ETB");
  });
});
