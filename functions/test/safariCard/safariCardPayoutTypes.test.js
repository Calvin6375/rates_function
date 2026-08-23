/**
 * @fileoverview Safari Card payout status mapping tests.
 */

const {
  mapIntaSendStatus,
  PAYOUT_STATUS,
  serializePayoutForClient,
} = require("../../utils/safariCardPayoutTypes");

describe("safariCardPayoutTypes.mapIntaSendStatus", () => {
  it("maps TS100 to SUCCESS", () => {
    expect(mapIntaSendStatus("BC100", "TS100")).toBe(PAYOUT_STATUS.SUCCESS);
  });

  it("maps TF106 to FAILED", () => {
    expect(mapIntaSendStatus(null, "TF106")).toBe(PAYOUT_STATUS.FAILED);
  });

  it("maps TC108 to CANCELLED", () => {
    expect(mapIntaSendStatus(null, "TC108")).toBe(PAYOUT_STATUS.CANCELLED);
  });

  it("maps TR109 to RETRY", () => {
    expect(mapIntaSendStatus(null, "TR109")).toBe(PAYOUT_STATUS.RETRY);
  });

  it("maps TP101 to PROCESSING", () => {
    expect(mapIntaSendStatus("BP109", "TP101")).toBe(PAYOUT_STATUS.PROCESSING);
  });
});

describe("safariCardPayoutTypes.serializePayoutForClient", () => {
  it("includes mpesaReference, merchantName, and recipient account fields", () => {
    const row = serializePayoutForClient({
      payoutId: "sc_1",
      status: PAYOUT_STATUS.SUCCESS,
      type: "MPESA_B2B",
      amount: 15,
      currency: "KES",
      clientRequestId: "client-req-001",
      providerReference: "UHKUE3131L",
      providerTransactionId: "KZBPGV6",
      providerTrackingId: "track-should-not-expose",
      recipient: {
        accountType: "TillNumber",
        account: "4963167",
        name: "Calvin Rumba Mbui",
      },
    });
    expect(row.mpesaReference).toBe("UHKUE3131L");
    expect(row.merchantName).toBe("Calvin Rumba Mbui");
    expect(row.clientRequestId).toBeUndefined();
    expect(row.providerTransactionId).toBeUndefined();
    expect(row.narrative).toBeUndefined();
    expect(row.payoutId).toBeUndefined();
    expect(row.providerTrackingId).toBeUndefined();
    expect(row.type).toBeUndefined();
    expect(row.recipient).toEqual({
      account_type: "TillNumber",
      account: "4963167",
      account_reference: null,
    });
  });
});
