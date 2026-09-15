/**
 * @fileoverview Turnkey wallet provisioning (unique address per user).
 */

jest.mock("../../libs/firestore", () => {
  const store = {docs: []};
  return {
    __store: store,
    collection: jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      get: jest.fn(async () => ({
        empty: store.docs.length === 0,
        docs: store.docs,
      })),
      add: jest.fn(async (doc) => {
        const id = `wal_${store.docs.length + 1}`;
        store.docs.push({id, data: () => doc, ref: {id}});
        return {id};
      }),
    })),
    serverTimestamp: jest.fn(() => "ts"),
  };
});

jest.mock("../../services/crypto/turnkey/turnkeyHierarchicalAccountService", () => ({
  allocateCustomerDepositAddress: jest.fn(),
}));

const firestore = require("../../libs/firestore");
const hierarchicalAccountService = require("../../services/crypto/turnkey/turnkeyHierarchicalAccountService");
const turnkeyWalletService = require("../../services/crypto/turnkey/turnkeyWalletService");

describe("turnkeyWalletService", () => {
  beforeEach(() => {
    firestore.__store.docs = [];
    jest.clearAllMocks();
    hierarchicalAccountService.allocateCustomerDepositAddress.mockResolvedValue({
      created: true,
      wallet: {
        userId: "user_a",
        provider: "turnkey",
        walletId: "parent_wallet",
        turnkeyWalletId: "parent_wallet",
        address: "0x1111111111111111111111111111111111111111",
        addressLower: "0x1111111111111111111111111111111111111111",
        network: "avalanche-fuji",
        chainId: 43113,
        blockchain: "AVALANCHE",
        asset: "USDC",
        status: "live",
        derivationIndex: 0,
        derivationPath: "m/44'/60'/0'/0/0",
      },
    });
  });

  it("creates a unique hierarchical deposit address and persists metadata", async () => {
    const wallet = await turnkeyWalletService.createWallet("user_a");
    expect(wallet.provider).toBe("turnkey");
    expect(wallet.walletId).toBe("parent_wallet");
    expect(wallet.address).toBe("0x1111111111111111111111111111111111111111");
    expect(wallet.addressLower).toBe("0x1111111111111111111111111111111111111111");
    expect(wallet.network).toBe("avalanche-fuji");
    expect(wallet.chainId).toBe(43113);
    expect(wallet.blockchain).toBe("AVALANCHE");
    expect(wallet.asset).toBe("USDC");
    expect(wallet.status).toBe("live");
    expect(wallet.userId).toBe("user_a");
    expect(wallet.derivationPath).toBe("m/44'/60'/0'/0/0");
    expect(hierarchicalAccountService.allocateCustomerDepositAddress)
        .toHaveBeenCalledWith("user_a");
  });

  it("returns the existing wallet instead of creating another", async () => {
    firestore.__store.docs = [{
      id: "existing",
      data: () => ({
        userId: "user_a",
        provider: "turnkey",
        walletId: "tk-existing",
        address: "0x2222222222222222222222222222222222222222",
      }),
    }];

    const wallet = await turnkeyWalletService.createWallet("user_a");
    expect(wallet.walletId).toBe("tk-existing");
    expect(hierarchicalAccountService.allocateCustomerDepositAddress).not.toHaveBeenCalled();
  });

  it("fails clearly when userId is missing", async () => {
    await expect(turnkeyWalletService.createWallet(""))
        .rejects.toThrow(/userId is required/i);
  });
});
