/**
 * @fileoverview Integration-style tests for fundingWebhookService with Transak events.
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

describe("fundingWebhookService transak", () => {
  const order = {
    id: "fund_transak_1",
    userId: "user_1",
    provider: "transak",
    amount: 25,
    currency: "USD",
    status: "pending",
    providerReference: "fund_transak_1",
    correlationId: "corr_1",
    metadata: { product: "tourist", treasuryWallet: "0xTreasury" },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    fundingOrderService.findByProviderReference.mockResolvedValue(order);
    fundingRailService.verifyPayment.mockResolvedValue({
      providerReference: "fund_transak_1",
      providerTransactionId: "order_99",
      amount: 25,
      currency: "USD",
      status: "success",
    });
    transactionService.completeFundingOrder.mockResolvedValue({
      success: true,
      transactionRecordId: "txn_1",
    });
  });

  it("completes funding order after server-side verification (no direct ledger in webhook)", async () => {
    const result = await fundingWebhookService.processFundingEvent({
      provider: "transak",
      event: {
        providerReference: "fund_transak_1",
        providerTransactionId: "order_99",
        amount: 25,
        currency: "USD",
        status: "success",
      },
      webhookEventId: "evt_1",
      receiptId: "receipt_1",
    });

    expect(result.success).toBe(true);
    expect(fundingRailService.verifyPayment).toHaveBeenCalledWith(
        "transak",
        "fund_transak_1",
        expect.objectContaining({ fundingOrderId: "fund_transak_1" }),
    );
    expect(transactionService.completeFundingOrder).toHaveBeenCalledWith({
      fundingOrder: order,
      verifiedEvent: expect.objectContaining({ status: "success", amount: 25 }),
    });
  });

  it("returns duplicate when order already completed (no double credit)", async () => {
    fundingOrderService.findByProviderReference.mockResolvedValue({
      ...order,
      status: "completed",
      transactionRecordId: "txn_existing",
    });

    const result = await fundingWebhookService.processFundingEvent({
      provider: "transak",
      event: {
        providerReference: "fund_transak_1",
        providerTransactionId: "order_99",
        amount: 25,
        currency: "USD",
        status: "success",
      },
      webhookEventId: "evt_dup",
    });

    expect(result.duplicate).toBe(true);
    expect(transactionService.completeFundingOrder).not.toHaveBeenCalled();
  });

  it("rejects amount mismatch after verification", async () => {
    fundingRailService.verifyPayment.mockResolvedValue({
      providerReference: "fund_transak_1",
      providerTransactionId: "order_99",
      amount: 30,
      currency: "USD",
      status: "success",
    });

    const result = await fundingWebhookService.processFundingEvent({
      provider: "transak",
      event: {
        providerReference: "fund_transak_1",
        providerTransactionId: "order_99",
        amount: 25,
        currency: "USD",
        status: "success",
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Verified amount mismatch");
    expect(transactionService.completeFundingOrder).not.toHaveBeenCalled();
  });
});
