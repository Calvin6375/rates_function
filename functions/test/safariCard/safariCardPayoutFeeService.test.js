/**
 * @fileoverview Safari Card payout fee tests.
 */

jest.mock("../../libs/firestore", () => ({
  collection: jest.fn(() => ({
    doc: () => ({
      get: jest.fn().mockResolvedValue({exists: false}),
    }),
  })),
  serverTimestamp: jest.fn(() => ({_serverTimestamp: true})),
}));

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

  it("calculates totalDebit as amount + fee", async () => {
    const {calculatePayoutFee} = require("../../services/safariCard/safariCardPayoutFeeService");
    const result = await calculatePayoutFee({
      userId: "u1",
      payoutType: "MPESA_B2C",
      amount: 1000,
      currency: "KES",
    });
    expect(result.fee).toBe(10);
    expect(result.totalDebit).toBe(1010);
    expect(result.feeSource).toBe("env_flat_fee");
  });
});
