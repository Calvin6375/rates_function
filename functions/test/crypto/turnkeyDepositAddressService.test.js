/**
 * @fileoverview Per-customer Fuji USDC deposit address provisioning.
 */

const USER_ID = "customer_test_1";
const ADDRESS = "0x1111111111111111111111111111111111111111";

jest.mock("../../admin", () => ({
  auth: () => ({
    getUser: jest.fn(async (uid) => {
      if (uid === "customer_test_1") return {uid};
      const err = new Error("not found");
      err.code = "auth/user-not-found";
      throw err;
    }),
  }),
}));

jest.mock("../../libs/firestore", () => {
  const mockUserDocs = new Map([["customer_test_1", {exists: true}]]);
  return {
    collection: jest.fn(() => ({
      doc: jest.fn((id) => ({
        id,
        get: jest.fn(async () => mockUserDocs.get(id) || {exists: false}),
        set: jest.fn(async () => undefined),
      })),
    })),
    serverTimestamp: jest.fn(() => "ts"),
  };
});

jest.mock("../../services/crypto/turnkey/turnkeyWalletService", () => ({
  getWallet: jest.fn(),
  createWallet: jest.fn(),
  getWalletByAddress: jest.fn(),
  readTurnkeyAccountId: jest.fn(),
}));

jest.mock("../../services/crypto/turnkey/turnkeyHierarchicalAccountService", () => ({
  findLiveCustomerWallet: jest.fn(),
  allocateCustomerDepositAddress: jest.fn(),
}));

const turnkeyWalletService = require("../../services/crypto/turnkey/turnkeyWalletService");
const hierarchicalAccountService = require("../../services/crypto/turnkey/turnkeyHierarchicalAccountService");
const {
  getOrCreateUserDepositAddress,
} = require("../../services/crypto/turnkey/turnkeyDepositAddressService");
const {assertAdminCaller} = require("../../http/turnkeyDepositHttp");

jest.mock("../../utils/adminClaims", () => ({
  verifyAdminFromToken: jest.fn(),
  isSuperAdmin: jest.fn(),
}));

const {verifyAdminFromToken, isSuperAdmin} = require("../../utils/adminClaims");
const {HttpsError} = require("firebase-functions/v2/https");

describe("getOrCreateUserDepositAddress", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    turnkeyWalletService.getWallet.mockResolvedValue(null);
    hierarchicalAccountService.findLiveCustomerWallet.mockResolvedValue(null);
    hierarchicalAccountService.allocateCustomerDepositAddress.mockResolvedValue({
      created: true,
      wallet: {
      id: "wal_1",
      userId: USER_ID,
      provider: "turnkey",
      walletId: "tk_wallet_1",
      turnkeyWalletId: "tk_wallet_1",
      turnkeyAccountId: "tk_acct_1",
      address: ADDRESS,
      addressLower: ADDRESS,
      network: "avalanche-fuji",
      asset: "USDC",
      status: "live",
    },
    });
  });

  it("creates and persists a unique Fuji deposit address", async () => {
    const result = await getOrCreateUserDepositAddress(USER_ID, "avalanche-fuji");
    expect(result.success).toBe(true);
    expect(result.created).toBe(true);
    expect(result.userId).toBe(USER_ID);
    expect(result.network).toBe("avalanche-fuji");
    expect(result.asset).toBe("USDC");
    expect(result.depositAddress).toBe(ADDRESS);
    expect(result.turnkeyWalletId).toBe("tk_wallet_1");
    expect(result.turnkeyAccountId).toBe("tk_acct_1");
    expect(result.status).toBe("live");
    expect(hierarchicalAccountService.allocateCustomerDepositAddress).toHaveBeenCalledWith(USER_ID);
  });

  it("is idempotent and returns the same address", async () => {
    const first = await getOrCreateUserDepositAddress(USER_ID, "avalanche-fuji");
    hierarchicalAccountService.findLiveCustomerWallet.mockResolvedValue({
      id: "wal_1",
      userId: USER_ID,
      walletId: "tk_wallet_1",
      turnkeyWalletId: "tk_wallet_1",
      turnkeyAccountId: "tk_acct_1",
      address: ADDRESS,
      network: "avalanche-fuji",
      asset: "USDC",
      status: "live",
    });
    const second = await getOrCreateUserDepositAddress(USER_ID, "avalanche-fuji");
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(first.depositAddress).toBe(second.depositAddress);
    expect(hierarchicalAccountService.allocateCustomerDepositAddress).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported networks", async () => {
    for (const network of ["ethereum", "bitcoin", "solana"]) {
      await expect(getOrCreateUserDepositAddress(USER_ID, network))
          .rejects.toMatchObject({name: "DepositAddressError", code: "UNSUPPORTED_NETWORK"});
    }
    expect(hierarchicalAccountService.allocateCustomerDepositAddress).not.toHaveBeenCalled();
  });

  it("rejects a missing or unknown user", async () => {
    await expect(getOrCreateUserDepositAddress("", "avalanche-fuji"))
        .rejects.toMatchObject({code: "INVALID_USER"});
    await expect(getOrCreateUserDepositAddress("missing_user", "avalanche-fuji"))
        .rejects.toMatchObject({code: "INVALID_USER"});
    expect(hierarchicalAccountService.allocateCustomerDepositAddress).not.toHaveBeenCalled();
  });

  it("persists the required mapping fields on create", async () => {
    const result = await getOrCreateUserDepositAddress(USER_ID, "avalanche-fuji");
    const created = await hierarchicalAccountService.allocateCustomerDepositAddress.mock.results[0].value.then((row) => row.wallet);
    expect(created).toEqual(expect.objectContaining({
      userId: USER_ID,
      network: "avalanche-fuji",
      asset: "USDC",
      turnkeyWalletId: "tk_wallet_1",
      turnkeyAccountId: "tk_acct_1",
      address: ADDRESS,
      status: "live",
    }));
    expect(result.depositAddress).toBe(created.address);
  });
});

describe("createOrGetTurnkeyDepositAddress authorization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects unauthenticated callers", async () => {
    await expect(assertAdminCaller(null)).rejects.toBeInstanceOf(HttpsError);
    await expect(assertAdminCaller({})).rejects.toMatchObject({code: "unauthenticated"});
  });

  it("rejects non-admin users", async () => {
    verifyAdminFromToken.mockReturnValue(false);
    isSuperAdmin.mockResolvedValue(false);
    await expect(assertAdminCaller({uid: "customer_1", token: {}}))
        .rejects.toMatchObject({code: "permission-denied"});
  });

  it("allows a platform admin", async () => {
    verifyAdminFromToken.mockReturnValue(true);
    isSuperAdmin.mockResolvedValue(false);
    await expect(assertAdminCaller({uid: "admin_1", token: {admin: true}})).resolves.toBeUndefined();
  });
});
