/**
 * @fileoverview Grid webhook handler: signature, idempotency, and no client-side credit.
 */

jest.mock("../../services/funding/fundingRailService");
jest.mock("../../services/funding/fundingWebhookService");
jest.mock("../../services/funding/gridAccountService", () => ({
  resolveFundingOrder: jest.fn(),
}));
jest.mock("../../services/ops/opsMetricsService", () => ({
  increment: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../services/ops/webhookReceiptService", () => ({
  persistReceipt: jest.fn(),
  updateReceiptStatus: jest.fn().mockResolvedValue(undefined),
}));

const fundingRailService = require("../../services/funding/fundingRailService");
const fundingWebhookService = require("../../services/funding/fundingWebhookService");
const gridAccountService = require("../../services/funding/gridAccountService");
const webhookReceiptService = require("../../services/ops/webhookReceiptService");
const { handleGridWebhookRequest } = require("../../http/gridWebhookHttp");

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

describe("grid webhook", () => {
  const payload = {
    id: "Webhook:1",
    type: "INCOMING_PAYMENT.COMPLETED",
    data: { id: "Transaction:tx1" },
  };
  const raw = Buffer.from(JSON.stringify(payload));

  beforeEach(() => {
    jest.clearAllMocks();
    fundingRailService.verifyWebhookSignature.mockReturnValue(true);
    fundingRailService.normalizeWebhook.mockReturnValue({
      provider: "grid",
      providerReference: "",
      providerTransactionId: "Transaction:tx1",
      amount: 100,
      currency: "USD",
      status: "success",
      customerId: "Customer:c1",
      platformCustomerId: "user_1",
    });
    webhookReceiptService.persistReceipt.mockResolvedValue({
      receiptId: "grid_Webhook:1",
      duplicate: false,
      status: "received",
    });
    gridAccountService.resolveFundingOrder.mockResolvedValue({
      id: "fund_grid_1",
      userId: "user_1",
      provider: "grid",
      providerReference: "fund_grid_1",
      status: "pending",
    });
    fundingWebhookService.processFundingEvent.mockResolvedValue({
      success: true,
      duplicate: false,
      fundingOrderId: "fund_grid_1",
    });
  });

  it("rejects a missing signature", async () => {
    fundingRailService.verifyWebhookSignature.mockReturnValue(false);
    const res = mockRes();
    await handleGridWebhookRequest({
      method: "POST",
      body: raw,
      get: () => "",
    }, res);
    expect(res.statusCode).toBe(401);
    expect(fundingWebhookService.processFundingEvent).not.toHaveBeenCalled();
  });

  it("passes a normalized event into fundingWebhookService once", async () => {
    const res = mockRes();
    await handleGridWebhookRequest({ method: "POST", body: raw }, res);

    expect(fundingWebhookService.processFundingEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "grid",
          webhookEventId: "Webhook:1",
          event: expect.objectContaining({
            providerReference: "fund_grid_1",
            providerTransactionId: "Transaction:tx1",
            status: "success",
          }),
        }),
    );
    expect(res.statusCode).toBe(200);
  });

  it("does not process a duplicate event again", async () => {
    webhookReceiptService.persistReceipt.mockResolvedValue({
      receiptId: "grid_Webhook:1",
      duplicate: true,
      status: "processed",
    });
    const res = mockRes();
    await handleGridWebhookRequest({ method: "POST", body: raw }, res);

    expect(fundingWebhookService.processFundingEvent).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/Already processed/);
  });

  it("does not credit when no funding order matches", async () => {
    gridAccountService.resolveFundingOrder.mockResolvedValue(null);
    const res = mockRes();
    await handleGridWebhookRequest({ method: "POST", body: raw }, res);

    expect(fundingWebhookService.processFundingEvent).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/No matching order/);
  });
});
