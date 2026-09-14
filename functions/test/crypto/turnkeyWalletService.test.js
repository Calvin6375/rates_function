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

jest.mock("../../services/crypto/turnkey/turnkeyClient", () => ({
  isTurnkeyConfigured: jest.fn(() => true),
  getApiClient: jest.fn(),
}));

const firestore = require("../../libs/firestore");
const turnkeyClient = require("../../services/crypto/turnkey/turnkeyClient");
const turnkeyWalletService = require("../../services/crypto/turnkey/turnkeyWalletService");

describe("turnkeyWalletService", () => {
  beforeEach(() => {
    firestore.__store.docs = [];
    jest.clearAllMocks();
    turnkeyClient.isTurnkeyConfigured.mockReturnValue(true);
  });

  it("creates a unique Turnkey wallet and persists metadata", async () => {
    turnkeyClient.getApiClient.mockReturnValue({
      createWallet: jest.fn(async () => ({
        walletId: "tk-wallet-1",
        addresses: ["0x1111111111111111111111111111111111111111"],
      })),
    });

    const wallet = await turnkeyWalletService.createWallet("user_a");
    expect(wallet.provider).toBe("turnkey");
    expect(wallet.walletId).toBe("tk-wallet-1");
    expect(wallet.address).toBe("0x1111111111111111111111111111111111111111");
    expect(wallet.addressLower).toBe("0x1111111111111111111111111111111111111111");
    expect(wallet.network).toBe("avalanche-fuji");
    expect(wallet.chainId).toBe(43113);
    expect(wallet.blockchain).toBe("AVALANCHE");
    expect(wallet.asset).toBe("USDC");
    expect(wallet.status).toBe("live");
    expect(wallet.userId).toBe("user_a");
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
    const createWallet = jest.fn();
    turnkeyClient.getApiClient.mockReturnValue({createWallet});

    const wallet = await turnkeyWalletService.createWallet("user_a");
    expect(wallet.walletId).toBe("tk-existing");
    expect(createWallet).not.toHaveBeenCalled();
  });

  it("refuses to assign the treasury address to a customer", async () => {
    turnkeyClient.getApiClient.mockReturnValue({
      createWallet: jest.fn(async () => ({
        walletId: "tk-treasury",
        addresses: ["0x952bBC4952A98a49E112d06DBaAe0FAA37eF080A"],
      })),
    });
    await expect(turnkeyWalletService.createWallet("user_b"))
        .rejects.toThrow(/treasury/i);
  });

  it("fails clearly when Turnkey is not configured", async () => {
    turnkeyClient.isTurnkeyConfigured.mockReturnValue(false);
    await expect(turnkeyWalletService.createWallet("user_c"))
        .rejects.toThrow(/not configured/i);
  });
});
