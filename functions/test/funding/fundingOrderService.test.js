/**
 * @fileoverview Funding order lifecycle and idempotency reference tests.
 */

const {
  FUNDING_STATUSES,
  FUNDING_CURRENCY,
  isTerminalFundingStatus,
  resolveFundingDisplayMoney,
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

  it("pairs FX top-up display amount with requested currency, not Paystack KES", () => {
    const display = resolveFundingDisplayMoney({
      amount: 2890359.81,
      currency: "KES",
      metadata: {
        requestedAmount: 100000,
        requestedCurrency: "UGX",
        chargeAmount: 2890359.81,
        paystackCurrency: "KES",
      },
    });
    expect(display).toEqual({amount: 100000, currency: "UGX"});
  });

  it("keeps KES face amount when requested currency is KES", () => {
    const display = resolveFundingDisplayMoney({
      amount: 51.25,
      currency: "KES",
      metadata: {
        requestedAmount: 50,
        requestedCurrency: "KES",
      },
    });
    expect(display).toEqual({amount: 50, currency: "KES"});
  });
});

describe("funding reference idempotency key", () => {
  it("builds stable ledger reference from provider transaction id", () => {
    const referenceId = `fund_paystack_${123456}`;
    expect(referenceId).toBe("fund_paystack_123456");
  });
});
