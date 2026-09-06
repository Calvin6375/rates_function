/**
 * @fileoverview Unit tests for B2B Send quote + payment.
 */

jest.mock("../libs/firestore", () => ({
  collection: jest.fn(),
  serverTimestamp: jest.fn(() => ({_serverTimestamp: true})),
}));
jest.mock("../services/walletService");
jest.mock("../services/transactionService", () => ({
  TRANSACTION_TYPES: {b2b_send: "b2b_send"},
  STATUSES: {pending: "pending", completed: "completed", failed: "failed"},
  createTransactionRecord: jest.fn().mockResolvedValue({transactionId: "txr_1"}),
  updateTransactionStatus: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../services/partnerRecipientService");
jest.mock("../services/partnerService");
jest.mock("../utils/notifications", () => ({
  NOTIFICATION_TYPES: {B2B_SEND_ADMIN_ALERT: "b2b_send_admin_alert"},
  createNotification: jest.fn().mockResolvedValue({notificationId: "notif_send_1"}),
  sendPushNotification: jest.fn().mockResolvedValue(undefined),
  resolvePlatformAdminUserIds: jest.fn().mockResolvedValue(["admin_1"]),
}));

const {collection} = require("../libs/firestore");
const walletService = require("../services/walletService");
const partnerRecipientService = require("../services/partnerRecipientService");
const partnerService = require("../services/partnerService");
const {createNotification} = require("../utils/notifications");
const b2bSendService = require("../services/b2bSendService");

describe("b2bSendService.quoteSend", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    collection.mockReturnValue({
      doc: () => ({
        get: jest.fn().mockResolvedValue({exists: false}),
      }),
    });
    walletService.getOrCreatePartnerWallet.mockResolvedValue({
      walletId: "w1",
      balances: {USD: 5250, KES: 0},
    });
  });

  it("returns image-3 style fee breakdown for USD → AED", async () => {
    const quote = await b2bSendService.quoteSend({
      partnerId: "partner_1",
      amount: 1000,
      fromCurrency: "USD",
      toCurrency: "AED",
    });

    expect(quote.rate).toBe(3.6732);
    expect(quote.youSend).toBe(1000);
    expect(quote.recipientGets).toBe(3673.2);
    expect(quote.fees.ourFee).toBe(5);
    expect(quote.fees.paymentFee).toBe(0);
    expect(quote.fees.totalFees).toBe(5);
    expect(quote.totalDeduction).toBe(1005);
    expect(quote.availableBalance).toBe(5250);
    expect(quote.sufficientBalance).toBe(true);
    expect(quote.rateLabel).toContain("USD");
  });

  it("rejects unknown corridors", async () => {
    await expect(b2bSendService.quoteSend({
      partnerId: "partner_1",
      amount: 100,
      fromCurrency: "USD",
      toCurrency: "NGN",
    })).rejects.toMatchObject({code: "CORRIDOR_NOT_FOUND"});
  });
});

