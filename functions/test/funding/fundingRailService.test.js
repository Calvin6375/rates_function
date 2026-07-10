/**
 * @fileoverview Unit tests for funding rail provider registry.
 */

const fundingRailService = require("../../services/funding/fundingRailService");
const paystackProvider = require("../../services/funding/providers/paystackProvider");
const transakProvider = require("../../services/funding/providers/transakProvider");

describe("fundingRailService", () => {
  it("registers paystack and transak providers", () => {
    const providers = fundingRailService.listProviders();
    expect(providers).toEqual(expect.arrayContaining(["paystack", "transak"]));
  });

  it("resolves transak adapter by id", () => {
    const adapter = fundingRailService.resolveProvider("transak");
    expect(adapter.providerId).toBe("transak");
    expect(adapter).toBe(transakProvider);
  });

  it("resolves paystack adapter by id", () => {
    const adapter = fundingRailService.resolveProvider("paystack");
    expect(adapter.providerId).toBe("paystack");
    expect(adapter).toBe(paystackProvider);
  });
});
