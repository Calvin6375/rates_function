/**
 * @fileoverview Unit tests for C2B createPayment → funding bridge.
 */

jest.mock("../../services/funding/fundingOrderService");
jest.mock("../../services/funding/fundingRailService");
jest.mock("../../services/funding/fundingIdempotencyService");
jest.mock("../../services/funding/c2bFundingFxService");
jest.mock("../../services/ops/paymentTimelineService", () => ({
  recordEvent: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../services/ops/opsMetricsService", () => ({
  increment: jest.fn().mockResolvedValue(undefined),
}));

const fundingOrderService = require("../../services/funding/fundingOrderService");
const fundingRailService = require("../../services/funding/fundingRailService");
const fundingIdempotencyService = require("../../services/funding/fundingIdempotencyService");
const { convertToKesForPaystack } = require("../../services/funding/c2bFundingFxService");
const c2bFundingBridge = require("../../services/funding/c2bFundingBridgeService");

describe("c2bFundingBridgeService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fundingIdempotencyService.lookupIdempotencyKey.mockResolvedValue(null);
    fundingIdempotencyService.claimIdempotencyKey.mockResolvedValue({ duplicate: false });
    fundingOrderService.generateFundingOrderId.mockReturnValue("fund_test_123");
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
