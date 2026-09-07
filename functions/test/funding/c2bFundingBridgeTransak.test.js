/**
 * @fileoverview Unit tests for Transak path in C2B funding bridge.
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
  resolveFundingCustomerEmail: jest.fn(async (_uid, extras = {}) => ({
    email: extras.clientEmail || "tourist@example.com",
    usedFallback: false,
    corrected: false,
    source: "client",
  })),
}));

const fundingOrderService = require("../../services/funding/fundingOrderService");
const fundingRailService = require("../../services/funding/fundingRailService");
const fundingIdempotencyService = require("../../services/funding/fundingIdempotencyService");
const { convertToKesForPaystack } = require("../../services/funding/c2bFundingFxService");
const productPricingService = require("../../services/pricing/productPricingService");
const c2bFundingBridge = require("../../services/funding/c2bFundingBridgeService");
const config = require("../../config");

describe("c2bFundingBridgeService transak", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    config.funding.defaultProvider = "transak";
    process.env.TRANSAK_TREASURY_WALLET = "0xTreasuryWallet";
    config.transak.treasuryWallet = "0xTreasuryWallet";

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

    fundingIdempotencyService.lookupIdempotencyKey.mockResolvedValue(null);
    fundingIdempotencyService.claimIdempotencyKey.mockResolvedValue({ duplicate: false });
    fundingOrderService.generateFundingOrderId.mockReturnValue("fund_transak_123");
    fundingOrderService.createFundingOrder.mockResolvedValue({
      id: "fund_transak_123",
      userId: "user_1",
      provider: "transak",
      amount: 25,
      currency: "USD",
      status: "pending",
      providerReference: "fund_transak_123",
      correlationId: "corr_transak",
      metadata: {
        product: "tourist",
        requestedAmount: 25,
        requestedCurrency: "USD",
        treasuryWallet: "0xTreasuryWallet",
        cryptoCurrency: "USDT",
      },
    });
    fundingRailService.initializePayment.mockResolvedValue({
      checkoutUrl: "https://global-stg.transak.com?sessionId=test",
      providerReference: "fund_transak_123",
      providerTransactionId: "quote_123",
      raw: {
        treasuryWallet: "0xTreasuryWallet",
        quote: { quoteId: "quote_123", cryptoAmount: 24.8 },
      },
    });
    fundingOrderService.updateFundingOrder.mockResolvedValue({
      id: "fund_transak_123",
      userId: "user_1",
      provider: "transak",
      amount: 25,
      currency: "USD",
      status: "pending",
      providerReference: "fund_transak_123",
      checkoutUrl: "https://global-stg.transak.com?sessionId=test",
      correlationId: "corr_transak",
      metadata: {
        requestedAmount: 25,
        requestedCurrency: "USD",
        treasuryWallet: "0xTreasuryWallet",
        cryptoCurrency: "USDT",
        quoteId: "quote_123",
        cryptoAmount: 24.8,
      },
    });
  });

  afterEach(() => {
    config.funding.defaultProvider = "paystack";
    delete process.env.TRANSAK_TREASURY_WALLET;
    config.transak.treasuryWallet = null;
  });

  it("creates USD funding order without Paystack FX conversion via Transak helper", async () => {
    const response = await c2bFundingBridge.createC2bTransakTopupCheckout({
      userId: "user_1",
      amount: 25,
      currency: "USD",
      email: "tourist@example.com",
      transakAccessToken: "user_access_token",
    });

    expect(response).toMatchObject({
      success: true,
      orderId: "fund_transak_123",
      amount: 25,
      currency: "USD",
      paystackAmount: 25,
      paystackCurrency: "USD",
      checkoutUrl: "https://global-stg.transak.com?sessionId=test",
      provider: "transak",
    });

    expect(convertToKesForPaystack).not.toHaveBeenCalled();
    expect(fundingOrderService.createFundingOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "transak",
          amount: 25,
          currency: "USD",
          metadata: expect.objectContaining({
            product: "tourist",
            treasuryWallet: "0xTreasuryWallet",
            cryptoCurrency: "USDT",
          }),
        }),
    );
    expect(fundingRailService.initializePayment).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "transak",
          amount: 25,
          currency: "USD",
          transakAccessToken: "user_access_token",
        }),
    );
  });

  it("routes createC2bTopupCheckout to Paystack even when defaultProvider is transak", async () => {
    config.funding.defaultProvider = "transak";
    convertToKesForPaystack.mockResolvedValue({
      requestedAmount: 25,
      requestedCurrency: "USD",
      amountKes: 3250,
      paystackCurrency: "KES",
      fxRate: 130,
    });
    fundingOrderService.createFundingOrder.mockResolvedValue({
      id: "fund_paystack_123",
      userId: "user_1",
      provider: "paystack",
      amount: 3250,
      currency: "KES",
      status: "pending",
      providerReference: "fund_paystack_123",
      metadata: { requestedAmount: 25, requestedCurrency: "USD" },
    });
    fundingOrderService.updateFundingOrder.mockResolvedValue({
      id: "fund_paystack_123",
      provider: "paystack",
      amount: 3250,
      currency: "KES",
      checkoutUrl: "https://checkout.paystack.com/test",
      providerReference: "fund_paystack_123",
      metadata: { requestedAmount: 25, requestedCurrency: "USD" },
    });
    fundingRailService.initializePayment.mockResolvedValue({
      checkoutUrl: "https://checkout.paystack.com/test",
      providerReference: "fund_paystack_123",
    });

    const response = await c2bFundingBridge.createC2bTopupCheckout({
      userId: "user_1",
      amount: 25,
      currency: "USD",
      provider: "transak",
    });

    expect(convertToKesForPaystack).toHaveBeenCalledWith(25, "USD");
    expect(response.provider).toBe("paystack");
    expect(response.paystackCurrency).toBe("KES");
  });
});
