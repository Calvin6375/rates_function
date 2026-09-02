/**
 * @fileoverview C2B Send Money quote breakdown tests.
 */

jest.mock("../../libs/firestore", () => ({
  collection: jest.fn(),
  serverTimestamp: jest.fn(() => ({_serverTimestamp: true})),
}));

const {collection} = require("../../libs/firestore");
const productPricingService = require("../../services/pricing/productPricingService");
const {quotePayoutBreakdown} = require("../../services/safariCard/safariCardPayoutFeeService");

describe("quotePayoutBreakdown", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    productPricingService.clearCache();
    collection.mockImplementation(() => ({
      doc: (id) => ({
        get: jest.fn().mockResolvedValue({
          exists: id === "productPricing",
          data: () => ({
            products: {
              send_ke: {enabled: true, feePercent: 0.75, flatFeeKes: 15},
            },
          }),
        }),
      }),
    }));
  });

  afterEach(() => {
    productPricingService.clearCache();
  });

  it("returns Send Money review lines with send_ke fee", async () => {
    const quote = await quotePayoutBreakdown({
      payoutType: "MPESA_B2C",
      amount: 10,
      currency: "KES",
    });

    expect(quote.youSend).toBe(10);
    expect(quote.artoFees).toBe(15.08);
    expect(quote.youWillPay).toBe(25.08);
    expect(quote.lines.find((l) => l.key === "arto_fees").display).toBe("15.08 KES");
    expect(quote.lines.find((l) => l.key === "you_will_pay").display).toBe("25.08 KES");
    expect(quote.pricingProductKey).toBe("send_ke");
  });
});
