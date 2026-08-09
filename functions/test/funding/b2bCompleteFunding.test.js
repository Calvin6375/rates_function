/**
 * @fileoverview Unit tests for B2B self-topup funding completion.
 */

jest.mock("../../libs/firestore", () => ({
  collection: jest.fn(),
  serverTimestamp: jest.fn(() => ({ _serverTimestamp: true })),
}));
jest.mock("../../services/funding/fundingOrderService");
jest.mock("../../services/walletService");
jest.mock("../../utils/transactions", () => ({
  logTransaction: jest.fn(),
  generateTransactionId: jest.fn(),
}));
jest.mock("../../services/ledgerService", () => ({
  createDoubleEntry: jest.fn(),
}));

const { collection } = require("../../libs/firestore");
const fundingOrderService = require("../../services/funding/fundingOrderService");
const walletService = require("../../services/walletService");
const transactionService = require("../../services/transactionService");

describe("completeFundingOrder B2B self-topup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fundingOrderService.updateFundingOrder.mockImplementation(async (id, patch) => ({
      id,
      ...patch,
    }));
    walletService.getOrCreatePartnerWallet.mockResolvedValue({
      walletId: "wallet_1",
      balances: { KES: 0 },
    });
    walletService.updatePartnerWalletBalance.mockResolvedValue({
      previousBalance: 0,
      newBalance: 5000,
    });
    walletService.creditUserFiat = jest.fn();

    const set = jest.fn().mockResolvedValue(undefined);
    collection.mockReturnValue({
      doc: jest.fn(() => ({ set, update: jest.fn().mockResolvedValue(undefined) })),
    });
  });

  it("credits partner wallet instead of user fiat", async () => {
    const result = await transactionService.completeFundingOrder({
      fundingOrder: {
        id: "fund_b2b_1",
        userId: "uid_1",
        provider: "paystack",
        amount: 5000,
        currency: "KES",
        status: "pending",
        providerReference: "fund_b2b_1",
        metadata: {
          product: "b2b_self_topup",
          partnerId: "partner_1",
          requestedAmount: 5000,
          requestedCurrency: "KES",
        },
      },
      verifiedEvent: {
        providerReference: "fund_b2b_1",
        providerTransactionId: "txn_1",
        amount: 5000,
        currency: "KES",
        status: "success",
      },
    });

    expect(result.success).toBe(true);
    expect(walletService.updatePartnerWalletBalance).toHaveBeenCalledWith(
        "partner_1",
        "KES",
        5000,
    );
    expect(walletService.creditUserFiat).not.toHaveBeenCalled();
    expect(fundingOrderService.updateFundingOrder).toHaveBeenCalledWith(
        "fund_b2b_1",
        expect.objectContaining({ status: "completed" }),
    );
  });

  it("isB2bSelfTopupOrder detects product marker", () => {
    expect(transactionService.isB2bSelfTopupOrder({
      metadata: { product: "b2b_self_topup" },
    })).toBe(true);
    expect(transactionService.isB2bSelfTopupOrder({
      metadata: { product: "tourist" },
    })).toBe(false);
  });
});
