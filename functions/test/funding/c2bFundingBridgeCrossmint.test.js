/**
 * @fileoverview USD createPayment routes to Crossmint. KES stays on Paystack.
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
jest.mock("../../utils/fundingCustomerEmail", () => ({
  resolveFundingCustomerEmail: jest.fn(async () => ({
    email: "tourist@example.com",
    usedFallback: false,
    corrected: false,
    source: "client",
  })),
}));

const fundingOrderService = require("../../services/funding/fundingOrderService");
const fundingRailService = require("../../services/funding/fundingRailService");
const fundingIdempotencyService = require("../../services/funding/fundingIdempotencyService");
const { convertToKesForPaystack } = require("../../services/funding/c2bFundingFxService");
const c2bFundingBridge = require("../../services/funding/c2bFundingBridgeService");

describe("c2bFundingBridgeService crossmint", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.FUNDING_USD_PROVIDER;
    fundingIdempotencyService.lookupIdempotencyKey.mockResolvedValue(null);
    fundingIdempotencyService.claimIdempotencyKey.mockResolvedValue({ duplicate: false });
    fundingOrderService.generateFundingOrderId.mockReturnValue("fund_cm_1");
  });

  afterEach(() => {
    delete process.env.FUNDING_USD_PROVIDER;
  });

  it("creates a USD funding order on Crossmint and returns checkout secrets once", async () => {
    fundingOrderService.createFundingOrder.mockResolvedValue({
      id: "fund_cm_1",
      userId: "user_1",
      provider: "crossmint",
      amount: 10,
      currency: "USD",
      status: "pending",
      providerReference: "fund_cm_1",
      correlationId: "corr_cm",
      metadata: {
        product: "tourist",
        requestedAmount: 10,
        requestedCurrency: "USD",
      },
    });
    fundingRailService.initializePayment.mockResolvedValue({
      checkoutUrl: "https://staging.crossmint.com/sdk/2024-03-05/embedded-checkout?orderId=cm1",
      providerReference: "cm_order_1",
      providerTransactionId: "cm_order_1",
      raw: {
        orderId: "cm_order_1",
        clientSecret: "cs_secret",
        collectionWallet: "0xCollectionWallet",
        tokenLocator: "base-sepolia:0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        chain: "base-sepolia",
      },
    });
    fundingOrderService.updateFundingOrder.mockImplementation(async (_id, patch) => ({
      id: "fund_cm_1",
      userId: "user_1",
      provider: "crossmint",
      amount: 10,
      currency: "USD",
      status: "pending",
      providerReference: patch.providerReference,
      checkoutUrl: patch.checkoutUrl,
      correlationId: "corr_cm",
      metadata: patch.metadata,
    }));

    const response = await c2bFundingBridge.createC2bTopupCheckout({
      userId: "user_1",
      amount: 10,
      currency: "USD",
      email: "ruben@gmail.com",
    });

    expect(convertToKesForPaystack).not.toHaveBeenCalled();
    expect(fundingOrderService.createFundingOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "crossmint",
          amount: 10,
          currency: "USD",
        }),
    );
    expect(fundingRailService.initializePayment).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "crossmint",
          amount: 10,
          currency: "USD",
          fundingOrderId: "fund_cm_1",
          email: "tourist@example.com",
        }),
    );
    expect(fundingOrderService.updateFundingOrder).toHaveBeenCalledWith(
        "fund_cm_1",
        expect.objectContaining({
          providerReference: "cm_order_1",
          checkoutUrl: null,
          metadata: expect.not.objectContaining({ clientSecret: expect.anything() }),
        }),
    );
    expect(response).toMatchObject({
      success: true,
      provider: "crossmint",
      orderId: "fund_cm_1",
      checkout: { orderId: "cm_order_1", clientSecret: "cs_secret" },
    });
    expect(response.checkoutUrl).toContain("embedded-checkout");
  });

  it("keeps KES on Paystack when the USD provider is Crossmint", async () => {
    convertToKesForPaystack.mockResolvedValue({
      requestedAmount: 200,
      requestedCurrency: "KES",
      amountKes: 200,
      paystackCurrency: "KES",
      fxRate: 1,
    });
    const productPricingService = require("../../services/pricing/productPricingService");
    productPricingService.computeLocalTopupPaystackCharge.mockResolvedValue({
      creditAmountKes: 200,
      feeAmount: 0,
      chargeAmountKes: 200,
      applied: false,
      feePercent: 0,
      flatFee: 0,
      pricingProductKey: "local_topup",
    });
    fundingOrderService.createFundingOrder.mockResolvedValue({
      id: "fund_kes_1",
      userId: "user_1",
      provider: "paystack",
      amount: 200,
      currency: "KES",
      status: "pending",
      providerReference: "fund_kes_1",
      metadata: { requestedAmount: 200, requestedCurrency: "KES" },
    });
    fundingRailService.initializePayment.mockResolvedValue({
      checkoutUrl: "https://checkout.paystack.com/kes",
      providerReference: "fund_kes_1",
    });
    fundingOrderService.updateFundingOrder.mockResolvedValue({
      id: "fund_kes_1",
      provider: "paystack",
      amount: 200,
      currency: "KES",
      status: "pending",
      providerReference: "fund_kes_1",
      checkoutUrl: "https://checkout.paystack.com/kes",
      metadata: { requestedAmount: 200, requestedCurrency: "KES" },
    });

    const response = await c2bFundingBridge.createC2bTopupCheckout({
      userId: "user_1",
      amount: 200,
      currency: "KES",
    });

    expect(fundingRailService.initializePayment).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "paystack", currency: "KES", amount: 200 }),
    );
    expect(response.provider).toBe("paystack");
    expect(response.checkoutUrl).toBe("https://checkout.paystack.com/kes");
  });

  it("marks the funding order failed when Crossmint initialization fails", async () => {
    fundingOrderService.createFundingOrder.mockResolvedValue({
      id: "fund_cm_1",
      userId: "user_1",
      provider: "crossmint",
      amount: 10,
      currency: "USD",
      status: "pending",
      providerReference: "fund_cm_1",
      metadata: { requestedAmount: 10, requestedCurrency: "USD" },
    });
    fundingRailService.initializePayment.mockRejectedValue(new Error("Crossmint 400: Invalid arguments"));

    await expect(c2bFundingBridge.createC2bTopupCheckout({
      userId: "user_1",
      amount: 10,
      currency: "USD",
    })).rejects.toThrow("Crossmint 400");

    expect(fundingOrderService.updateFundingOrder).toHaveBeenCalledWith(
        "fund_cm_1",
        expect.objectContaining({ status: "failed" }),
    );
  });

  it("rejects grid as FUNDING_USD_PROVIDER", async () => {
    process.env.FUNDING_USD_PROVIDER = "grid";
    await expect(c2bFundingBridge.createC2bTopupCheckout({
      userId: "user_1",
      amount: 10,
      currency: "USD",
    })).rejects.toThrow("Unsupported FUNDING_USD_PROVIDER: grid");
  });
});
