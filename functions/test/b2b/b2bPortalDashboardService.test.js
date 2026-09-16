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
jest.mock("../../services/b2bSendService", () => ({
  listSendPayments: jest.fn(),
  serializePayment: jest.fn(),
}));
jest.mock("../../services/settlementService", () => ({
  STATUSES: {pending: "pending", scheduled: "scheduled", processing: "processing"},
}));
jest.mock("../../utils/notifications", () => ({getUserNotifications: jest.fn()}));

const {
  resolveDashboardPeriod,
  resolveDashboardTypes,
  formatRecentSendRow,
  formatRecentCollectionRow,
  sumCollectedPayments,
  sumKesCompleted,
  sumTruePayFee,
} = require("../../services/b2bPortalDashboardService");

describe("b2bPortalDashboardService", () => {
  test("resolveDashboardPeriod month starts at first of month", () => {
    const period = resolveDashboardPeriod("month");
    expect(period.key).toBe("month");
    expect(period.from.getDate()).toBe(1);
    expect(period.previousTo.getTime()).toBeLessThan(period.from.getTime());
  });

  test("partner scope uses B2B types only", () => {
    const types = resolveDashboardTypes("all", false);
    expect(types).toContain("b2b_payment");
    expect(types).not.toContain("topup");
  });

  test("platform all channel includes C2B types", () => {
    const types = resolveDashboardTypes("all", true);
    expect(types).toContain("b2b_payment");
    expect(types).toContain("funding");
    expect(types).toContain("merchant_payment");
  });

  test("formatRecentSendRow maps dashboard columns", () => {
    const row = formatRecentSendRow({
      id: "psend_1",
      createdAt: "2026-08-20T10:00:00.000Z",
      paymentReference: "REF-001",
      youSend: 1000,
      fromCurrency: "KES",
      recipientGets: 28.25,
      toCurrency: "AED",
      status: "pending",
      recipientSnapshot: { displayName: "Dubai Merchant" },
    });
    expect(row.reference).toBe("REF-001");
    expect(row.merchant).toBe("Dubai Merchant");
    expect(row.sent.amount).toBe(1000);
    expect(row.received.currency).toBe("AED");
  });

  test("formatRecentCollectionRow maps guest ref and KES equivalent", () => {
    const row = formatRecentCollectionRow({
      id: "txr_1",
      type: "b2b_payment",
      amount: 4500,
      currency: "KES",
      status: "completed",
      createdAt: "2026-08-20T12:00:00.000Z",
      metadata: {
        bookingReference: "BK-99",
        payerName: "Jane Doe",
      },
    });
    expect(row.guestOrBookingRef).toBe("BK-99");
    expect(row.payerName).toBe("Jane Doe");
    expect(row.kesEquivalent).toBe(4500);
  });

  test("KES settled is net credit after TruePay fee, not face amount", () => {
    const rows = [
      {
        id: "txr_a",
        type: "b2b_payment",
        amount: 150,
        currency: "KES",
        status: "completed",
        metadata: {platformFee: 60.75, netCredit: 89.25},
      },
      {
        id: "txr_b",
        type: "b2b_payment",
        amount: 150,
        currency: "KES",
        status: "completed",
        metadata: {platformFee: 60.75, netCredit: 89.25},
      },
      {
        id: "txr_c",
        type: "b2b_payment",
        amount: 150,
        currency: "KES",
        status: "completed",
        metadata: {platformFee: 60.75, netCredit: 89.25},
      },
      {
        id: "txr_fund",
        type: "b2b_funding",
        amount: 1000,
        currency: "KES",
        status: "completed",
      },
    ];

    expect(sumCollectedPayments(rows).amount).toBe(450);
    expect(sumKesCompleted(rows)).toBe(267.75);
    expect(sumTruePayFee(rows)).toBe(182.25);
  });

  test("formatRecentCollectionRow exposes fee and settled amounts", () => {
    const row = formatRecentCollectionRow({
      id: "txr_fee",
      type: "b2b_payment",
      amount: 150,
      currency: "KES",
      status: "completed",
      metadata: {
        bookingReference: "teststd",
        payerName: "Calvin Rumba",
        platformFee: 60.75,
        netCredit: 89.25,
      },
    });
    expect(row.amount).toBe(150);
    expect(row.truePayFee).toBe(60.75);
    expect(row.kesSettled).toBe(89.25);
  });
});
