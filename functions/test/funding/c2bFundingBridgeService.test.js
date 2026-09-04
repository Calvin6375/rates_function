/**
 * @fileoverview Unit tests for C2B createPayment → funding bridge.
 */

jest.mock("../../services/funding/fundingOrderService");
jest.mock("../../services/funding/fundingRailService");
jest.mock("../../services/funding/fundingIdempotencyService");
jest.mock("../../services/funding/c2bFundingFxService", () => {
  const actual = jest.requireActual("../../services/funding/c2bFundingFxService");
  return {
    ...actual,
    convertToKesForPaystack: jest.fn(),
  };
});
jest.mock("../../services/ops/paymentTimelineService", () => ({
  recordEvent: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../services/ops/opsMetricsService", () => ({
  increment: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../services/pricing/productPricingService", () => ({
  computeLocalTopupPaystackCharge: jest.fn(),
}));

const fundingOrderService = require("../../services/funding/fundingOrderService");
const fundingRailService = require("../../services/funding/fundingRailService");
const fundingIdempotencyService = require("../../services/funding/fundingIdempotencyService");
const { convertToKesForPaystack } = require("../../services/funding/c2bFundingFxService");
const productPricingService = require("../../services/pricing/productPricingService");
const c2bFundingBridge = require("../../services/funding/c2bFundingBridgeService");

