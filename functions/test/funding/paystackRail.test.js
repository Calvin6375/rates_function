/**
 * @fileoverview Unit tests for Paystack Funding Provider adapter.
 */

const crypto = require("crypto");
const paystackRail = require("../../services/funding/paystackRail");
const { registerFundingProviders } = require("../../services/funding/fundingProviderInterface");

describe("paystackRail", () => {
  it("implements the Funding Provider interface", () => {
    expect(() => registerFundingProviders({ paystack: paystackRail })).not.toThrow();
    expect(paystackRail.providerId).toBe("paystack");
  });

  it("normalizes successful webhook payload", () => {
    const event = paystackRail.normalizeWebhook({
      event: "charge.success",
      data: {
        id: 123456,
        reference: "tp_ref_abc",
        amount: 10000,
        currency: "USD",
        status: "success",
      },
    });

    expect(event).toEqual({
      providerReference: "tp_ref_abc",
      providerTransactionId: "123456",
      amount: 100,
      currency: "USD",
      status: "success",
      failureReason: null,
    });
  });

  it("returns null for non-charge events", () => {
    expect(paystackRail.normalizeWebhook({ event: "transfer.success", data: {} })).toBeNull();
  });

  it("verifies webhook signature", () => {
    process.env.PAYSTACK_SECRET_KEY = "test_secret";
    const body = JSON.stringify({ event: "charge.success", data: { reference: "x" } });
    const signature = crypto.createHmac("sha512", "test_secret").update(body).digest("hex");

    const req = {
      get: (name) => (name.toLowerCase() === "x-paystack-signature" ? signature : null),
    };

    expect(paystackRail.verifyWebhookSignature(req, Buffer.from(body))).toBe(true);
    delete process.env.PAYSTACK_SECRET_KEY;
  });

  it("rejects invalid webhook signature", () => {
    process.env.PAYSTACK_SECRET_KEY = "test_secret";
    const req = { get: () => "bad_signature" };
    expect(paystackRail.verifyWebhookSignature(req, Buffer.from("{}"))).toBe(false);
    delete process.env.PAYSTACK_SECRET_KEY;
  });
});
