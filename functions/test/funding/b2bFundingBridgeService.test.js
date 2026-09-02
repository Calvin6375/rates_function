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
jest.mock("../../services/pricing/productPricingService", () => ({
  computeLocalTopupPaystackCharge: jest.fn(),
}));

const fundingOrderService = require("../../services/funding/fundingOrderService");
const fundingRailService = require("../../services/funding/fundingRailService");
const fundingIdempotencyService = require("../../services/funding/fundingIdempotencyService");
const productPricingService = require("../../services/pricing/productPricingService");
const b2bFundingBridge = require("../../services/funding/b2bFundingBridgeService");

describe("b2bFundingBridgeService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fundingIdempotencyService.lookupIdempotencyKey.mockResolvedValue(null);
    fundingIdempotencyService.claimIdempotencyKey.mockResolvedValue({ duplicate: false });
    productPricingService.computeLocalTopupPaystackCharge.mockResolvedValue({
      creditAmountKes: 5000,
      feeAmount: 0,
      chargeAmountKes: 5000,
      applied: false,
      feePercent: 0,
      flatFee: 0,
      pricingProductKey: "local_topup",
      reason: "not_enabled",
      source: "defaults",
    });
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

  it("posts face + fee to Paystack and credits face amount when local_topup live", async () => {
    productPricingService.computeLocalTopupPaystackCharge.mockResolvedValue({
      creditAmountKes: 50,
      feeAmount: 1.25,
      chargeAmountKes: 51.25,
      applied: true,
      feePercent: 2.5,
      flatFee: 0,
      pricingProductKey: "local_topup",
      reason: null,
      source: "config/productPricing",
    });
    fundingOrderService.createFundingOrder.mockResolvedValue({
      id: "fund_b2b_fee",
      amount: 51.25,
      currency: "KES",
      providerReference: "fund_b2b_fee",
      metadata: {
        product: "b2b_self_topup",
        partnerId: "partner_1",
        requestedAmount: 50,
        requestedCurrency: "KES",
        feeAmount: 1.25,
        pricingProductKey: "local_topup",
      },
    });
    fundingOrderService.updateFundingOrder.mockResolvedValue({
      id: "fund_b2b_fee",
      amount: 51.25,
      currency: "KES",
      checkoutUrl: "https://checkout.paystack.com/b2b",
      providerReference: "fund_b2b_fee",
      metadata: {
        product: "b2b_self_topup",
        partnerId: "partner_1",
        requestedAmount: 50,
        requestedCurrency: "KES",
        feeAmount: 1.25,
        pricingProductKey: "local_topup",
      },
    });

    const response = await b2bFundingBridge.createB2bSelfTopupCheckout({
      partnerId: "partner_1",
      actorUid: "uid_1",
      amount: 50,
      currency: "KES",
    });

    expect(fundingOrderService.createFundingOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 51.25,
          metadata: expect.objectContaining({
            requestedAmount: 50,
            feeAmount: 1.25,
            pricingProductKey: "local_topup",
          }),
        }),
    );
    expect(fundingRailService.initializePayment).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 51.25 }),
    );
    expect(response).toMatchObject({
      amount: 50,
      youReceive: 50,
      paystackAmount: 51.25,
      totalToPay: 51.25,
      feeAmount: 1.25,
    });
  });
});
