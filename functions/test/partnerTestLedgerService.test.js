/**
 * @fileoverview Partner test-ledger scenarios and quotes (no live rails).
 */

const {
  resolveScenario,
  statusFromScenario,
  quoteSend,
} = require("../services/partnerTestLedgerService");

describe("partnerTestLedgerService", () => {
  it("uses amount endings for deterministic outcomes", () => {
    expect(resolveScenario(100)).toBe("success");
    expect(resolveScenario(101)).toBe("fail");
    expect(resolveScenario(102)).toBe("pending");
    expect(resolveScenario(103)).toBe("expire");
    expect(resolveScenario(250)).toBe("success");
  });

  it("lets scenario override the amount suffix", () => {
    expect(resolveScenario(100, "fail")).toBe("fail");
    expect(statusFromScenario("fail")).toBe("failed");
    expect(statusFromScenario("expire")).toBe("expired");
    expect(statusFromScenario("success")).toBe("completed");
  });

  it("quotes a test send without touching live rates", () => {
    const quote = quoteSend({amount: 1000, fromCurrency: "KES", toCurrency: "USDT"});
    expect(quote.sandbox).toBe(true);
    expect(quote.environment).toBe("test");
    expect(quote.fee).toBe(10);
    expect(quote.receiveAmount).toBeGreaterThan(0);
  });

  it("rejects non-positive send amounts", () => {
    expect(() => quoteSend({amount: 0})).toThrow(/Invalid amount/);
  });
});
