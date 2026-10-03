/**
 * @fileoverview USD createPayment routes to PayLio when configured. KES stays on Paystack.
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

function pendingOrder(overrides = {}) {
  return {
    id: "fund_pl_1",
    userId: "user_1",
    provider: "paylio",
    amount: 49.99,
    currency: "USD",
    status: "pending",
    providerReference: "fund_pl_1",
    correlationId: "corr_pl",
    metadata: {
      product: "tourist",
      requestedAmount: 49.99,
      requestedCurrency: "USD",
    },
    ...overrides,
  };
}

describe("c2bFundingBridgeService paylio", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FUNDING_USD_PROVIDER = "paylio";
    fundingIdempotencyService.lookupIdempotencyKey.mockResolvedValue(null);
    fundingIdempotencyService.claimIdempotencyKey.mockResolvedValue({ duplicate: false });
    fundingOrderService.generateFundingOrderId.mockReturnValue("fund_pl_1");
    fundingOrderService.getFundingOrderForUser.mockResolvedValue(null);
  });

  afterEach(() => {
    delete process.env.FUNDING_USD_PROVIDER;
  });

  it("creates a USD funding order on PayLio and returns the hosted checkout URL", async () => {
    fundingOrderService.createFundingOrder.mockResolvedValue(pendingOrder());
    fundingRailService.initializePayment.mockResolvedValue({
      checkoutUrl: "https://paylio.org/pay/clx_pay_1",
      providerReference: "ipn_token_1",
      providerTransactionId: "clx_pay_1",
      raw: {
        paymentId: "clx_pay_1",
        requestedAmount: 49.99,
        providerFee: 3.19,
        customerPayAmount: 53.18,
        netSettlementAmount: null,
        feePercent: 5,
        passFeeToCustomer: true,
        settlementCoin: "polygon_usdc",
      },
    });
    fundingOrderService.updateFundingOrder.mockImplementation(async (_id, patch) => pendingOrder({
      amount: patch.amount,
      providerReference: patch.providerReference,
      providerTransactionId: patch.providerTransactionId,
      checkoutUrl: patch.checkoutUrl,
      metadata: patch.metadata,
    }));

    const response = await c2bFundingBridge.createC2bTopupCheckout({
      userId: "user_1",
      amount: 49.99,
      currency: "USD",
      email: "tourist@example.com",
      idempotencyKey: "idem_1",
    });

    expect(convertToKesForPaystack).not.toHaveBeenCalled();
    expect(fundingOrderService.createFundingOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "paylio",
          amount: 49.99,
          currency: "USD",
        }),
    );
    expect(fundingRailService.initializePayment).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "paylio",
          amount: 49.99,
          currency: "USD",
          fundingOrderId: "fund_pl_1",
        }),
    );
    expect(fundingOrderService.updateFundingOrder).toHaveBeenCalledWith(
        "fund_pl_1",
        expect.objectContaining({
          providerReference: "ipn_token_1",
          providerTransactionId: "clx_pay_1",
          checkoutUrl: "https://paylio.org/pay/clx_pay_1",
          amount: 53.18,
          metadata: expect.objectContaining({
            requestedAmount: 49.99,
            providerFee: 3.19,
            customerPayAmount: 53.18,
            feeAmount: 3.19,
            passFeeToCustomer: true,
          }),
        }),
    );
    expect(response).toMatchObject({
      success: true,
      provider: "paylio",
      orderId: "fund_pl_1",
      invoiceId: "ipn_token_1",
      amount: 49.99,
      youReceive: 49.99,
      currency: "USD",
      feeAmount: 3.19,
      totalToPay: 53.18,
      checkoutUrl: "https://paylio.org/pay/clx_pay_1",
      url: "https://paylio.org/pay/clx_pay_1",
      authorization_url: "https://paylio.org/pay/clx_pay_1",
    });
  });

  it("keeps KES on Paystack when the USD provider is PayLio", async () => {
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

  it("marks the funding order failed when PayLio initialization fails", async () => {
    fundingOrderService.createFundingOrder.mockResolvedValue(pendingOrder());
    fundingRailService.initializePayment.mockRejectedValue(new Error("PayLio 400: Invalid wallet"));

    await expect(c2bFundingBridge.createC2bTopupCheckout({
      userId: "user_1",
      amount: 49.99,
      currency: "USD",
    })).rejects.toThrow("PayLio 400");

    expect(fundingOrderService.updateFundingOrder).toHaveBeenCalledWith(
        "fund_pl_1",
        expect.objectContaining({ status: "failed" }),
    );
  });

  it("does not create a second PayLio checkout for the same idempotency key", async () => {
    fundingIdempotencyService.lookupIdempotencyKey.mockResolvedValue({ fundingOrderId: "fund_pl_1" });
    fundingOrderService.getFundingOrderForUser.mockResolvedValue(pendingOrder({
      providerReference: "ipn_token_1",
      checkoutUrl: "https://paylio.org/pay/clx_pay_1",
      metadata: {
        requestedAmount: 49.99,
        requestedCurrency: "USD",
        feeAmount: 3.19,
        customerPayAmount: 53.18,
      },
      amount: 53.18,
    }));

    const response = await c2bFundingBridge.createC2bTopupCheckout({
      userId: "user_1",
      amount: 49.99,
      currency: "USD",
      idempotencyKey: "idem_1",
    });

    expect(fundingRailService.initializePayment).not.toHaveBeenCalled();
    expect(fundingOrderService.createFundingOrder).not.toHaveBeenCalled();
    expect(response.duplicate).toBe(true);
    expect(response.checkoutUrl).toBe("https://paylio.org/pay/clx_pay_1");
  });
});
