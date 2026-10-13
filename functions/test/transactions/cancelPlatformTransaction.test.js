/**
 * @fileoverview Super-admin cancel of pending portal transactions.
 */

jest.mock("../../libs/firestore", () => ({
  collection: jest.fn(),
  serverTimestamp: jest.fn(() => ({_serverTimestamp: true})),
  getFirestore: jest.fn(),
}));

jest.mock("../../services/transactionService", () => ({
  TRANSACTION_TYPES: {
    b2b_payment: "b2b_payment",
    b2b_send: "b2b_send",
    b2b_funding: "b2b_funding",
    b2b_admin_topup: "b2b_admin_topup",
  },
  STATUSES: {
    created: "created",
    pending: "pending",
    processing: "processing",
    completed: "completed",
    failed: "failed",
    cancelled: "cancelled",
  },
  CANCELLABLE_STATUSES: ["created", "pending", "processing"],
  REVERSIBLE_CREDIT_TYPES: ["b2b_payment", "b2b_funding", "b2b_admin_topup"],
  isPortalTransactionCancellable: (row) => {
    const status = String(row && row.status || "").toLowerCase();
    if (!status || status === "cancelled") return false;
    if (["created", "pending", "processing"].includes(status)) return true;
    if (status === "completed" || status === "failed") {
      return ["b2b_payment", "b2b_funding", "b2b_admin_topup"].includes(String(row.type || ""));
    }
    return false;
  },
  getTransactionRecord: jest.fn(),
  serializePortalTransaction: jest.fn((row) => ({
    transactionId: row.id,
    status: row.status,
    type: row.type,
    cancellable: ["created", "pending", "processing"].includes(String(row.status)),
    cancelReason: row.cancelReason || (row.metadata && row.metadata.cancelReason) || null,
  })),
}));

jest.mock("../../services/walletService", () => ({
  updatePartnerWalletBalance: jest.fn(),
}));

jest.mock("../../services/funding/fundingOrderService", () => ({
  getFundingOrder: jest.fn(),
  updateFundingOrder: jest.fn(),
}));

jest.mock("../../utils/transactions", () => ({
  logAdminAction: jest.fn().mockResolvedValue("log_1"),
}));

const {collection, getFirestore} = require("../../libs/firestore");
const transactionService = require("../../services/transactionService");
const walletService = require("../../services/walletService");
const fundingOrderService = require("../../services/funding/fundingOrderService");
const {cancelPlatformTransaction} = require("../../services/platformTransactionCancelService");

