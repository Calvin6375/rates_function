/**
 * @fileoverview Dedup of C2B / Safari Tap history rows that share link keys.
 */

const {
  collectLinkKeys,
  dedupeSafariTapAdminRows,
  dedupeC2bTransactionFeed,
} = require("../../utils/transactionDedupe");

describe("collectLinkKeys", () => {
  it("links a funding order to its transaction record", () => {
    const fundKeys = collectLinkKeys({
      id: "fund_1788458542182_c3znzlpgy",
      source: "fundingOrders",
      metadata: {},
    });
    const txrKeys = collectLinkKeys({
      id: "txr_1788458590514_3cd9ee26l",
      source: "transactionRecords",
      metadata: {fundingOrderId: "fund_1788458542182_c3znzlpgy"},
    });
    expect(fundKeys).toContain("funding:fund_1788458542182_c3znzlpgy");
    expect(txrKeys).toContain("funding:fund_1788458542182_c3znzlpgy");
  });

  it("links a payout doc to its withdrawal ledger row", () => {
    const payoutKeys = collectLinkKeys({
      id: "eYTW9Mlkj4E3tkHbunwE",
      source: "safariCardPayouts",
      metadata: {transactionId: "txr_1788356709014_obz6xzcvf"},
    });
    const txrKeys = collectLinkKeys({
      id: "txr_1788356709014_obz6xzcvf",
      source: "transactionRecords",
      metadata: {payoutId: "eYTW9Mlkj4E3tkHbunwE"},
    });
    expect(payoutKeys).toContain("payout:eYTW9Mlkj4E3tkHbunwE");
    expect(txrKeys).toContain("payout:eYTW9Mlkj4E3tkHbunwE");
    expect(payoutKeys).toContain("txr:txr_1788356709014_obz6xzcvf");
  });
});

describe("dedupeSafariTapAdminRows", () => {
  it("keeps one topup row when fund_ and txr_ are the same checkout", () => {
    const rows = [
      {
        id: "txr_1",
        source: "transactionRecords",
        status: "completed",
        amount: 300,
        metadata: {fundingOrderId: "fund_1"},
      },
      {
        id: "fund_1",
        source: "fundingOrders",
        status: "completed",
        amount: 304.57,
        metadata: {fundingOrderId: "fund_1"},
      },
    ];
    const out = dedupeSafariTapAdminRows(rows, "topups");
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("txr_1");
    expect(out[0].amount).toBe(300);
  });

  it("keeps the payout row over the withdrawal txr on Send", () => {
    const rows = [
      {
        id: "txr_wd",
        source: "transactionRecords",
        type: "withdrawal",
        amount: 120,
        metadata: {payoutId: "payout_bank_1"},
      },
      {
        id: "payout_bank_1",
        source: "safariCardPayouts",
        type: "BANK",
        amount: 120,
        metadata: {payoutId: "payout_bank_1", transactionId: "txr_wd"},
      },
    ];
    const out = dedupeSafariTapAdminRows(rows, "send");
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("payout_bank_1");
    expect(out[0].type).toBe("BANK");
  });
});

describe("dedupeC2bTransactionFeed", () => {
  it("collapses two legacy tx_ rows for the same payout", () => {
    const rows = [
      {
        id: "tx_aaa",
        source: "firestore",
        status: "completed",
        amount: 2800,
        metadata: {payoutId: "payout_loop", source: "safari_card_payout"},
      },
      {
        id: "tx_bbb",
        source: "firestore",
        status: "completed",
        amount: 2800,
        metadata: {payoutId: "payout_loop", source: "safari_card_payout"},
      },
    ];
    const out = dedupeC2bTransactionFeed(rows);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("tx_aaa");
  });

  it("does not merge unrelated topups that only share amount", () => {
    const rows = [
      {id: "tx_1", source: "firestore", amount: 2000, metadata: {fundingOrderId: "fund_a"}},
      {id: "tx_2", source: "firestore", amount: 2000, metadata: {fundingOrderId: "fund_b"}},
    ];
    expect(dedupeC2bTransactionFeed(rows)).toHaveLength(2);
  });
});
