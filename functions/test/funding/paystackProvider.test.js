/**
 * @fileoverview Unit tests for Paystack Funding Provider adapter.
 */

jest.mock("axios");

const crypto = require("crypto");
const axios = require("axios");
const paystackProvider = require("../../services/funding/providers/paystackProvider");
const { registerFundingProviders } = require("../../services/funding/fundingProviderInterface");
const config = require("../../config");

describe("paystackProvider", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.PAYSTACK_SECRET_KEY = "test_secret";
    process.env.PAYSTACK_SPLIT_CODE = "SPL_test123";
    config.paystack.splitCode = "SPL_test123";
  });

  afterEach(() => {
    delete process.env.PAYSTACK_SECRET_KEY;
    delete process.env.PAYSTACK_SPLIT_CODE;
    delete process.env.PAYSTACK_B2B_SPLIT_CODE;
    delete process.env.PAYSTACK_CALLBACK_URL;
    config.paystack.splitCode = null;
    config.paystack.b2bSplitCode = null;
  });

  it("implements the Funding Provider interface", () => {
    expect(() => registerFundingProviders({ paystack: paystackProvider })).not.toThrow();
    expect(paystackProvider.providerId).toBe("paystack");
  });

  it("includes split_code and charges in KES for C2B", async () => {
    axios.post.mockResolvedValue({
      data: {
        status: true,
        data: {
          authorization_url: "https://checkout.paystack.com/abc",
          reference: "fund_123",
          access_code: "access_abc",
        },
      },
    });

    const result = await paystackProvider.initializePayment({
      amount: 200,
      currency: "KES",
      email: "tourist@example.com",
      providerReference: "fund_123",
      fundingOrderId: "fund_123",
      userId: "user_1",
      correlationId: "corr_1",
      callbackUrl: "https://app.truepay.africa/callback",
      metadata: { custom: "value" },
    });

    expect(result.checkoutUrl).toBe("https://checkout.paystack.com/abc");
    expect(result.providerReference).toBe("fund_123");

    const [url, payload, options] = axios.post.mock.calls[0];
    expect(url).toContain("/transaction/initialize");
    expect(payload.split_code).toBe("SPL_test123");
    expect(payload.reference).toBe("fund_123");
    expect(payload.amount).toBe(20000);
    expect(payload.currency).toBe("KES");
    expect(payload.callback_url).toBe("https://app.truepay.africa/callback");
    expect(payload.metadata).toMatchObject({
      fundingOrderId: "fund_123",
      correlationId: "corr_1",
      userId: "user_1",
      fundingProvider: "paystack",
      product: "tourist",
      custom: "value",
    });
    expect(options.headers.Authorization).toBe("Bearer test_secret");
    expect(payload.email).toBe("tourist@example.com");
  });

  it("corrects gmail.coma before initialize", async () => {
    axios.post.mockResolvedValue({
      data: {
        status: true,
        data: {
          authorization_url: "https://checkout.paystack.com/abc",
          reference: "fund_email",
          access_code: "access_abc",
        },
      },
    });

    await paystackProvider.initializePayment({
      amount: 1000,
      currency: "KES",
      email: "abdalaalifanax@gmail.coma",
      providerReference: "fund_email",
    });

    expect(axios.post.mock.calls[0][1].email).toBe("abdalaalifanax@gmail.com");
  });

  it("throws when split code is not configured", async () => {
    delete process.env.PAYSTACK_SPLIT_CODE;
    config.paystack.splitCode = null;

    await expect(paystackProvider.initializePayment({
      amount: 10,
      providerReference: "fund_no_split",
    })).rejects.toThrow("PAYSTACK_SPLIT_CODE");
  });

  it("allows B2B self-topup without split when none configured", async () => {
    delete process.env.PAYSTACK_SPLIT_CODE;
    delete process.env.PAYSTACK_B2B_SPLIT_CODE;
    config.paystack.splitCode = null;
    config.paystack.b2bSplitCode = null;

    axios.post.mockResolvedValue({
      data: {
        status: true,
        data: {
          authorization_url: "https://checkout.paystack.com/b2b",
          reference: "fund_b2b",
          access_code: "access_b2b",
        },
      },
    });

    await paystackProvider.initializePayment({
      amount: 5000,
      currency: "KES",
      providerReference: "fund_b2b",
      metadata: { product: "b2b_self_topup" },
    });

    const payload = axios.post.mock.calls[0][1];
    expect(payload.split_code).toBeUndefined();
    expect(payload.metadata.product).toBe("b2b_self_topup");
  });

  it("uses PAYSTACK_B2B_SPLIT_CODE for B2B self-topup when set", async () => {
    process.env.PAYSTACK_B2B_SPLIT_CODE = "SPL_b2b_only";
    config.paystack.b2bSplitCode = "SPL_b2b_only";

    axios.post.mockResolvedValue({
      data: {
        status: true,
        data: {
          authorization_url: "https://checkout.paystack.com/b2b",
          reference: "fund_b2b2",
          access_code: "access_b2b2",
        },
      },
    });

    await paystackProvider.initializePayment({
      amount: 1000,
      currency: "KES",
      providerReference: "fund_b2b2",
      metadata: { product: "b2b_self_topup" },
    });

    expect(axios.post.mock.calls[0][1].split_code).toBe("SPL_b2b_only");
  });

  it("throws when initialize fails", async () => {
    axios.post.mockResolvedValue({ data: { status: false, message: "Invalid email" } });

    await expect(paystackProvider.initializePayment({
      amount: 10,
      providerReference: "fund_fail",
    })).rejects.toThrow("Invalid email");
  });

  it("verifies successful payment", async () => {
    axios.get.mockResolvedValue({
      data: {
        status: true,
        data: {
          id: 999,
          reference: "fund_123",
          amount: 20000,
          currency: "KES",
          status: "success",
        },
      },
    });

    const event = await paystackProvider.verifyPayment("fund_123");
    expect(event).toEqual({
      providerReference: "fund_123",
      providerTransactionId: "999",
      amount: 200,
      currency: "KES",
      status: "success",
      failureReason: null,
    });
  });

  it("normalizes successful webhook payload", () => {
    const event = paystackProvider.normalizeWebhook({
      event: "charge.success",
      data: {
        id: 123456,
        reference: "fund_abc",
        amount: 10000,
        currency: "USD",
        status: "success",
      },
    });

    expect(event).toEqual({
      providerReference: "fund_abc",
      providerTransactionId: "123456",
      amount: 100,
      currency: "USD",
      status: "success",
      failureReason: null,
    });
  });

  it("returns null for non-charge events", () => {
    expect(paystackProvider.normalizeWebhook({ event: "transfer.success", data: {} })).toBeNull();
  });

  it("verifies webhook signature with secret key", () => {
    const body = JSON.stringify({ event: "charge.success", data: { reference: "x" } });
    const signature = crypto.createHmac("sha512", "test_secret").update(body).digest("hex");
    const req = {
      get: (name) => (name.toLowerCase() === "x-paystack-signature" ? signature : null),
    };

    expect(paystackProvider.verifyWebhookSignature(req, Buffer.from(body))).toBe(true);
  });

  it("rejects invalid webhook signature (replay attack)", () => {
    const req = { get: () => "bad_signature" };
    expect(paystackProvider.verifyWebhookSignature(req, Buffer.from("{}"))).toBe(false);
  });

  it("uses PAYSTACK_WEBHOOK_SECRET when set", () => {
    process.env.PAYSTACK_WEBHOOK_SECRET = "webhook_only_secret";
    const body = JSON.stringify({ event: "charge.success" });
    const signature = crypto.createHmac("sha512", "webhook_only_secret").update(body).digest("hex");
    const req = {
      get: (name) => (name.toLowerCase() === "x-paystack-signature" ? signature : null),
    };

    expect(paystackProvider.verifyWebhookSignature(req, Buffer.from(body))).toBe(true);
    delete process.env.PAYSTACK_WEBHOOK_SECRET;
  });
});
