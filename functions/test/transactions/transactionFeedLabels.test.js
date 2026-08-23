const {
  enrichTransactionForFeed,
  resolveTransactionDisplayName,
  resolveTransactionDirection,
} = require("../../utils/transactionFeedLabels");

describe("transactionFeedLabels", () => {
  test("merchant payment is debit with merchant label", () => {
    const tx = enrichTransactionForFeed({
      type: "merchant_payment",
      amount: 10,
      currency: "USD",
      status: "completed",
      metadata: { merchantId: "MCH-001" },
    });
    expect(tx.direction).toBe("debit");
    expect(tx.signedAmount).toBe(-10);
    expect(tx.displayName).toBe("Merchant payment (MCH-001)");
    expect(tx.reconType).toBe("merchant_payment");
  });

  test("Paystack funding is credit with provider label", () => {
    const tx = enrichTransactionForFeed({
      type: "funding",
      amount: 15,
      currency: "KES",
      status: "completed",
      metadata: { provider: "paystack" },
    });
    expect(tx.direction).toBe("credit");
    expect(tx.displayName).toBe("Wallet top-up (Paystack)");
    expect(tx.reconType).toBe("funding_paystack");
  });

  test("legacy IntaSend topup label", () => {
    expect(resolveTransactionDisplayName({
      type: "topup",
      metadata: { source: "intasend" },
    })).toBe("Wallet top-up (IntaSend)");
  });

  test("send money debit vs receive credit", () => {
    expect(resolveTransactionDirection({
      type: "debit",
      metadata: { type: "send" },
    })).toBe("debit");
    expect(resolveTransactionDisplayName({
      type: "debit",
      metadata: { type: "send" },
    })).toBe("Send money");

    expect(enrichTransactionForFeed({
      type: "credit",
      amount: 5,
      metadata: { type: "receive" },
    }).displayName).toBe("Money received");
  });

  test("direct topup pending label", () => {
    expect(enrichTransactionForFeed({
      type: "direct_topup",
      amount: 100,
      status: "pending",
    }).displayName).toBe("Direct top-up");
  });
});
