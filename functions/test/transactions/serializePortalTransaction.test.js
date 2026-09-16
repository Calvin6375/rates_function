/**
 * @fileoverview Partners table fields on GET /platform/transactions.
 */

jest.mock("../../admin", () => ({
  firestore: jest.fn(() => ({collection: jest.fn()})),
  database: jest.fn(() => ({ref: jest.fn()})),
}));
jest.mock("../../libs/firestore", () => ({
  collection: jest.fn(),
  serverTimestamp: jest.fn(),
}));
jest.mock("../../utils/transactions", () => ({
  logTransaction: jest.fn(),
  generateTransactionId: jest.fn(),
}));
jest.mock("../../services/ledgerService", () => ({createDoubleEntry: jest.fn()}));
jest.mock("../../services/walletService", () => ({}));
jest.mock("../../services/funding/fundingOrderService", () => ({}));

const {serializePortalTransaction} = require("../../services/transactionService");

describe("serializePortalTransaction", () => {
  it("exposes TruePay fee and KES settled for collection rows", () => {
    const row = serializePortalTransaction({
      id: "txr_1",
      type: "b2b_payment",
      partnerId: "partner_1",
      amount: 100,
      currency: "KES",
      status: "completed",
      createdAt: "2026-09-16T09:34:00.000Z",
      metadata: {
        bookingReference: "teststd",
        payerName: "Calvin Rumba",
        platformFee: 59.5,
        netCredit: 40.5,
        fxRate: 1,
      },
    });

    expect(row.bookingReference).toBe("teststd");
    expect(row.payerName).toBe("Calvin Rumba");
    expect(row.amountReceived).toBe(100);
    expect(row.truePayFee).toBe(59.5);
    expect(row.platformFee).toBe(59.5);
    expect(row.kesSettled).toBe(40.5);
    expect(row.kesEquivalent).toBe(100);
    expect(row.fxRate).toBe(1);
    expect(row.channel).toBe("b2b");
  });

  it("exposes partnerName for tracking", () => {
    const row = serializePortalTransaction({
      id: "txr_2",
      type: "b2b_payment",
      partnerId: "partner_1",
      partnerName: "Safishha",
      amount: 150,
      currency: "KES",
      status: "completed",
      metadata: {payerName: "Calvin Rumba"},
    });
    expect(row.partnerName).toBe("Safishha");
    expect(row.metadata.partnerName).toBe("Safishha");
  });

  it("falls back to metadata.partnerName", () => {
    const row = serializePortalTransaction({
      id: "txr_3",
      type: "b2b_payment",
      partnerId: "partner_1",
      amount: 100,
      currency: "KES",
      status: "completed",
      metadata: {partnerName: "Tru Pay"},
    });
    expect(row.partnerName).toBe("Tru Pay");
  });
});
