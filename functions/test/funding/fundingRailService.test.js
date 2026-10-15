/**
 * @fileoverview Unit tests for funding rail provider registry.
 */

const fundingRailService = require("../../services/funding/fundingRailService");
const paystackProvider = require("../../services/funding/providers/paystackProvider");

describe("fundingRailService", () => {
  it("registers active funding providers and omits retired Transak", () => {
    const providers = fundingRailService.listProviders();
    expect(providers).toEqual(expect.arrayContaining(["paystack", "crossmint", "paylio"]));
    expect(providers).not.toContain("transak");
  });

  it("rejects the retired Transak provider id", () => {
    expect(() => fundingRailService.resolveProvider("transak")).toThrow(
        "Unsupported funding provider: transak",
    );
  });

  it("resolves paystack adapter by id", () => {
    const adapter = fundingRailService.resolveProvider("paystack");
    expect(adapter.providerId).toBe("paystack");
    expect(adapter).toBe(paystackProvider);
  });
});
