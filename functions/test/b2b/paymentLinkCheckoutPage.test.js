/**
 * @fileoverview Hosted payment-link checkout page — logo + post-pay redirect.
 */

const {
  renderCheckoutHtml,
  renderSuccessHtml,
  renderErrorHtml,
  checkoutLogoUrl,
  defaultPaidRedirectUrl,
} = require("../../utils/paymentLinkCheckoutPage");
const {sanitizeSuccessRedirectUrl} = require("../../services/paymentLinkService");

describe("paymentLinkCheckoutPage", () => {
  const originalEnv = process.env.B2B_PAYMENT_SUCCESS_REDIRECT_URL;

  afterEach(() => {
    if (originalEnv == null) {
      delete process.env.B2B_PAYMENT_SUCCESS_REDIRECT_URL;
    } else {
      process.env.B2B_PAYMENT_SUCCESS_REDIRECT_URL = originalEnv;
    }
  });

  it("uses the checkout logo instead of the T mark", () => {
    const html = renderCheckoutHtml("pl_1", "partner_1", "/b2bPortal");
    expect(html).toContain("/b2bPortal/public/checkout-logo.png");
    expect(html).toContain('class="brand-logo"');
    expect(html).not.toContain("brand-mark");
    expect(html).not.toMatch(/<div class="brand-mark">T<\/div>/);
  });

  it("offers a PNG receipt download after payment is confirmed", () => {
    const checkout = renderCheckoutHtml("pl_1", "partner_1", "/b2bPortal");
    const success = renderSuccessHtml("pl_1", "/b2bPortal");
    for (const html of [checkout, success]) {
      expect(html).toContain("Download receipt");
      expect(html).toContain("/b2bPortal/public/troupay-logo.png");
      expect(html).toContain("downloadReceiptPng");
      expect(html).toContain("image/png");
    }
  });

  it("schedules a redirect after payment is confirmed", () => {
    const checkout = renderCheckoutHtml("pl_1", "partner_1", "/b2bPortal");
    const success = renderSuccessHtml("pl_1", "/b2bPortal");
    for (const html of [checkout, success]) {
      expect(html).toContain("schedulePaidRedirect");
      expect(html).toContain("truepay://payment/link-complete");
      expect(html).toContain("Redirecting in");
    }
  });

  it("honors B2B_PAYMENT_SUCCESS_REDIRECT_URL when it is http(s)", () => {
    process.env.B2B_PAYMENT_SUCCESS_REDIRECT_URL = "https://merchant.example/thanks";
    expect(defaultPaidRedirectUrl()).toBe("https://merchant.example/thanks");
    const html = renderSuccessHtml("pl_1", "/b2bPortal");
    expect(html).toContain("https://merchant.example/thanks");
  });

  it("ignores non-http default redirect env values", () => {
    process.env.B2B_PAYMENT_SUCCESS_REDIRECT_URL = "javascript:alert(1)";
    expect(defaultPaidRedirectUrl()).toBe("");
  });

  it("renders the logo on error pages", () => {
    const html = renderErrorHtml("Invalid link", "Missing partner");
    expect(html).toContain(checkoutLogoUrl("/b2bPortal"));
  });
});

describe("sanitizeSuccessRedirectUrl", () => {
  it("accepts http(s) URLs", () => {
    expect(sanitizeSuccessRedirectUrl("https://shop.example/done"))
        .toBe("https://shop.example/done");
  });

  it("rejects javascript and other schemes", () => {
    expect(() => sanitizeSuccessRedirectUrl("javascript:alert(1)"))
        .toThrow(/http\(s\)/);
  });

  it("treats empty as null", () => {
    expect(sanitizeSuccessRedirectUrl("")).toBeNull();
    expect(sanitizeSuccessRedirectUrl(null)).toBeNull();
  });
});
