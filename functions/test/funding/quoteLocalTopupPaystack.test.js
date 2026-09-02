/**
 * @fileoverview Unit tests for Local Topup quote breakdown.
 */

jest.mock("../../services/funding/c2bFundingFxService");
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
      youWillPay: 51.25,
      pricingApplied: true,
      provider: "paystack",
    });
    expect(quote.lines.find((l) => l.key === "processing_fees").display).toBe("1.25 KES");
    expect(quote.lines.find((l) => l.key === "you_will_pay").display).toBe("51.25 KES");
  });
});
