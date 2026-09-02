/**
 * @fileoverview Tests for B2B users.* → partner wallet balance migration.
 */

jest.mock("../libs/firestore", () => ({
  collection: jest.fn(),
  serverTimestamp: jest.fn(() => ({_serverTimestamp: true})),
}));
jest.mock("../utils/customClaimsMerge", () => ({
  getCustomClaims: jest.fn().mockResolvedValue({partnerId: "partner_1"}),
}));
jest.mock("../services/walletService");

const {collection} = require("../libs/firestore");
const walletService = require("../services/walletService");
const b2bWalletBalanceSync = require("../services/b2bWalletBalanceSync");

describe("b2bWalletBalanceSync", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    walletService.getOrCreatePartnerWallet.mockResolvedValue({
      walletId: "w1",
      balances: {USD: 0, KES: 0, USDT: 0},
    });
    walletService.updatePartnerWalletBalance.mockResolvedValue({
      previousBalance: 0,
      newBalance: 50000,
    });
    walletService.getPartnerWallet.mockResolvedValue({
      walletId: "w1",
      balances: {USD: 0, KES: 50000, USDT: 0},
    });
  });

  it("migrates stranded users.kesBalance into partner wallet once", async () => {
    const set = jest.fn().mockResolvedValue(undefined);
    collection.mockImplementation((name) => {
      if (name === "users") {
        return {
          doc: () => ({
            get: jest.fn().mockResolvedValue({
              exists: true,
              data: () => ({
                channel: "B2B",
                institution: "PartnerDashboard",
                kesBalance: 50000,
                KES: 50000,
              }),
            }),
            set,
          }),
        };
      }
      return {doc: () => ({get: jest.fn(), set: jest.fn()})};
    });

    const result = await b2bWalletBalanceSync.migrateLegacyUserBalancesToPartnerWallet(
        "uid_1",
        "partner_1",
    );

    expect(result.migrated).toBe(true);
    expect(result.moved).toEqual({KES: 50000});
    expect(walletService.updatePartnerWalletBalance).toHaveBeenCalledWith(
        "partner_1",
        "KES",
        50000,
    );
    expect(set).toHaveBeenCalledWith(
        expect.objectContaining({
          kesBalance: 0,
          partnerWalletBalanceMigrated: true,
        }),
        {merge: true},
    );
  });

  it("re-migrates stranded kesBalance even after prior migration flag", async () => {
    const set = jest.fn().mockResolvedValue(undefined);
    collection.mockImplementation((name) => {
      if (name === "users") {
        return {
          doc: () => ({
            get: jest.fn().mockResolvedValue({
              exists: true,
              data: () => ({
                channel: "B2B",
                institution: "PartnerDashboard",
                kesBalance: 50,
                KES: 50,
                partnerWalletBalanceMigrated: true,
              }),
            }),
            set,
          }),
        };
      }
      return {doc: () => ({get: jest.fn(), set: jest.fn()})};
    });

    const result = await b2bWalletBalanceSync.migrateLegacyUserBalancesToPartnerWallet(
        "uid_1",
        "partner_1",
    );
    expect(result.migrated).toBe(true);
    expect(result.moved).toEqual({KES: 50});
    expect(walletService.updatePartnerWalletBalance).toHaveBeenCalledWith(
        "partner_1",
        "KES",
        50,
    );
  });

  it("skips when already migrated and users balances are zero", async () => {
    collection.mockImplementation(() => ({
      doc: () => ({
        get: jest.fn().mockResolvedValue({
          exists: true,
          data: () => ({
            channel: "B2B",
            institution: "PartnerDashboard",
            kesBalance: 0,
            partnerWalletBalanceMigrated: true,
          }),
        }),
        set: jest.fn(),
      }),
    }));

    const result = await b2bWalletBalanceSync.migrateLegacyUserBalancesToPartnerWallet(
        "uid_1",
        "partner_1",
    );
    expect(result.migrated).toBe(false);
    expect(walletService.updatePartnerWalletBalance).not.toHaveBeenCalled();
  });
});