describe("b2bSendService.createSendPayment", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const set = jest.fn().mockResolvedValue(undefined);
    collection.mockImplementation((name) => {
      if (name === "config") {
        return {
          doc: () => ({
            get: jest.fn().mockResolvedValue({exists: false}),
          }),
        };
      }
      return {
        doc: () => ({set, get: jest.fn()}),
      };
    });
    walletService.getOrCreatePartnerWallet.mockResolvedValue({
      walletId: "w1",
      balances: {USD: 5250},
    });
    walletService.updatePartnerWalletBalance.mockResolvedValue({
      previousBalance: 5250,
      newBalance: 4245,
    });
    partnerService.getPartner.mockResolvedValue({id: "partner_1", name: "Acme Hotel"});
    partnerRecipientService.getRecipient.mockResolvedValue({
      id: "rcpt_1",
      displayName: "Dubai Merchant",
      currency: "AED",
      deliveryMethod: "bank_transfer",
      bankName: "Emirates NBD",
      accountName: "Dubai Merchant LLC",
      accountNumber: "AE070331234567890123456",
      country: "AE",
    });
  });

  it("debits wallet, creates payment, notifies admin", async () => {
    const result = await b2bSendService.createSendPayment({
      partnerId: "partner_1",
      actorUid: "uid_1",
      amount: 1000,
      fromCurrency: "USD",
      toCurrency: "AED",
      recipientId: "rcpt_1",
      paymentReference: "INV-1",
    });

    expect(result.payment.status).toBe("pending");
    expect(result.payment.totalDeduction).toBe(1005);
    expect(result.wallet.newBalance).toBe(4245);
    expect(walletService.updatePartnerWalletBalance).toHaveBeenCalledWith(
        "partner_1",
        "USD",
        -1005,
    );
    expect(createNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "b2b_send_admin_alert",
          userId: null,
          metadata: expect.objectContaining({
            bankName: "Emirates NBD",
            accountName: "Dubai Merchant LLC",
            accountNumber: "AE070331234567890123456",
            country: "AE",
            paymentReference: "INV-1",
          }),
        }),
    );
  });

  it("rejects insufficient balance", async () => {
    walletService.getOrCreatePartnerWallet.mockResolvedValue({
      walletId: "w1",
      balances: {USD: 10},
    });

    await expect(b2bSendService.createSendPayment({
      partnerId: "partner_1",
      actorUid: "uid_1",
      amount: 1000,
      fromCurrency: "USD",
      toCurrency: "AED",
      recipientId: "rcpt_1",
    })).rejects.toMatchObject({code: "INSUFFICIENT_BALANCE"});
  });
});

describe("b2bSendService.resolveSendPayment", () => {
  const pendingData = {
    partnerId: "partner_1",
    status: "pending",
    fromCurrency: "KES",
    toCurrency: "AED",
    youSend: 20000,
    recipientGets: 565,
    totalDeduction: 20000,
    transactionRecordId: "txr_send_1",
    paymentReference: "bmw tyers",
  };

  let stored;

  beforeEach(() => {
    jest.clearAllMocks();
    stored = {...pendingData};
    const get = jest.fn().mockImplementation(async () => ({
      exists: true,
      id: "spay_1",
      data: () => stored,
    }));
    const set = jest.fn().mockImplementation(async (patch) => {
      stored = {...stored, ...patch};
    });
    collection.mockReturnValue({
      doc: () => ({get, set}),
    });
    walletService.updatePartnerWalletBalance.mockResolvedValue({
      previousBalance: 0,
      newBalance: 20000,
    });
  });

  it("marks success without crediting the wallet", async () => {
    const result = await b2bSendService.resolveSendPayment({
      paymentId: "spay_1",
      status: "success",
      actorUid: "admin_1",
    });

    expect(result.payment.status).toBe("completed");
    expect(result.reversal).toBeNull();
    expect(walletService.updatePartnerWalletBalance).not.toHaveBeenCalled();
  });

  it("fails and credits totalDeduction back", async () => {
    const result = await b2bSendService.resolveSendPayment({
      paymentId: "spay_1",
      status: "failed",
      actorUid: "admin_1",
      failureReason: "Bank rejected",
    });

    expect(result.payment.status).toBe("failed");
    expect(result.payment.reversed).toBe(true);
    expect(result.reversal).toEqual({
      amount: 20000,
      currency: "KES",
      previousBalance: 0,
      newBalance: 20000,
    });
    expect(walletService.updatePartnerWalletBalance).toHaveBeenCalledWith(
        "partner_1",
        "KES",
        20000,
    );
  });

  it("rejects changing an already completed send", async () => {
    stored.status = "completed";
    await expect(b2bSendService.resolveSendPayment({
      paymentId: "spay_1",
      status: "failed",
    })).rejects.toMatchObject({code: "ALREADY_RESOLVED", statusCode: 409});
  });
});
