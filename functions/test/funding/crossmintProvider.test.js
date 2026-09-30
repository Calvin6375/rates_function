/**
 * @fileoverview Crossmint Onramp adapter: documented create-order body, delivery credit rule, Svix.
 */

jest.mock("../../services/funding/providers/crossmintApi", () => ({
  CrossmintApiError: class CrossmintApiError extends Error {
    constructor(message) {
      super(message);
      this.name = "CrossmintApiError";
    }
  },
  collectionWallet: jest.fn(() => "0xCollectionWallet"),
  tokenLocator: jest.fn(() => "base-sepolia:0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
  chain: jest.fn(() => "base-sepolia"),
  userLocator: jest.fn(() => "email:ops@truepay.africa"),
  createOrder: jest.fn(),
  getOrder: jest.fn(),
  linkWallet: jest.fn(),
  buildEmbeddedCheckoutUrl: jest.fn(() => "https://staging.crossmint.com/sdk/2024-03-05/embedded-checkout?orderId=cm1"),
  webhookSecret: jest.fn(() => process.env.CROSSMINT_WEBHOOK_SECRET || ""),
}));

const crypto = require("crypto");
const { registerFundingProviders } = require("../../services/funding/fundingProviderInterface");
const crossmintApi = require("../../services/funding/providers/crossmintApi");
const crossmintProvider = require("../../services/funding/providers/crossmintProvider");

function completedOrder(overrides = {}) {
  return {
    orderId: "cm_order_1",
    phase: "completed",
    lineItems: [{
      executionParams: { mode: "exact-in", amount: "10.00" },
      quote: { totalPrice: { amount: "10.00", currency: "usd" } },
      delivery: {
        status: "completed",
        recipient: { walletAddress: "0xCollectionWallet" },
        txId: "0xtx",
      },
    }],
    payment: {
      status: "completed",
      received: { amount: "10.00", currency: "usd" },
    },
    ...overrides,
  };
}

describe("crossmintProvider", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    crossmintProvider.resetLinkCacheForTests();
    process.env.CROSSMINT_WEBHOOK_SECRET = "whsec_dGVzdHNlY3JldA==";
    crossmintApi.createOrder.mockResolvedValue({
      clientSecret: "cs_live",
      order: { orderId: "cm_order_1", phase: "payment" },
    });
    crossmintApi.linkWallet.mockResolvedValue({ ownership: { verified: false } });
  });

  afterEach(() => {
    delete process.env.CROSSMINT_WEBHOOK_SECRET;
  });

  it("registers as a funding provider", () => {
    expect(() => registerFundingProviders({ crossmint: crossmintProvider })).not.toThrow();
    expect(crossmintProvider.providerId).toBe("crossmint");
  });

  it("creates an onramp order with the documented body and links the wallet once", async () => {
    const first = await crossmintProvider.initializePayment({
      amount: 10,
      currency: "USD",
      email: "ruben@gmail.com",
      userId: "user_1",
      fundingOrderId: "fund_1",
    });
    await crossmintProvider.initializePayment({
      amount: 5,
      currency: "USD",
      email: "ruben@gmail.com",
      userId: "user_1",
      fundingOrderId: "fund_2",
    });

    expect(crossmintApi.linkWallet).toHaveBeenCalledTimes(1);
    expect(crossmintApi.linkWallet).toHaveBeenCalledWith(
        expect.objectContaining({
          userLocator: "email:ops@truepay.africa",
          address: "0xCollectionWallet",
          chain: "base-sepolia",
        }),
        expect.any(Object),
    );
    expect(crossmintApi.createOrder).toHaveBeenCalledWith({
      lineItems: [{
        tokenLocator: "base-sepolia:0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        executionParameters: { mode: "exact-in", amount: "10.00" },
      }],
      payment: { method: "card", receiptEmail: "ruben@gmail.com" },
      recipient: { walletAddress: "0xCollectionWallet" },
    }, expect.any(Object));
    expect(first).toMatchObject({
      providerReference: "cm_order_1",
      providerTransactionId: "cm_order_1",
      raw: {
        orderId: "cm_order_1",
        clientSecret: "cs_live",
      },
    });
    expect(JSON.stringify(first.raw)).toContain("cs_live");
  });

  it("credits only when phase, payment, and delivery are completed", async () => {
    crossmintApi.getOrder.mockResolvedValue(completedOrder());
    await expect(crossmintProvider.verifyPayment("cm_order_1")).resolves.toMatchObject({
      status: "success",
      amount: 10,
      currency: "USD",
      providerReference: "cm_order_1",
    });

    crossmintApi.getOrder.mockResolvedValue(completedOrder({
      phase: "delivery",
      lineItems: [{
        executionParams: { amount: "10.00" },
        delivery: { status: "in-progress", recipient: { walletAddress: "0xCollectionWallet" } },
      }],
    }));
    await expect(crossmintProvider.verifyPayment("cm_order_1")).resolves.toMatchObject({
      status: "pending",
    });
  });

  it("normalizes delivery.completed and ignores payment.succeeded", () => {
    expect(crossmintProvider.normalizeWebhook({
      actionId: "cm_order_1",
      type: "orders.delivery.completed",
      data: completedOrder(),
    })).toMatchObject({
      status: "success",
      providerReference: "cm_order_1",
      amount: 10,
    });
    expect(crossmintProvider.normalizeWebhook({
      actionId: "cm_order_1",
      type: "orders.payment.succeeded",
      data: completedOrder({ phase: "delivery" }),
    })).toBeNull();
    expect(crossmintProvider.normalizeWebhook({
      actionId: "cm_order_1",
      type: "orders.payment.failed",
      data: completedOrder(),
    }).status).toBe("failed");
  });

  it("verifies Svix signatures from the raw body", () => {
    const body = Buffer.from(JSON.stringify({ actionId: "cm_order_1", type: "orders.delivery.completed" }));
    const svixId = "msg_1";
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const signedContent = `${svixId}.${svixTimestamp}.${body.toString("utf8")}`;
    const secretBytes = Buffer.from("dGVzdHNlY3JldA==", "base64");
    const signature = crypto.createHmac("sha256", secretBytes).update(signedContent).digest("base64");
    const req = {
      get: (name) => ({
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": `v1,${signature}`,
      }[String(name).toLowerCase()]),
    };
    expect(crossmintProvider.verifyWebhookSignature(req, body)).toBe(true);
    expect(crossmintProvider.verifyWebhookSignature(req, Buffer.from("tampered"))).toBe(false);
  });
});
