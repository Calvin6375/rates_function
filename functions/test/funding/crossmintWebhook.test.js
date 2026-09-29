/**
 * @fileoverview Crossmint webhook: Svix, ignore payment.succeeded, process delivery.completed once.
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
const { handleCrossmintWebhookRequest } = require("../../http/crossmintWebhookHttp");

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

describe("crossmint webhook", () => {
  const payload = {
    actionId: "cm_order_1",
    type: "orders.delivery.completed",
    data: { orderId: "cm_order_1", phase: "completed" },
  };
  const raw = Buffer.from(JSON.stringify(payload));

  beforeEach(() => {
    jest.clearAllMocks();
    fundingRailService.verifyWebhookSignature.mockReturnValue(true);
    fundingRailService.normalizeWebhook.mockReturnValue({
      providerReference: "cm_order_1",
      providerTransactionId: "cm_order_1",
      amount: 10,
      currency: "USD",
      status: "success",
    });
    webhookReceiptService.persistReceipt.mockResolvedValue({
      receiptId: "crossmint_msg_1",
      duplicate: false,
      status: "received",
    });
    fundingWebhookService.processFundingEvent.mockResolvedValue({ success: true });
  });

  it("rejects an invalid signature with 403", async () => {
    fundingRailService.verifyWebhookSignature.mockReturnValue(false);
    const res = mockRes();
    await handleCrossmintWebhookRequest({
      method: "POST",
      body: raw,
      get: () => "msg_1",
    }, res);
    expect(res.statusCode).toBe(403);
    expect(fundingWebhookService.processFundingEvent).not.toHaveBeenCalled();
  });

  it("processes delivery.completed with the Crossmint order id", async () => {
    const res = mockRes();
    await handleCrossmintWebhookRequest({
      method: "POST",
      body: raw,
      get: (name) => (String(name).toLowerCase() === "svix-id" ? "msg_1" : null),
    }, res);
    expect(fundingWebhookService.processFundingEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "crossmint",
          event: expect.objectContaining({ providerReference: "cm_order_1" }),
        }),
    );
    expect(res.statusCode).toBe(200);
  });

  it("acks payment.succeeded without completing the funding order", async () => {
    fundingRailService.normalizeWebhook.mockReturnValue(null);
    const res = mockRes();
    await handleCrossmintWebhookRequest({
      method: "POST",
      body: Buffer.from(JSON.stringify({
        actionId: "cm_order_1",
        type: "orders.payment.succeeded",
      })),
      get: () => "msg_2",
    }, res);
    expect(res.statusCode).toBe(200);
    expect(fundingWebhookService.processFundingEvent).not.toHaveBeenCalled();
  });

  it("skips a duplicate processed receipt", async () => {
    webhookReceiptService.persistReceipt.mockResolvedValue({
      receiptId: "crossmint_msg_1",
      duplicate: true,
      status: "processed",
    });
    const res = mockRes();
    await handleCrossmintWebhookRequest({
      method: "POST",
      body: raw,
      get: () => "msg_1",
    }, res);
    expect(fundingWebhookService.processFundingEvent).not.toHaveBeenCalled();
    expect(res.body).toMatch(/Already processed/);
  });
});
