/**
 * @fileoverview Unit tests for Paystack callback URL helpers.
 */

const fundingCallbackService = require("../../services/funding/fundingCallbackService");

describe("fundingCallbackService", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, GCLOUD_PROJECT: "truepay-72060" };
    delete process.env.PAYSTACK_CALLBACK_URL;
    delete process.env.C2B_API_BASE_URL;
    delete process.env.C2B_APP_DEEP_LINK;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("builds default hosted callback URL on api function", () => {
    expect(fundingCallbackService.buildDefaultPaystackCallbackUrl()).toBe(
        "https://us-central1-truepay-72060.cloudfunctions.net/api/funding/payment-return",
    );
  });

  it("uses PAYSTACK_CALLBACK_URL when set", () => {
    process.env.PAYSTACK_CALLBACK_URL = "https://custom.example/callback";
    expect(fundingCallbackService.resolvePaystackCallbackUrl()).toBe(
        "https://custom.example/callback",
    );
  });

  it("prefers explicit callback over env", () => {
    process.env.PAYSTACK_CALLBACK_URL = "https://custom.example/callback";
    expect(fundingCallbackService.resolvePaystackCallbackUrl("https://override.example/x"))
        .toBe("https://override.example/x");
  });

  it("builds app deep link with reference", () => {
    expect(fundingCallbackService.buildAppReturnDeepLink("fund_abc123")).toBe(
        "truepay://payment/callback?reference=fund_abc123",
    );
  });

  it("respects C2B_APP_DEEP_LINK override", () => {
    process.env.C2B_APP_DEEP_LINK = "truepay://topup/done";
    expect(fundingCallbackService.buildAppReturnDeepLink("ref_1")).toBe(
        "truepay://topup/done?reference=ref_1",
    );
  });
});
