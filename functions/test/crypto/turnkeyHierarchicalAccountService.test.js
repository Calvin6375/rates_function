/**
 * @fileoverview Hierarchical Turnkey customer deposit addresses.
 */

const ADDR_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ADDR_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TREASURY = "0x952bBC4952A98a49E112d06DBaAe0FAA37eF080A";

const mockWalletStore = new Map();
let mockCounter = {nextIndex: 0, parentTurnkeyWalletId: "parent_1"};

jest.mock("../../admin", () => ({
  firestore: jest.fn(() => ({
    runTransaction: async (fn) => fn({
      get: async (ref) => {
        if (String(ref.id || "").startsWith("turnkey_")) {
          const row = mockWalletStore.get(ref.id);
          return {exists: !!row, id: ref.id, data: () => row};
        }
        return {exists: true, data: () => mockCounter};
      },
      set: (ref, data) => {
        if (String(ref.id || "").startsWith("turnkey_")) {
          const prev = mockWalletStore.get(ref.id) || {};
          mockWalletStore.set(ref.id, {...prev, ...data});
        } else {
          mockCounter = {...mockCounter, ...data};
        }
      },
    }),
  })),
}));

jest.mock("../../libs/firestore", () => ({
  collection: jest.fn((name) => {
    const state = {userId: null, addressLower: null};
    const api = {
      doc: jest.fn((id) => ({
        id,
        get: jest.fn(async () => {
          if (name === "cryptoWallets") {
            const row = mockWalletStore.get(id);
            return {exists: !!row, id, data: () => row};
          }
          return {exists: true, data: () => mockCounter};
        }),
        set: jest.fn(async (data) => {
          if (name === "cryptoWallets") {
            const prev = mockWalletStore.get(id) || {};
            mockWalletStore.set(id, {...prev, ...data});
          } else {
            mockCounter = {...mockCounter, ...data};
          }
        }),
        delete: jest.fn(async () => {
          mockWalletStore.delete(id);
        }),
      })),
      where: jest.fn((field, _op, value) => {
        if (field === "userId") state.userId = value;
        if (field === "addressLower") state.addressLower = value;
        return api;
      }),
      get: jest.fn(async () => {
        const docs = [...mockWalletStore.entries()]
            .filter(([, data]) => {
              if (state.userId && data.userId !== state.userId) return false;
              if (state.addressLower && data.addressLower !== state.addressLower) return false;
              return true;
            })
            .map(([id, data]) => ({
              id,
              data: () => data,
            }));
        return {empty: docs.length === 0, docs};
      }),
    };
    return api;
  }),
  serverTimestamp: jest.fn(() => "ts"),
}));

const mockClient = {
  getWallets: jest.fn(async () => ({wallets: [{walletName: "TruePay Customer Deposits Dev", walletId: "parent_1"}]})),
  createWallet: jest.fn(),
  createWalletAccounts: jest.fn(),
  getWalletAccounts: jest.fn(async () => ({accounts: []})),
};

jest.mock("../../services/crypto/turnkey/turnkeyClient", () => ({
  isTurnkeyConfigured: jest.fn(() => true),
  getApiClient: jest.fn(() => mockClient),
}));

const hierarchicalAccountService = require("../../services/crypto/turnkey/turnkeyHierarchicalAccountService");

describe("ethereumAccountAtIndex", () => {
  it("uses the Turnkey SDK BIP32 paths", () => {
    expect(hierarchicalAccountService.ethereumAccountAtIndex(0).path).toBe("m/44'/60'/0'/0/0");
    expect(hierarchicalAccountService.ethereumAccountAtIndex(1).path).toBe("m/44'/60'/1'/0/0");
    expect(hierarchicalAccountService.ethereumAccountAtIndex(2).path).toBe("m/44'/60'/2'/0/0");
  });
});

describe("allocateCustomerDepositAddress", () => {
  beforeEach(() => {
    mockWalletStore.clear();
    mockCounter = {nextIndex: 0, parentTurnkeyWalletId: "parent_1"};
    jest.clearAllMocks();
    mockClient.createWalletAccounts.mockImplementation(async ({accounts}) => {
      const path = accounts[0].path;
      if (path === "m/44'/60'/0'/0/0") return {addresses: [ADDR_A]};
      if (path === "m/44'/60'/1'/0/0") return {addresses: [ADDR_B]};
      return {addresses: ["0xcccccccccccccccccccccccccccccccccccccccc"]};
    });
    mockClient.getWalletAccounts.mockResolvedValue({accounts: []});
  });

  it("assigns a unique address and derivation index to a new user", async () => {
    const {wallet, created} = await hierarchicalAccountService.allocateCustomerDepositAddress("userA");
    expect(created).toBe(true);
    expect(wallet.userId).toBe("userA");
    expect(wallet.address).toBe(ADDR_A);
    expect(wallet.network).toBe("avalanche-fuji");
    expect(wallet.asset).toBe("USDC");
    expect(wallet.derivationIndex).toBe(0);
    expect(wallet.derivationPath).toBe("m/44'/60'/0'/0/0");
    expect(wallet.turnkeyWalletId).toBe("parent_1");
  });

  it("returns the same live address on a second call", async () => {
    const first = await hierarchicalAccountService.allocateCustomerDepositAddress("userA");
    const second = await hierarchicalAccountService.allocateCustomerDepositAddress("userA");
    expect(second.created).toBe(false);
    expect(second.wallet.address).toBe(first.wallet.address);
    expect(mockClient.createWalletAccounts).toHaveBeenCalledTimes(1);
  });

  it("gives two users different addresses and indexes", async () => {
    const a = await hierarchicalAccountService.allocateCustomerDepositAddress("userA");
    const b = await hierarchicalAccountService.allocateCustomerDepositAddress("userB");
    expect(a.wallet.address).not.toBe(b.wallet.address);
    expect(a.wallet.derivationIndex).toBe(0);
    expect(b.wallet.derivationIndex).toBe(1);
    expect(a.wallet.turnkeyWalletId).toBe(b.wallet.turnkeyWalletId);
  });

  it("refuses to assign the treasury address", async () => {
    mockClient.createWalletAccounts.mockResolvedValue({addresses: [TREASURY]});
    await expect(hierarchicalAccountService.allocateCustomerDepositAddress("userC"))
        .rejects.toThrow(/treasury/i);
  });

  it("does not create a second live address when a reservation already exists", async () => {
    mockWalletStore.set("turnkey_userA_avalanche-fuji_USDC", {
      userId: "userA",
      provider: "turnkey",
      status: "live",
      network: "avalanche-fuji",
      asset: "USDC",
      address: ADDR_A,
    });
    const first = hierarchicalAccountService.allocateCustomerDepositAddress("userA");
    const second = hierarchicalAccountService.allocateCustomerDepositAddress("userA");
    const results = await Promise.all([first, second]);
    expect(results[0].wallet.address).toBe(ADDR_A);
    expect(results[1].wallet.address).toBe(ADDR_A);
    expect(mockClient.createWalletAccounts).not.toHaveBeenCalled();
  });
});
