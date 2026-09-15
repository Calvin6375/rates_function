/**
 * @fileoverview Turnkey wallet provisioning (unique address per user).
 */

jest.mock("../../libs/firestore", () => {
  const store = {docs: [], intents: new Set()};
  return {
    __store: store,
    collection: jest.fn((name) => ({
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      get: jest.fn(async () => ({
        empty: store.docs.length === 0,
        docs: store.docs.map((row) => ({
          id: row.id,
          data: row.data,
          ref: {
            id: row.id,
            delete: jest.fn(async () => {
              store.docs = store.docs.filter((item) => item.id !== row.id);
            }),
          },
        })),
      })),
      doc: jest.fn((id) => ({
        id,
        delete: jest.fn(async () => {
          if (name === "cryptoDepositIntents") {
            store.intents.delete(id);
            return;
          }
          store.docs = store.docs.filter((item) => item.id !== id);
        }),
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
    firestore.__store.intents = new Set();
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

  it("does not return a production wallet when Fuji is requested", async () => {
    firestore.__store.docs = [
      {
        id: "prod",
        data: () => ({
          userId: "user_a",
          provider: "turnkey",
          network: "avalanche",
          asset: "USDC",
          address: "0xdddddddddddddddddddddddddddddddddddddddd",
        }),
      },
      {
        id: "fuji",
        data: () => ({
          userId: "user_a",
          provider: "turnkey",
          network: "avalanche-fuji",
          asset: "USDC",
          address: "0x2222222222222222222222222222222222222222",
        }),
      },
    ];
    const fuji = await turnkeyWalletService.getWallet("user_a");
    const prod = await turnkeyWalletService.getWallet("user_a", {network: "avalanche"});
    expect(fuji.address).toBe("0x2222222222222222222222222222222222222222");
    expect(prod.address).toBe("0xdddddddddddddddddddddddddddddddddddddddd");
  });

  it("reports a Fuji-only user as on testnet and needing mainnet", async () => {
    firestore.__store.docs = [{
      id: "fuji",
      data: () => ({
        userId: "user_a",
        provider: "turnkey",
        network: "avalanche-fuji",
        asset: "USDC",
        status: "live",
        address: "0x2222222222222222222222222222222222222222",
      }),
    }];
    const status = await turnkeyWalletService.getCustomerWalletNetworkStatus("user_a");
    expect(status).toMatchObject({
      success: true,
      userId: "user_a",
      onTestnet: true,
      hasMainnet: false,
      shouldCreateMainnet: true,
    });
    expect(status.testnet.address).toBe("0x2222222222222222222222222222222222222222");
    expect(status.mainnet).toBeNull();
  });

  it("does not ask the app to create mainnet when production already exists", async () => {
    firestore.__store.docs = [
      {
        id: "fuji",
        data: () => ({
          userId: "user_a",
          provider: "turnkey",
          network: "avalanche-fuji",
          asset: "USDC",
          status: "live",
          address: "0x2222222222222222222222222222222222222222",
        }),
      },
      {
        id: "prod",
        data: () => ({
          userId: "user_a",
          provider: "turnkey",
          network: "avalanche",
          asset: "USDC",
          status: "live",
          address: "0xdddddddddddddddddddddddddddddddddddddddd",
        }),
      },
    ];
    const status = await turnkeyWalletService.getCustomerWalletNetworkStatus("user_a");
    expect(status.onTestnet).toBe(true);
    expect(status.hasMainnet).toBe(true);
    expect(status.shouldCreateMainnet).toBe(false);
  });

  it("treats a user with no Fuji wallet as not on testnet", async () => {
    const status = await turnkeyWalletService.getCustomerWalletNetworkStatus("user_a");
    expect(status).toMatchObject({
      onTestnet: false,
      hasMainnet: false,
      shouldCreateMainnet: false,
      testnet: null,
      mainnet: null,
    });
  });

  it("deletes Fuji wallets and leaves the production wallet", async () => {
    firestore.__store.docs = [
      {
        id: "turnkey_user_a_avalanche-fuji_USDC",
        data: () => ({
          userId: "user_a",
          provider: "turnkey",
          network: "avalanche-fuji",
          asset: "USDC",
          address: "0x2222222222222222222222222222222222222222",
        }),
      },
      {
        id: "legacy_fuji_user_a",
        data: () => ({
          userId: "user_a",
          provider: "turnkey",
          network: "avalanche-fuji",
          asset: "USDC",
          address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        }),
      },
      {
        id: "turnkey_user_a_avalanche_USDC",
        data: () => ({
          userId: "user_a",
          provider: "turnkey",
          network: "avalanche",
          asset: "USDC",
          address: "0xdddddddddddddddddddddddddddddddddddddddd",
        }),
      },
      {
        id: "turnkey_user_b_avalanche-fuji_USDC",
        data: () => ({
          userId: "user_b",
          provider: "turnkey",
          network: "avalanche-fuji",
          asset: "USDC",
          address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        }),
      },
    ];
    const result = await turnkeyWalletService.deleteFujiCustomerWallets("user_a");
    const remaining = firestore.__store.docs.map((row) => row.id);
    expect(remaining).toEqual(expect.arrayContaining([
      "turnkey_user_a_avalanche_USDC",
      "turnkey_user_b_avalanche-fuji_USDC",
    ]));
    expect(remaining).not.toContain("turnkey_user_a_avalanche-fuji_USDC");
    expect(remaining).not.toContain("legacy_fuji_user_a");
    expect(result.deleted).toBeGreaterThanOrEqual(2);
  });

  it("does not recreate Fuji after a production wallet exists", async () => {
    firestore.__store.docs = [{
      id: "turnkey_user_a_avalanche_USDC",
      data: () => ({
        userId: "user_a",
        provider: "turnkey",
        network: "avalanche",
        asset: "USDC",
        status: "live",
        address: "0xdddddddddddddddddddddddddddddddddddddddd",
      }),
    }];
    await expect(turnkeyWalletService.createWallet("user_a"))
        .rejects.toThrow(/production address exists/i);
    expect(hierarchicalAccountService.allocateCustomerDepositAddress).not.toHaveBeenCalled();
  });

  it("createWallet never allocates a production address", async () => {
    await turnkeyWalletService.createWallet("user_a");
    expect(hierarchicalAccountService.allocateCustomerDepositAddress).toHaveBeenCalledWith("user_a");
    expect(hierarchicalAccountService.allocateProductionCustomerDepositAddress).toBeUndefined();
  });
});
