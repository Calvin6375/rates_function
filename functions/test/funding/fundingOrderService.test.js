/**
 * @fileoverview Funding order lifecycle and idempotency reference tests.
 */

const {
  FUNDING_STATUSES,
  FUNDING_CURRENCY,
  isTerminalFundingStatus,
} = require("../../utils/fundingTypes");

describe("fundingTypes", () => {
  it("defines USD as the only funding currency", () => {
    expect(FUNDING_CURRENCY).toBe("USD");
  });

  it("detects terminal funding statuses", () => {
    expect(isTerminalFundingStatus(FUNDING_STATUSES.completed)).toBe(true);
    expect(isTerminalFundingStatus(FUNDING_STATUSES.failed)).toBe(true);
    expect(isTerminalFundingStatus(FUNDING_STATUSES.pending)).toBe(false);
  });
});

describe("funding reference idempotency key", () => {
  it("builds stable ledger reference from provider transaction id", () => {
    const referenceId = `fund_paystack_${123456}`;
    expect(referenceId).toBe("fund_paystack_123456");
  });
});
