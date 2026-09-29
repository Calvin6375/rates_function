/**
 * @fileoverview USD createPayment routes to Grid. KES stays on Paystack.
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

const instructions = {
  instructionsNotes: "Include the reference code",
  accountOrWalletInfo: {
    accountType: "USD_ACCOUNT",
    accountNumber: "9876543210",
    routingNumber: "021000021",
    bankName: "JP Morgan Chase",
  },
};

describe("c2bFundingBridgeService grid", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.FUNDING_USD_PROVIDER;
    fundingIdempotencyService.lookupIdempotencyKey.mockResolvedValue(null);
    fundingIdempotencyService.claimIdempotencyKey.mockResolvedValue({ duplicate: false });
    fundingOrderService.generateFundingOrderId.mockReturnValue("fund_grid_1");
  });

  afterEach(() => {
    delete process.env.FUNDING_USD_PROVIDER;
  });

  it("creates a USD funding order on Grid and returns funding instructions", async () => {
    fundingOrderService.createFundingOrder.mockResolvedValue({
      id: "fund_grid_1",
      userId: "user_1",
      provider: "grid",
      amount: 100,
      currency: "USD",
      status: "pending",
      providerReference: "fund_grid_1",
      correlationId: "corr_grid",
      metadata: {
        product: "tourist",
        requestedAmount: 100,
        requestedCurrency: "USD",
      },
    });
    fundingRailService.initializePayment.mockResolvedValue({
      checkoutUrl: null,
      providerReference: "fund_grid_1",
      providerTransactionId: null,
      raw: {
        customerId: "Customer:c1",
        internalAccountId: "InternalAccount:a1",
        fundingInstructions: instructions,
        fundingPaymentInstructions: [instructions],
      },
    });
    fundingOrderService.updateFundingOrder.mockImplementation(async (_id, patch) => ({
      id: "fund_grid_1",
      userId: "user_1",
      provider: "grid",
      amount: 100,
      currency: "USD",
      status: "pending",
      providerReference: "fund_grid_1",
      checkoutUrl: null,
      providerCustomerId: patch.providerCustomerId,
      providerAccountId: patch.providerAccountId,
      correlationId: "corr_grid",
      metadata: patch.metadata,
    }));

    const response = await c2bFundingBridge.createC2bTopupCheckout({
      userId: "user_1",
      amount: 100,
      currency: "USD",
      email: "ruben@gmail.com",
      firstName: "Ruben",
      lastName: "Mwachiramba",
    });

    expect(convertToKesForPaystack).not.toHaveBeenCalled();
    expect(fundingOrderService.createFundingOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "grid",
          amount: 100,
          currency: "USD",
        }),
    );
    expect(fundingRailService.initializePayment).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "grid",
          amount: 100,
          currency: "USD",
          fundingOrderId: "fund_grid_1",
          firstName: "Ruben",
          lastName: "Mwachiramba",
        }),
    );
    expect(response).toMatchObject({
      success: true,
      provider: "grid",
      orderId: "fund_grid_1",
      currency: "USD",
      amount: 100,
      status: "pending",
      checkoutUrl: null,
      fundingInstructions: instructions,
    });
    expect(response.checkoutUrl).toBeNull();
  });

  it("keeps KES on Paystack when the USD provider is Grid", async () => {
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

  it("marks the funding order failed when Grid initialization fails", async () => {
    fundingOrderService.createFundingOrder.mockResolvedValue({
      id: "fund_grid_1",
      userId: "user_1",
      provider: "grid",
      amount: 100,
      currency: "USD",
      status: "pending",
      providerReference: "fund_grid_1",
      metadata: { requestedAmount: 100, requestedCurrency: "USD" },
    });
    fundingRailService.initializePayment.mockRejectedValue(new Error("Grid API timeout"));

    await expect(c2bFundingBridge.createC2bTopupCheckout({
      userId: "user_1",
      amount: 100,
      currency: "USD",
    })).rejects.toThrow("Grid API timeout");

    expect(fundingOrderService.updateFundingOrder).toHaveBeenCalledWith(
        "fund_grid_1",
        expect.objectContaining({ status: "failed", failureReason: "Grid API timeout" }),
    );
  });
});
