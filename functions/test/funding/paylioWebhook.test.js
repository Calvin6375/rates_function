/**
 * @fileoverview PayLio GET callback: reject missing ipn_token, process paid once.
 */

jest.mock("../../services/funding/fundingRailService");
jest.mock("../../services/funding/fundingWebhookService");
jest.mock("../../services/ops/opsMetricsService", () => ({
  increment: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../services/ops/webhookReceiptService", () => ({
  persistReceipt: jest.fn(),
  updateReceiptStatus: jest.fn().mockResolvedValue(undefined),
}));

const fundingRailService = require("../../services/funding/fundingRailService");
const fundingWebhookService = require("../../services/funding/fundingWebhookService");
const webhookReceiptService = require("../../services/ops/webhookReceiptService");
const { handlePaylioWebhookRequest } = require("../../http/paylioWebhookHttp");

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

describe("paylio webhook", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fundingRailService.verifyWebhookSignature.mockReturnValue(true);
    fundingRailService.normalizeWebhook.mockReturnValue({
      providerReference: "ipn_token_1",
      providerTransactionId: "clx_pay_1",
      amount: 53.18,
      currency: "USD",
      status: "success",
    });
    webhookReceiptService.persistReceipt.mockResolvedValue({
      receiptId: "paylio_ipn_token_1",
      duplicate: false,
      status: "received",
    });
    fundingWebhookService.processFundingEvent.mockResolvedValue({
      success: true,
      fundingOrderId: "fund_pl_1",
    });
  });

  it("rejects a callback with no ipn_token", async () => {
    fundingRailService.verifyWebhookSignature.mockReturnValue(false);
    const res = mockRes();
    await handlePaylioWebhookRequest({
      method: "GET",
      query: { status: "paid", fundingOrderId: "fund_pl_1" },
    }, res);
    expect(res.statusCode).toBe(403);
    expect(fundingWebhookService.processFundingEvent).not.toHaveBeenCalled();
  });

  it("processes a paid callback through the funding webhook service", async () => {
    const res = mockRes();
    await handlePaylioWebhookRequest({
      method: "GET",
      query: {
        ipn_token: "ipn_token_1",
        status: "paid",
        fundingOrderId: "fund_pl_1",
      },
    }, res);
    expect(webhookReceiptService.persistReceipt).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "paylio",
          eventId: "ipn_token_1",
          fundingOrderId: "fund_pl_1",
        }),
    );
    expect(fundingWebhookService.processFundingEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "paylio",
          webhookEventId: "ipn_token_1",
          event: expect.objectContaining({ providerReference: "ipn_token_1", status: "success" }),
        }),
    );
    expect(res.statusCode).toBe(200);
  });

  it("does not process a duplicate receipt again", async () => {
    webhookReceiptService.persistReceipt.mockResolvedValue({
      receiptId: "paylio_ipn_token_1",
      duplicate: true,
      status: "processed",
    });
    const res = mockRes();
    await handlePaylioWebhookRequest({
      method: "GET",
      query: { ipn_token: "ipn_token_1", status: "paid" },
    }, res);
    expect(fundingWebhookService.processFundingEvent).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("OK - Already processed");
  });
});