describe("c2bFundingBridgeService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fundingIdempotencyService.lookupIdempotencyKey.mockResolvedValue(null);
    fundingIdempotencyService.claimIdempotencyKey.mockResolvedValue({ duplicate: false });
    fundingOrderService.generateFundingOrderId.mockReturnValue("fund_test_123");
    productPricingService.computeLocalTopupPaystackCharge.mockImplementation(async (amountKes) => ({
      creditAmountKes: Number(amountKes),
      feeAmount: 0,
      chargeAmountKes: Number(amountKes),
      applied: false,
      feePercent: 0,
      flatFee: 0,
      pricingProductKey: "local_topup",
      reason: "not_enabled",
      source: "defaults",
    }));
    convertToKesForPaystack.mockResolvedValue({
      requestedAmount: 25,
      requestedCurrency: "USD",
      amountKes: 3250,
      paystackCurrency: "KES",
      fxRate: 130,
    });
    fundingOrderService.createFundingOrder.mockResolvedValue({
      id: "fund_test_123",
      userId: "user_1",
      provider: "paystack",
      amount: 3250,
      currency: "KES",
      status: "pending",
      providerReference: "fund_test_123",
      correlationId: "corr_abc",
      metadata: {
        product: "tourist",
        requestedAmount: 25,
        requestedCurrency: "USD",
        fxRate: 130,
      },
    });
    fundingRailService.initializePayment.mockResolvedValue({
      checkoutUrl: "https://checkout.paystack.com/test",
      providerReference: "fund_test_123",
      providerTransactionId: "access_code_1",
    });
    fundingOrderService.updateFundingOrder.mockResolvedValue({
      id: "fund_test_123",
      userId: "user_1",
      provider: "paystack",
      amount: 3250,
      currency: "KES",
      status: "pending",
      providerReference: "fund_test_123",
      checkoutUrl: "https://checkout.paystack.com/test",
      correlationId: "corr_abc",
      metadata: {
        requestedAmount: 25,
        requestedCurrency: "USD",
      },
    });
  });

  it("returns legacy createPayment response shape with requested currency", async () => {
    const response = await c2bFundingBridge.createC2bTopupCheckout({
      userId: "user_1",
      amount: 25,
      currency: "USD",
      email: "tourist@example.com",
    });

    expect(response).toMatchObject({
      success: true,
      orderId: "fund_test_123",
      invoiceId: "fund_test_123",
      amount: 25,
      currency: "USD",
      paystackAmount: 3250,
      paystackCurrency: "KES",
      checkoutUrl: "https://checkout.paystack.com/test",
      provider: "paystack",
    });

    expect(convertToKesForPaystack).toHaveBeenCalledWith(25, "USD");
    expect(fundingRailService.initializePayment).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "paystack",
          amount: 3250,
          currency: "KES",
        }),
    );
  });

  it("rejects createPayment when KES equivalent exceeds 50,000", async () => {
    convertToKesForPaystack.mockResolvedValue({
      requestedAmount: 600,
      requestedCurrency: "USD",
      amountKes: 78000,
      paystackCurrency: "KES",
      fxRate: 130,
    });

    await expect(c2bFundingBridge.createC2bTopupCheckout({
      userId: "user_1",
      amount: 600,
      currency: "USD",
    })).rejects.toThrow(/384\.61 USD or less/);
    expect(fundingOrderService.createFundingOrder).not.toHaveBeenCalled();
  });

  it("converts KES input for Paystack", async () => {
    convertToKesForPaystack.mockResolvedValue({
      requestedAmount: 200,
      requestedCurrency: "KES",
      amountKes: 200,
      paystackCurrency: "KES",
      fxRate: 1,
    });

    await c2bFundingBridge.createC2bTopupCheckout({
      userId: "user_1",
      amount: 200,
      currency: "KES",
    });

    expect(convertToKesForPaystack).toHaveBeenCalledWith(200, "KES");
    expect(fundingRailService.initializePayment).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 200,
          currency: "KES",
        }),
    );
  });

  it("charges Paystack in KES for an ETB top-up and returns ETB on the response", async () => {
    convertToKesForPaystack.mockResolvedValue({
      requestedAmount: 600,
      requestedCurrency: "ETB",
      amountKes: 859.62,
      paystackCurrency: "KES",
      fxRate: 1.4327,
    });
    fundingOrderService.createFundingOrder.mockResolvedValue({
      id: "fund_etb_1",
      userId: "user_1",
      provider: "paystack",
      amount: 859.62,
      currency: "KES",
      status: "pending",
      providerReference: "fund_etb_1",
      correlationId: "corr_etb",
      metadata: {
        product: "tourist",
        requestedAmount: 600,
        requestedCurrency: "ETB",
        fxRate: 1.4327,
      },
    });
    fundingOrderService.updateFundingOrder.mockResolvedValue({
      id: "fund_etb_1",
      userId: "user_1",
      provider: "paystack",
      amount: 859.62,
      currency: "KES",
      status: "pending",
      providerReference: "fund_etb_1",
      checkoutUrl: "https://checkout.paystack.com/etb",
      correlationId: "corr_etb",
      metadata: {
        requestedAmount: 600,
        requestedCurrency: "ETB",
        fxRate: 1.4327,
      },
    });

    const response = await c2bFundingBridge.createC2bTopupCheckout({
      userId: "user_1",
      amount: 600,
      currency: "ETB",
      email: "ruben@gmail.com",
    });

    expect(convertToKesForPaystack).toHaveBeenCalledWith(600, "ETB");
    expect(fundingOrderService.createFundingOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 859.62,
          currency: "KES",
          metadata: expect.objectContaining({
            requestedAmount: 600,
            requestedCurrency: "ETB",
          }),
        }),
    );
    expect(fundingRailService.initializePayment).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 859.62,
          currency: "KES",
        }),
    );
    expect(response).toMatchObject({
      amount: 600,
      currency: "ETB",
      paystackAmount: 859.62,
      paystackCurrency: "KES",
      checkoutUrl: "https://checkout.paystack.com/etb",
    });
  });

  it("returns duplicate idempotent response without re-initializing", async () => {
    fundingIdempotencyService.lookupIdempotencyKey.mockResolvedValue({
      fundingOrderId: "fund_existing",
    });
    fundingOrderService.getFundingOrderForUser.mockResolvedValue({
      id: "fund_existing",
      providerReference: "fund_existing",
      amount: 200,
      currency: "KES",
      status: "pending",
      checkoutUrl: "https://checkout.paystack.com/existing",
      provider: "paystack",
      metadata: { requestedAmount: 200, requestedCurrency: "KES" },
    });

    const response = await c2bFundingBridge.createC2bTopupCheckout({
      userId: "user_1",
      amount: 200,
      currency: "KES",
      idempotencyKey: "idem_1",
    });

    expect(response.duplicate).toBe(true);
    expect(response.amount).toBe(200);
    expect(response.currency).toBe("KES");
    expect(fundingRailService.initializePayment).not.toHaveBeenCalled();
  });
});
