const {
  resolveDashboardPeriod,
  resolveDashboardTypes,
  formatRecentSendRow,
  formatRecentCollectionRow,
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
});
