const {
  applySafariCardPayoutDetails,
  buildSafariCardPayoutDetails,
  enrichTransactionWithSafariCardPayout,
  isSafariCardPayoutTransaction,
} = require("../../utils/safariCardTransactionEnrichment");

describe("safariCardTransactionEnrichment", () => {
  it("detects safari card payout transactions", () => {
    expect(isSafariCardPayoutTransaction({
      metadata: { source: "safari_card_payout", payoutId: "abc" },
    })).toBe(true);
    expect(isSafariCardPayoutTransaction({
      metadata: { source: "funding" },
    })).toBe(false);
  });

  it("merges payout details and strips internal ids from metadata", () => {
    const payout = {
      type: "MPESA_B2B",
      amount: 13,
      currency: "KES",
      fee: 0,
      totalDebit: 13,
      narrative: "Safari Card payment",
      clientRequestId: "client-req-001",
      providerReference: "UHKUE3131L",
      providerTransactionId: "KZBPGV6",
      recipient: {
        accountType: "TillNumber",
        account: "4963167",
        name: "Calvin Rumba Mbui",
      },
    };

    const enriched = applySafariCardPayoutDetails(
        {
          id: "tx_1",
          type: "withdrawal",
          amount: 13,
          currency: "KES",
          metadata: {
            source: "safari_card_payout",
            payoutId: "hyWCJwZmUC4nDC5NfGSe",
            providerTrackingId: "590179d8-c2e5-4233-a2e6-99c08c59c9ff",
            type: "MPESA_B2B",
          },
        },
        buildSafariCardPayoutDetails(payout),
    );

    expect(enriched.mpesaReference).toBe("UHKUE3131L");
    expect(enriched.merchantName).toBe("Calvin Rumba Mbui");
    expect(enriched.recipient).toEqual({
      account_type: "TillNumber",
      account: "4963167",
      account_reference: null,
    });
    expect(enriched.displayName).toBe("Calvin Rumba Mbui");
    expect(enriched.clientRequestId).toBeUndefined();
    expect(enriched.narrative).toBeUndefined();
    expect(enriched.providerTransactionId).toBeUndefined();
    expect(enriched.providerReference).toBeUndefined();
    expect(enriched.metadata.payoutId).toBeUndefined();
    expect(enriched.metadata.providerTrackingId).toBeUndefined();
    expect(enriched.metadata.mpesaReference).toBe("UHKUE3131L");
    expect(enriched.metadata.merchantName).toBe("Calvin Rumba Mbui");
    expect(enriched.metadata.clientRequestId).toBeUndefined();
    expect(enriched.metadata.narrative).toBeUndefined();
  });

  it("enrichTransactionWithSafariCardPayout falls back without payout doc", async () => {
    const enriched = await enrichTransactionWithSafariCardPayout({
      id: "tx_2",
      type: "topup",
      amount: 10,
      metadata: { source: "intasend" },
    });
    expect(enriched.displayName).toBeDefined();
  });
});
