/**
 * @fileoverview Safari Card payout fee tests.
 */

describe("safariCardPayoutFeeService", () => {
  const originalB2c = process.env.SAFARI_CARD_MPESA_B2C_FEE;

  beforeEach(() => {
    process.env.SAFARI_CARD_MPESA_B2C_FEE = "10";
    jest.resetModules();
  });

  afterEach(() => {
    if (originalB2c == null) {
      delete process.env.SAFARI_CARD_MPESA_B2C_FEE;
    } else {
      process.env.SAFARI_CARD_MPESA_B2C_FEE = originalB2c;
    }
    jest.resetModules();
  });

  it("calculates totalDebit as amount + fee", () => {
    const { calculatePayoutFee } = require("../../services/safariCard/safariCardPayoutFeeService");
    const result = calculatePayoutFee({
      userId: "u1",
      payoutType: "MPESA_B2C",
      amount: 1000,
      currency: "KES",
    });
    expect(result.fee).toBe(10);
    expect(result.totalDebit).toBe(1010);
  });
});
