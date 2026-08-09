/**
 * @fileoverview Unit tests for B2B Add Money → Paystack bridge.
 */

jest.mock("../../services/funding/fundingOrderService");
jest.mock("../../services/funding/fundingRailService");
jest.mock("../../services/funding/fundingIdempotencyService");
jest.mock("../../services/ops/paymentTimelineService", () => ({
  recordEvent: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../services/ops/opsMetricsService", () => ({
  increment: jest.fn().mockResolvedValue(undefined),
}));

const fundingOrderService = require("../../services/funding/fundingOrderService");
const fundingRailService = require("../../services/funding/fundingRailService");
const fundingIdempotencyService = require("../../services/funding/fundingIdempotencyService");
const b2bFundingBridge = require("../../services/funding/b2bFundingBridgeService");

describe("b2bFundingBridgeService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fundingIdempotencyService.lookupIdempotencyKey.mockResolvedValue(null);
    fundingIdempotencyService.claimIdempotencyKey.mockResolvedValue({ duplicate: false });
    fundingOrderService.generateFundingOrderId.mockReturnValue("fund_b2b_123");
    fundingOrderService.createFundingOrder.mockResolvedValue({
      id: "fund_b2b_123",
      userId: "uid_1",
      provider: "paystack",
      amount: 5000,
      currency: "KES",
      status: "pending",
      providerReference: "fund_b2b_123",
      correlationId: "corr_b2b",
      metadata: {
        product: "b2b_self_topup",
        partnerId: "partner_1",
        requestedAmount: 5000,
        requestedCurrency: "KES",
      },
    });
    fundingRailService.initializePayment.mockResolvedValue({
      checkoutUrl: "https://checkout.paystack.com/b2b",
      providerReference: "fund_b2b_123",
      providerTransactionId: "access_b2b",
    });
    fundingOrderService.updateFundingOrder.mockResolvedValue({
      id: "fund_b2b_123",
      userId: "uid_1",
      provider: "paystack",
      amount: 5000,
      currency: "KES",
      status: "pending",
      providerReference: "fund_b2b_123",
      checkoutUrl: "https://checkout.paystack.com/b2b",
      correlationId: "corr_b2b",
      metadata: {
        product: "b2b_self_topup",
        partnerId: "partner_1",
        requestedAmount: 5000,
        requestedCurrency: "KES",
      },
    });
  });

  it("creates KES Paystack checkout for partner self-topup", async () => {
    const response = await b2bFundingBridge.createB2bSelfTopupCheckout({
      partnerId: "partner_1",
      actorUid: "uid_1",
      amount: 5000,
      currency: "KES",
      email: "ops@hotel.com",
    });

    expect(response).toMatchObject({
      orderId: "fund_b2b_123",
      invoiceId: "fund_b2b_123",
      amount: 5000,
      currency: "KES",
      checkoutUrl: "https://checkout.paystack.com/b2b",
      partnerId: "partner_1",
      provider: "paystack",
    });

    expect(fundingOrderService.createFundingOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "uid_1",
          amount: 5000,
          currency: "KES",
          metadata: expect.objectContaining({
            product: "b2b_self_topup",
            partnerId: "partner_1",
          }),
        }),
    );

    expect(fundingRailService.initializePayment).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "paystack",
          amount: 5000,
          currency: "KES",
          email: "ops@hotel.com",
          metadata: expect.objectContaining({ product: "b2b_self_topup" }),
        }),
    );
  });

  it("rejects non-KES currency", async () => {
    await expect(b2bFundingBridge.createB2bSelfTopupCheckout({
      partnerId: "partner_1",
      actorUid: "uid_1",
      amount: 100,
      currency: "USD",
    })).rejects.toThrow(/KES only/);
  });

  it("rejects invalid amount", async () => {
    await expect(b2bFundingBridge.createB2bSelfTopupCheckout({
      partnerId: "partner_1",
      actorUid: "uid_1",
      amount: 0,
      currency: "KES",
    })).rejects.toThrow(/amount must be/);
  });
});
