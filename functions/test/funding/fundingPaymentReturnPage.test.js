/**
 * @fileoverview Unit tests for Paystack payment return HTML page.
 */

const { renderFundingPaymentReturnHtml } = require("../../utils/fundingPaymentReturnPage");

describe("fundingPaymentReturnPage", () => {
  it("renders single-attempt deep link with sessionStorage guard", () => {
    const html = renderFundingPaymentReturnHtml({
      reference: "fund_test_123",
      deepLink: "truepay://payment/callback?reference=fund_test_123",
      statusUrl: "https://example.com/public/funding/status",
    });

    expect(html).toContain("sessionStorage");
    expect(html).toContain("truepay_return_");
    expect(html).toContain("tryOpenAppOnce");
    expect(html).not.toMatch(/pollStatus[\s\S]*tryOpenApp\(\)/);
  });

  it("includes manual Open TruePay button href", () => {
    const deepLink = "truepay://payment/callback?reference=fund_abc";
    const html = renderFundingPaymentReturnHtml({
      reference: "fund_abc",
      deepLink,
      statusUrl: "https://example.com/public/funding/status",
    });

    expect(html).toContain(deepLink);
    expect(html).toContain('id="open-app"');
  });
});
