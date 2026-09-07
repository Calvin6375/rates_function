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
jest.mock("../../libs/b2bPayments", () => ({
  lookupB2bInvoiceMapping: jest.fn(),
  processB2bPaymentWebhook: jest.fn(),
}));

const { collection } = require("../../libs/firestore");
const fundingOrderService = require("../../services/funding/fundingOrderService");
const walletService = require("../../services/walletService");
const b2bPayments = require("../../libs/b2bPayments");
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

  it("isB2bSelfTopupOrder treats partnerId / portal source as B2B", () => {
    expect(transactionService.isB2bSelfTopupOrder({
      metadata: { partnerId: "partner_1" },
    })).toBe(true);
    expect(transactionService.isB2bSelfTopupOrder({
      metadata: { source: "b2b_portal_add_money" },
    })).toBe(true);
  });

  it("does not treat payment-link orders as Add Money", () => {
    const order = {
      metadata: {
        product: "b2b_payment_link",
        partnerId: "partner_1",
        source: "b2b_payment_link",
      },
    };
    expect(transactionService.isB2bPaymentLinkOrder(order)).toBe(true);
    expect(transactionService.isB2bSelfTopupOrder(order)).toBe(false);
  });

  it("settles payment-link orders via processB2bPaymentWebhook using requested currency", async () => {
    b2bPayments.lookupB2bInvoiceMapping.mockResolvedValue({
      mappingDocId: "fund_pl_1",
      partnerId: "partner_1",
      linkId: "pl_1",
      amount: 25,
      currency: "USD",
      rail: "paystack",
    });
    b2bPayments.processB2bPaymentWebhook.mockResolvedValue({
      success: true,
      partnerId: "partner_1",
    });

    const result = await transactionService.completeFundingOrder({
      fundingOrder: {
        id: "fund_pl_1",
        userId: "partner:partner_1",
        provider: "paystack",
        amount: 3250,
        currency: "KES",
        status: "pending",
        providerReference: "fund_pl_1",
        metadata: {
          product: "b2b_payment_link",
          partnerId: "partner_1",
          linkId: "pl_1",
          requestedAmount: 25,
          requestedCurrency: "USD",
        },
      },
      verifiedEvent: {
        providerReference: "fund_pl_1",
        providerTransactionId: "txn_pl",
        amount: 3250,
        currency: "KES",
        status: "success",
      },
    });

    expect(result.success).toBe(true);
    expect(walletService.updatePartnerWalletBalance).not.toHaveBeenCalled();
    expect(b2bPayments.processB2bPaymentWebhook).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentId: "fund_pl_1",
          amount: 25,
          currency: "USD",
        }),
        expect.objectContaining({ source: "paystack" }),
        expect.objectContaining({ partnerId: "partner_1", linkId: "pl_1" }),
    );
    expect(fundingOrderService.updateFundingOrder).toHaveBeenCalledWith(
        "fund_pl_1",
        expect.objectContaining({ status: "completed" }),
    );
  });

  it("credits partner wallet when product missing but partnerId present", async () => {
    const result = await transactionService.completeFundingOrder({
      fundingOrder: {
        id: "fund_b2b_2",
        userId: "uid_1",
        provider: "paystack",
        amount: 50,
        currency: "KES",
        status: "pending",
        providerReference: "fund_b2b_2",
        metadata: {
          partnerId: "partner_1",
          source: "b2b_portal_add_money",
          requestedAmount: 50,
          requestedCurrency: "KES",
        },
      },
      verifiedEvent: {
        providerReference: "fund_b2b_2",
        providerTransactionId: "txn_2",
        amount: 50,
        currency: "KES",
        status: "success",
      },
    });

    expect(result.success).toBe(true);
    expect(walletService.updatePartnerWalletBalance).toHaveBeenCalledWith(
        "partner_1",
        "KES",
        50,
    );
    expect(walletService.creditUserFiat).not.toHaveBeenCalled();
  });
});