describe("cancelPlatformTransaction", () => {
  /** @type {Record<string, Object>} */
  let docs;

  beforeEach(() => {
    jest.clearAllMocks();
    docs = {};
    collection.mockImplementation((name) => ({
      doc: (id) => ({
        get: jest.fn(async () => ({
          exists: Object.prototype.hasOwnProperty.call(docs, `${name}/${id}`),
          data: () => docs[`${name}/${id}`],
        })),
        set: jest.fn(async (patch, opts) => {
          const key = `${name}/${id}`;
          docs[key] = opts && opts.merge ? {...(docs[key] || {}), ...patch} : patch;
        }),
      }),
    }));
    getFirestore.mockReturnValue({
      runTransaction: async (fn) => fn({
        get: async (ref) => ref.get(),
        update: async (ref, patch) => ref.set(patch, {merge: true}),
      }),
    });
    fundingOrderService.getFundingOrder.mockResolvedValue(null);
    fundingOrderService.updateFundingOrder.mockResolvedValue({});
    walletService.updatePartnerWalletBalance.mockResolvedValue({
      previousBalance: 10,
      newBalance: 40,
    });
  });

  function seedTransaction(id, data) {
    docs[`transactionRecords/${id}`] = data;
  }

  it("cancels a pending collection and blocks later settlement", async () => {
    const pending = {
      id: "txr_1",
      type: "b2b_payment",
      status: "pending",
      partnerId: "partner_1",
      amount: 6,
      currency: "USD",
      metadata: {
        checkoutId: "chk_1",
        orderId: "ord_1",
        fundingOrderId: "fund_1",
        payerName: "Calvin Rumba",
      },
    };
    seedTransaction("txr_1", pending);
    docs["invoiceMappings/chk_1"] = {status: "pending", partnerId: "partner_1"};
    docs["orders/ord_1"] = {status: "pending"};
    fundingOrderService.getFundingOrder.mockResolvedValue({
      id: "fund_1",
      status: "pending",
      metadata: {partnerId: "partner_1"},
    });
    transactionService.getTransactionRecord
        .mockResolvedValueOnce(pending)
        .mockResolvedValueOnce({
          ...pending,
          status: "cancelled",
          cancelReason: "Payer abandoned checkout",
        });

    const result = await cancelPlatformTransaction({
      transactionId: "txr_1",
      actorUid: "admin_1",
      reason: "Payer abandoned checkout",
    });

    expect(result.alreadyCancelled).toBe(false);
    expect(result.transaction.status).toBe("cancelled");
    expect(result.reversal).toBeNull();
    expect(docs["invoiceMappings/chk_1"].status).toBe("cancelled");
    expect(docs["orders/ord_1"].status).toBe("cancelled");
    expect(docs["transactionRecords/txr_1"].status).toBe("cancelled");
    expect(fundingOrderService.updateFundingOrder).toHaveBeenCalledWith(
        "fund_1",
        expect.objectContaining({
          status: "failed",
          failureReason: "Payer abandoned checkout",
          metadata: expect.objectContaining({adminCancelled: true, cancelledByUid: "admin_1"}),
        }),
    );
    expect(walletService.updatePartnerWalletBalance).not.toHaveBeenCalled();
  });

  it("debits the partner wallet when a completed collection is cancelled", async () => {
    const completed = {
      id: "txr_done",
      type: "b2b_payment",
      status: "completed",
      partnerId: "partner_1",
      amount: 6,
      currency: "USD",
      metadata: {netCredit: 6, platformFee: 0},
    };
    seedTransaction("txr_done", completed);
    walletService.updatePartnerWalletBalance.mockResolvedValue({
      previousBalance: 20,
      newBalance: 14,
    });
    transactionService.getTransactionRecord
        .mockResolvedValueOnce(completed)
        .mockResolvedValueOnce({...completed, status: "cancelled"});

    const result = await cancelPlatformTransaction({
      transactionId: "txr_done",
      actorUid: "admin_1",
      reason: "Paid in error",
    });

    expect(walletService.updatePartnerWalletBalance).toHaveBeenCalledWith("partner_1", "USD", -6);
    expect(result.reversal).toMatchObject({amount: 6, currency: "USD", direction: "debit"});
    expect(docs["transactionRecords/txr_done"].status).toBe("cancelled");
    expect(result.transaction.status).toBe("cancelled");
  });

  it("reverses a pending row whose funding order already settled", async () => {
    const pending = {
      id: "txr_2",
      type: "b2b_payment",
      status: "pending",
      partnerId: "partner_1",
      amount: 6,
      currency: "USD",
      metadata: {fundingOrderId: "fund_done", checkoutId: "chk_2", netCredit: 6},
    };
    seedTransaction("txr_2", pending);
    docs["invoiceMappings/chk_2"] = {status: "pending"};
    fundingOrderService.getFundingOrder.mockResolvedValue({
      id: "fund_done",
      status: "completed",
      metadata: {},
    });
    walletService.updatePartnerWalletBalance.mockResolvedValue({
      previousBalance: 6,
      newBalance: 0,
    });
    transactionService.getTransactionRecord
        .mockResolvedValueOnce(pending)
        .mockResolvedValueOnce({...pending, status: "cancelled"});

    const result = await cancelPlatformTransaction({
      transactionId: "txr_2",
      actorUid: "admin_1",
    });

    expect(walletService.updatePartnerWalletBalance).toHaveBeenCalledWith("partner_1", "USD", -6);
    expect(docs["invoiceMappings/chk_2"].status).toBe("cancelled");
    expect(docs["transactionRecords/txr_2"].status).toBe("cancelled");
    expect(result.alreadyCancelled).toBe(false);
  });

  it("refuses a completed send", async () => {
    transactionService.getTransactionRecord.mockResolvedValue({
      id: "txr_send_done",
      type: "b2b_send",
      status: "completed",
      metadata: {paymentId: "sp_done"},
    });

    await expect(cancelPlatformTransaction({
      transactionId: "txr_send_done",
      actorUid: "admin_1",
    })).rejects.toMatchObject({statusCode: 409, code: "NOT_CANCELLABLE"});
    expect(walletService.updatePartnerWalletBalance).not.toHaveBeenCalled();
  });

  it("credits the partner wallet back when a pending send is cancelled", async () => {
    const pending = {
      id: "txr_send",
      type: "b2b_send",
      status: "pending",
      partnerId: "partner_1",
      amount: 30,
      currency: "USD",
      metadata: {paymentId: "sp_1"},
    };
    seedTransaction("txr_send", pending);
    docs["partnerSendPayments/sp_1"] = {
      status: "pending",
      partnerId: "partner_1",
      totalDeduction: 30,
      fromCurrency: "USD",
    };
    transactionService.getTransactionRecord
        .mockResolvedValueOnce(pending)
        .mockResolvedValueOnce({...pending, status: "cancelled"});

    const result = await cancelPlatformTransaction({
      transactionId: "txr_send",
      actorUid: "admin_1",
      reason: "Recipient rejected",
    });

    expect(walletService.updatePartnerWalletBalance).toHaveBeenCalledWith("partner_1", "USD", 30);
    expect(result.reversal).toMatchObject({amount: 30, currency: "USD", newBalance: 40});
    expect(docs["partnerSendPayments/sp_1"].status).toBe("cancelled");
    expect(docs["partnerSendPayments/sp_1"].reversed).toBe(true);
    expect(docs["transactionRecords/txr_send"].status).toBe("cancelled");
  });

  it("does not credit the wallet twice when cancel is retried", async () => {
    const cancelled = {
      id: "txr_send",
      type: "b2b_send",
      status: "cancelled",
      partnerId: "partner_1",
      amount: 30,
      currency: "USD",
      metadata: {paymentId: "sp_1"},
    };
    docs["partnerSendPayments/sp_1"] = {
      status: "cancelled",
      reversed: true,
      reversal: {amount: 30, currency: "USD"},
      partnerId: "partner_1",
      totalDeduction: 30,
      fromCurrency: "USD",
    };
    transactionService.getTransactionRecord.mockResolvedValue(cancelled);

    const result = await cancelPlatformTransaction({
      transactionId: "txr_send",
      actorUid: "admin_1",
    });

    expect(result.alreadyCancelled).toBe(true);
    expect(walletService.updatePartnerWalletBalance).not.toHaveBeenCalled();
  });

  it("finishes a send reversal if the transaction was cancelled before the credit", async () => {
    const cancelled = {
      id: "txr_send",
      type: "b2b_send",
      status: "cancelled",
      partnerId: "partner_1",
      amount: 30,
      currency: "USD",
      metadata: {paymentId: "sp_1"},
    };
    docs["partnerSendPayments/sp_1"] = {
      status: "pending",
      partnerId: "partner_1",
      totalDeduction: 30,
      fromCurrency: "USD",
    };
    transactionService.getTransactionRecord.mockResolvedValue(cancelled);

    const result = await cancelPlatformTransaction({
      transactionId: "txr_send",
      actorUid: "admin_1",
    });

    expect(result.alreadyCancelled).toBe(true);
    expect(walletService.updatePartnerWalletBalance).toHaveBeenCalledTimes(1);
    expect(docs["partnerSendPayments/sp_1"].status).toBe("cancelled");
  });
});
