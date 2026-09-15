const {
  enrichTransactionForFeed,
  mapCryptoTransactionForFeed,
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

  test("TruePay merchant profile pay is debit Pay label", () => {
    const tx = enrichTransactionForFeed({
      type: "merchant_payment",
      amount: 800,
      currency: "KES",
      status: "completed",
      metadata: {
        source: "truepay_merchant_profile",
        merchantName: "Tru Pay",
      },
    });
    expect(tx.direction).toBe("debit");
    expect(tx.displayName).toBe("Pay Tru Pay");
    expect(tx.reconType).toBe("merchant_payment");
  });

  test("direct topup pending label", () => {
    expect(enrichTransactionForFeed({
      type: "direct_topup",
      amount: 100,
      status: "pending",
    }).displayName).toBe("Direct top-up");
  });

  test("USDC deposit is credit with USDC deposit label", () => {
    const tx = enrichTransactionForFeed({
      type: "deposit",
      amount: 20,
      currency: "USDC",
      status: "completed",
      provider: "turnkey",
    });
    expect(tx.direction).toBe("credit");
    expect(tx.signedAmount).toBe(20);
    expect(tx.displayName).toBe("USDC deposit");
    expect(tx.reconType).toBe("usdc_deposit");
  });

  test("mapCryptoTransactionForFeed normalizes complete status and currency", () => {
    const row = mapCryptoTransactionForFeed("abc", {
      type: "deposit",
      amount: 20,
      asset: "USDC",
      status: "complete",
      provider: "turnkey",
      txHash: "0xabc",
      createdAt: {toDate: () => new Date("2026-09-15T08:50:00.000Z")},
    }, "user_1");
    expect(row).toMatchObject({
      id: "crypto_abc",
      type: "deposit",
      status: "completed",
      amount: 20,
      currency: "USDC",
      userId: "user_1",
      source: "cryptoTransactions",
      txHash: "0xabc",
    });
    expect(row.timestamp).toBe("2026-09-15T08:50:00.000Z");
  });
});
