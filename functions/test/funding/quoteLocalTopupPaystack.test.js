/**
 * @fileoverview Unit tests for Local Topup quote breakdown.
 */

jest.mock("../../services/funding/c2bFundingFxService", () => {
  const actual = jest.requireActual("../../services/funding/c2bFundingFxService");
  return {
    ...actual,
    convertToKesForPaystack: jest.fn(),
  };
});
jest.mock("../../services/pricing/productPricingService", () => ({
  computeLocalTopupPaystackCharge: jest.fn(),
}));

const {convertToKesForPaystack} = require("../../services/funding/c2bFundingFxService");
const productPricingService = require("../../services/pricing/productPricingService");
const {quoteLocalTopupPaystack} = require("../../services/funding/c2bFundingBridgeService");

describe("quoteLocalTopupPaystack", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns Free fees when local_topup is not live", async () => {
    convertToKesForPaystack.mockResolvedValue({
      requestedAmount: 180,
      requestedCurrency: "KES",
      amountKes: 180,
      paystackCurrency: "KES",
      fxRate: 1,
    });
    productPricingService.computeLocalTopupPaystackCharge.mockResolvedValue({
      creditAmountKes: 180,
      feeAmount: 0,
      chargeAmountKes: 180,
      applied: false,
      feePercent: 0,
      flatFee: 0,
      pricingProductKey: "local_topup",
    });

    const quote = await quoteLocalTopupPaystack({amount: 180, currency: "KES"});
    expect(quote.youDeposit).toBe(180);
    expect(quote.maxTopupKes).toBe(50000);
    expect(quote.maxTopupAmount).toBe(50000);
    expect(quote.maxTopupCurrency).toBe("KES");
    expect(quote.youWillPay).toBe(180);
    expect(quote.lines.find((l) => l.key === "processing_fees").display).toBe("Free");
    expect(quote.lines.find((l) => l.key === "you_will_pay").display).toBe("180.00 KES");
  });

  it("returns surcharge when local_topup is live", async () => {
    convertToKesForPaystack.mockResolvedValue({
      requestedAmount: 50,
      requestedCurrency: "KES",
      amountKes: 50,
      paystackCurrency: "KES",
      fxRate: 1,
    });
    productPricingService.computeLocalTopupPaystackCharge.mockResolvedValue({
      creditAmountKes: 50,
      feeAmount: 1.25,
      chargeAmountKes: 51.25,
      applied: true,
      feePercent: 2.5,
      flatFee: 0,
      pricingProductKey: "local_topup",
    });

    const quote = await quoteLocalTopupPaystack({amount: 50, currency: "KES"});
    expect(quote).toMatchObject({
      youDeposit: 50,
      processingFees: 1.25,
      processingFeesCurrency: "KES",
      youWillPay: 51.25,
      youWillPayCurrency: "KES",
      paystackAmount: 51.25,
      pricingApplied: true,
      provider: "paystack",
    });
    expect(quote.lines.find((l) => l.key === "processing_fees").display).toBe("1.25 KES");
    expect(quote.lines.find((l) => l.key === "you_will_pay").display).toBe("51.25 KES");
  });

  it("returns processing fees in USD when the user deposits USD", async () => {
    convertToKesForPaystack.mockResolvedValue({
      requestedAmount: 5,
      requestedCurrency: "USD",
      amountKes: 649.1,
      paystackCurrency: "KES",
      fxRate: 129.82,
    });
    productPricingService.computeLocalTopupPaystackCharge.mockResolvedValue({
      creditAmountKes: 649.1,
      feeAmount: 66.89,
      chargeAmountKes: 715.99,
      applied: true,
      feePercent: 1.523,
      flatFee: 57,
      pricingProductKey: "local_topup",
    });

    const quote = await quoteLocalTopupPaystack({amount: 5, currency: "USD"});
    expect(quote.youDeposit).toBe(5);
    expect(quote.currency).toBe("USD");
    expect(quote.processingFeesCurrency).toBe("USD");
    expect(quote.youWillPayCurrency).toBe("USD");
    expect(quote.processingFees).toBe(0.52);
    expect(quote.youWillPay).toBe(5.52);
    expect(quote.paystackAmount).toBe(715.99);
    expect(quote.paystackCurrency).toBe("KES");
    expect(quote.feeAmountKes).toBe(66.89);
    expect(quote.lines.find((l) => l.key === "processing_fees")).toMatchObject({
      amount: 0.52,
      currency: "USD",
      display: "0.52 USD",
    });
    expect(quote.lines.find((l) => l.key === "you_will_pay").display).toBe("5.52 USD");
  });

  it("rejects quotes above 50,000 KES with a customer-facing limit", async () => {
    convertToKesForPaystack.mockResolvedValue({
      requestedAmount: 60000,
      requestedCurrency: "KES",
      amountKes: 60000,
      paystackCurrency: "KES",
      fxRate: 1,
    });

    await expect(quoteLocalTopupPaystack({amount: 60000, currency: "KES"}))
        .rejects.toThrow(/maximum top-up is 50,000 KES/);
  });
});
