/**
 * @fileoverview Unit tests for platform admin partner wallet credit/debit.
 */

jest.mock("../services/walletService");
jest.mock("../services/partnerService");
jest.mock("../services/transactionService", () => ({
  TRANSACTION_TYPES: {b2b_admin_topup: "b2b_admin_topup"},
  STATUSES: {completed: "completed"},
  createTransactionRecord: jest.fn().mockResolvedValue({transactionId: "txr_admin_1"}),
}));

const walletService = require("../services/walletService");
const partnerService = require("../services/partnerService");
const partnerWalletAdminService = require("../services/partnerWalletAdminService");

describe("partnerWalletAdminService.creditPartnerWallet", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    partnerService.getPartner.mockResolvedValue({id: "partner_1", name: "Acme Hotel"});
    walletService.getOrCreatePartnerWallet.mockResolvedValue({
      walletId: "wallet_1",
      balances: {KES: 0, USD: 0, USDT: 0},
    });
    walletService.updatePartnerWalletBalance.mockResolvedValue({
      previousBalance: 0,
      newBalance: 5000,
    });
    walletService.getPartnerWallet.mockResolvedValue({
      walletId: "wallet_1",
      balances: {KES: 5000, USD: 0, USDT: 0},
    });
  });

  it("credits partner wallet and returns transaction", async () => {
    const result = await partnerWalletAdminService.creditPartnerWallet({
      partnerId: "partner_1",
      amount: 5000,
      currency: "KES",
      description: "Manual top-up",
      actorUid: "admin_1",
    });

    expect(walletService.updatePartnerWalletBalance).toHaveBeenCalledWith(
        "partner_1",
        "KES",
        5000,
    );
    expect(result.transaction).toMatchObject({
      type: "credit",
      amount: 5000,
      currency: "KES",
      previousBalance: 0,
      newBalance: 5000,
    });
    expect(result.wallet.balances.KES).toBe(5000);
  });

  it("rejects invalid amount", async () => {
    await expect(partnerWalletAdminService.creditPartnerWallet({
      partnerId: "partner_1",
      amount: 0,
      actorUid: "admin_1",
    })).rejects.toMatchObject({code: "INVALID_AMOUNT"});
  });
});
