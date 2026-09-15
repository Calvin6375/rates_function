/**
 * @fileoverview Hierarchical Turnkey customer deposit addresses.
 */

const ADDR_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ADDR_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ADDR_P = "0xdddddddddddddddddddddddddddddddddddddddd";
const TREASURY = "0x952bBC4952A98a49E112d06DBaAe0FAA37eF080A";
const PRODUCTION_PARENT = "ba3dfc05-1024-5ef0-bf1c-7b5c009a582b";

const mockWalletStore = new Map();
const mockCounters = new Map();

function mockGetCounter(id) {
  if (!mockCounters.has(id)) {
    mockCounters.set(id, {nextIndex: 0, parentTurnkeyWalletId: null});
  }
  return mockCounters.get(id);
}

jest.mock("../../admin", () => ({
  firestore: jest.fn(() => ({
    runTransaction: async (fn) => fn({
      get: async (ref) => {
        if (String(ref.id || "").startsWith("turnkey_")) {
          const row = mockWalletStore.get(ref.id);
          return {exists: !!row, id: ref.id, data: () => row};
        }
        const row = mockGetCounter(ref.id);
        return {exists: true, data: () => row};
      },
      set: (ref, data) => {
        if (String(ref.id || "").startsWith("turnkey_")) {
          const prev = mockWalletStore.get(ref.id) || {};
          mockWalletStore.set(ref.id, {...prev, ...data});
        } else {
          const prev = mockGetCounter(ref.id);
          mockCounters.set(ref.id, {...prev, ...data});
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
          const row = mockGetCounter(id);
          return {exists: true, id, data: () => row};
        }),
        set: jest.fn(async (data) => {
          if (name === "cryptoWallets") {
            const prev = mockWalletStore.get(id) || {};
            mockWalletStore.set(id, {...prev, ...data});
            return;
          }
          const prev = mockGetCounter(id);
          mockCounters.set(id, {...prev, ...data});
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
    mockCounters.clear();
    mockCounters.set("avalanche-fuji_USDC", {nextIndex: 0, parentTurnkeyWalletId: "parent_1"});
    jest.clearAllMocks();
    mockClient.createWalletAccounts.mockImplementation(async ({walletId, accounts}) => {
      const path = accounts[0].path;
      if (walletId === PRODUCTION_PARENT) {
        if (path === "m/44'/60'/0'/0/0") return {addresses: [ADDR_P]};
        return {addresses: ["0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"]};
      }
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
    const failed = mockWalletStore.get("turnkey_userC_avalanche-fuji_USDC");
    expect(!failed || failed.status !== "live").toBe(true);
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

describe("allocateProductionCustomerDepositAddress", () => {
  beforeEach(() => {
    mockWalletStore.clear();
    mockCounters.clear();
    mockCounters.set("avalanche-fuji_USDC", {
      nextIndex: 9,
      parentTurnkeyWalletId: "parent_1",
    });
    mockCounters.set("avalanche_USDC", {
      nextIndex: 0,
      parentTurnkeyWalletId: PRODUCTION_PARENT,
    });
    jest.clearAllMocks();
    mockClient.createWalletAccounts.mockImplementation(async ({walletId, accounts}) => {
      const path = accounts[0].path;
      if (walletId === PRODUCTION_PARENT && path === "m/44'/60'/0'/0/0") {
        return {addresses: [ADDR_P]};
      }
      if (path === "m/44'/60'/0'/0/0") return {addresses: [ADDR_A]};
      return {addresses: [ADDR_B]};
    });
    mockClient.getWalletAccounts.mockResolvedValue({accounts: []});
  });

  it("creates a production wallet when the user has none", async () => {
    const {wallet, created} =
      await hierarchicalAccountService.allocateProductionCustomerDepositAddress("userA");
    expect(created).toBe(true);
    expect(wallet.network).toBe("avalanche");
    expect(wallet.address).toBe(ADDR_P);
    expect(wallet.turnkeyWalletId).toBe(PRODUCTION_PARENT);
    expect(wallet.derivationIndex).toBe(0);
    expect(wallet.derivationPath).toBe("m/44'/60'/0'/0/0");
    expect(wallet.id).toBe("turnkey_userA_avalanche_USDC");
    expect(wallet.chainId).toBe(43114);
  });

  it("keeps an existing hierarchical Fuji wallet and creates production separately", async () => {
    mockWalletStore.set("turnkey_userA_avalanche-fuji_USDC", {
      userId: "userA",
      provider: "turnkey",
      status: "live",
      network: "avalanche-fuji",
      asset: "USDC",
      address: ADDR_A,
      derivationIndex: 0,
      turnkeyWalletId: "parent_1",
    });
    const {wallet} = await hierarchicalAccountService.allocateProductionCustomerDepositAddress("userA");
    expect(wallet.address).toBe(ADDR_P);
    expect(wallet.network).toBe("avalanche");
    const fuji = mockWalletStore.get("turnkey_userA_avalanche-fuji_USDC");
    expect(fuji.address).toBe(ADDR_A);
    expect(fuji.network).toBe("avalanche-fuji");
    expect(mockGetCounter("avalanche-fuji_USDC").nextIndex).toBe(9);
  });

  it("keeps a legacy Fuji wallet and creates production separately", async () => {
    mockWalletStore.set("legacy_fuji_userA", {
      userId: "userA",
      provider: "turnkey",
      status: "live",
      network: "avalanche-fuji",
      asset: "USDC",
      address: ADDR_A,
      walletId: "legacy_personal_wallet",
    });
    const {wallet} = await hierarchicalAccountService.allocateProductionCustomerDepositAddress("userA");
    expect(wallet.address).toBe(ADDR_P);
    expect(mockWalletStore.get("legacy_fuji_userA").address).toBe(ADDR_A);
  });

  it("returns the existing production address without creating another Turnkey account", async () => {
    mockWalletStore.set("turnkey_userA_avalanche_USDC", {
      userId: "userA",
      provider: "turnkey",
      status: "live",
      network: "avalanche",
      asset: "USDC",
      address: ADDR_P,
      turnkeyWalletId: PRODUCTION_PARENT,
      derivationIndex: 4,
    });
    const first = await hierarchicalAccountService.allocateProductionCustomerDepositAddress("userA");
    const second = await hierarchicalAccountService.allocateProductionCustomerDepositAddress("userA");
    expect(first.created).toBe(false);
    expect(second.created).toBe(false);
    expect(first.wallet.address).toBe(ADDR_P);
    expect(second.wallet.address).toBe(ADDR_P);
    expect(mockClient.createWalletAccounts).not.toHaveBeenCalled();
    expect(mockGetCounter("avalanche_USDC").nextIndex).toBe(0);
  });

  it("uses an independent production counter and never writes the Fuji counter", async () => {
    await hierarchicalAccountService.allocateProductionCustomerDepositAddress("userA");
    expect(mockGetCounter("avalanche_USDC").nextIndex).toBe(1);
    expect(mockGetCounter("avalanche_USDC").parentTurnkeyWalletId).toBe(PRODUCTION_PARENT);
    expect(mockGetCounter("avalanche-fuji_USDC").nextIndex).toBe(9);
    expect(mockGetCounter("avalanche-fuji_USDC").parentTurnkeyWalletId).toBe("parent_1");
  });

  it("does not consume a production index for a dormant user", async () => {
    expect(mockGetCounter("avalanche_USDC").nextIndex).toBe(0);
    expect(mockWalletStore.size).toBe(0);
  });

  it("concurrent production allocation yields one address", async () => {
    mockWalletStore.set("turnkey_userA_avalanche_USDC", {
      userId: "userA",
      provider: "turnkey",
      status: "live",
      network: "avalanche",
      asset: "USDC",
      address: ADDR_P,
      turnkeyWalletId: PRODUCTION_PARENT,
      derivationIndex: 0,
    });
    const results = await Promise.all([
      hierarchicalAccountService.allocateProductionCustomerDepositAddress("userA"),
      hierarchicalAccountService.allocateProductionCustomerDepositAddress("userA"),
    ]);
    expect(results[0].wallet.address).toBe(ADDR_P);
    expect(results[1].wallet.address).toBe(ADDR_P);
    expect(mockClient.createWalletAccounts).not.toHaveBeenCalled();
  });

  it("recovers a Turnkey account after a failed Firestore persist instead of allocating again", async () => {
    mockWalletStore.set("turnkey_userA_avalanche_USDC", {
      userId: "userA",
      provider: "turnkey",
      status: "provisioning",
      network: "avalanche",
      asset: "USDC",
      derivationIndex: 0,
      parentTurnkeyWalletId: PRODUCTION_PARENT,
    });
    mockClient.getWalletAccounts.mockResolvedValue({
      accounts: [{
        path: "m/44'/60'/0'/0/0",
        address: ADDR_P,
        walletAccountId: "acct_prod_0",
      }],
    });
    const {wallet, created} =
      await hierarchicalAccountService.allocateProductionCustomerDepositAddress("userA");
    expect(created).toBe(false);
    expect(wallet.address).toBe(ADDR_P);
    expect(wallet.status).toBe("live");
    expect(mockClient.createWalletAccounts).not.toHaveBeenCalled();
    expect(mockGetCounter("avalanche_USDC").nextIndex).toBe(0);
  });

  it("does not persist a live wallet when Turnkey creation fails", async () => {
    mockClient.createWalletAccounts.mockRejectedValue(new Error("turnkey down"));
    await expect(hierarchicalAccountService.allocateProductionCustomerDepositAddress("userA"))
        .rejects.toThrow(/turnkey down|createWalletAccounts/i);
    const row = mockWalletStore.get("turnkey_userA_avalanche_USDC");
    expect(!row || row.status !== "live").toBe(true);
  });

  it("refuses to assign the treasury address on production", async () => {
    mockClient.createWalletAccounts.mockResolvedValue({addresses: [TREASURY]});
    await expect(hierarchicalAccountService.allocateProductionCustomerDepositAddress("userC"))
        .rejects.toThrow(/treasury/i);
  });

  it("refuses to create a Fuji address after a production wallet exists", async () => {
    mockWalletStore.set("turnkey_userA_avalanche_USDC", {
      userId: "userA",
      provider: "turnkey",
      status: "live",
      network: "avalanche",
      asset: "USDC",
      address: ADDR_P,
    });
    await expect(hierarchicalAccountService.allocateCustomerDepositAddress("userA"))
        .rejects.toMatchObject({code: "PRODUCTION_WALLET_EXISTS"});
    expect(mockWalletStore.has("turnkey_userA_avalanche-fuji_USDC")).toBe(false);
  });
});
