/**
 * @fileoverview PayLio funding completion is webhook/verify only. Browser confirm does not credit.
 */

jest.mock("../../services/funding/fundingOrderService");
jest.mock("../../services/funding/fundingRailService");
jest.mock("../../services/transactionService");
jest.mock("../../services/ops/webhookReceiptService");
jest.mock("../../services/ops/paymentTimelineService", () => ({
  recordEvent: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../services/ops/opsMetricsService", () => ({
  increment: jest.fn().mockResolvedValue(undefined),
  recordTiming: jest.fn().mockResolvedValue(undefined),
  recordFundingVolume: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../services/ops/paymentNotificationService", () => ({
  notifyFundingCompleted: jest.fn().mockResolvedValue(undefined),
  notifyFundingFailed: jest.fn().mockResolvedValue(undefined),
}));

const fundingOrderService = require("../../services/funding/fundingOrderService");
const fundingRailService = require("../../services/funding/fundingRailService");
const transactionService = require("../../services/transactionService");
const fundingWebhookService = require("../../services/funding/fundingWebhookService");

describe("fundingWebhookService paylio", () => {
  const order = {
    id: "fund_pl_1",
    userId: "user_1",
    provider: "paylio",
    amount: 53.18,
    currency: "USD",
    status: "pending",
    providerReference: "ipn_token_1",
    correlationId: "corr_1",
    metadata: {
      product: "tourist",
      requestedAmount: 49.99,
      requestedCurrency: "USD",
      providerFee: 3.19,
      customerPayAmount: 53.18,
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    fundingOrderService.findByProviderReference.mockResolvedValue(order);
    fundingOrderService.getFundingOrderForUser.mockResolvedValue(order);
    fundingRailService.verifyPayment.mockResolvedValue({
      providerReference: "ipn_token_1",
      providerTransactionId: "clx_pay_1",
      amount: 53.18,
      currency: "USD",
      status: "success",
    });
    transactionService.completeFundingOrder.mockResolvedValue({
      success: true,
      transactionRecordId: "txn_1",
    });
    transactionService.isB2bSelfTopupOrder.mockReturnValue(false);
    transactionService.isB2bPaymentLinkOrder.mockReturnValue(false);
  });

  it("completes the funding order only after server-side verification", async () => {
    const result = await fundingWebhookService.processFundingEvent({
      provider: "paylio",
      event: {
        providerReference: "ipn_token_1",
        providerTransactionId: "clx_pay_1",
        amount: 53.18,
        currency: "USD",
        status: "success",
      },
      webhookEventId: "ipn_token_1",
      receiptId: "receipt_1",
    });

    expect(result.success).toBe(true);
    expect(fundingRailService.verifyPayment).toHaveBeenCalledWith(
        "paylio",
        "ipn_token_1",
        expect.objectContaining({ fundingOrderId: "fund_pl_1" }),
    );
    expect(transactionService.completeFundingOrder).toHaveBeenCalledTimes(1);
  });

  it("does not credit again when the order is already completed", async () => {
    fundingOrderService.findByProviderReference.mockResolvedValue({
      ...order,
      status: "completed",
      transactionRecordId: "txn_1",
    });

    const result = await fundingWebhookService.processFundingEvent({
      provider: "paylio",
      event: {
        providerReference: "ipn_token_1",
        amount: 53.18,
        currency: "USD",
        status: "success",
      },
      webhookEventId: "ipn_token_1",
    });

    expect(result.duplicate).toBe(true);
    expect(transactionService.completeFundingOrder).not.toHaveBeenCalled();
    expect(fundingRailService.verifyPayment).not.toHaveBeenCalled();
  });

  it("does not credit when the browser confirm endpoint is called without a webhook", async () => {
    const result = await fundingWebhookService.confirmFundingOrder("user_1", "fund_pl_1");

    expect(result).toMatchObject({
      success: false,
      pending: true,
      fundingOrderId: "fund_pl_1",
    });
    expect(fundingRailService.verifyPayment).not.toHaveBeenCalled();
    expect(transactionService.completeFundingOrder).not.toHaveBeenCalled();
  });
});
