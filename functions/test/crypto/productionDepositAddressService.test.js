/**
 * @fileoverview Production Avalanche USDC deposit-address lifecycle.
 */

const USER_ID = "customer_prod_1";
const PROD_ADDR = "0xdddddddddddddddddddddddddddddddddddddddd";
const PRODUCTION_PARENT = "ba3dfc05-1024-5ef0-bf1c-7b5c009a582b";

jest.mock("../../admin", () => ({
  auth: () => ({
    getUser: jest.fn(async (uid) => {
      if (uid === USER_ID) return {uid};
      const err = new Error("not found");
      err.code = "auth/user-not-found";
      throw err;
    }),
  }),
}));

jest.mock("../../libs/firestore", () => {
  const mockUserDocs = new Map([[USER_ID, {exists: true}]]);
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
  readTurnkeyAccountId: jest.fn(),
  deleteFujiCustomerWallets: jest.fn(async () => ({deleted: 1, ids: ["fuji"]})),
}));

jest.mock("../../services/crypto/turnkey/turnkeyHierarchicalAccountService", () => ({
  PRODUCTION_PARENT_WALLET_ID: "ba3dfc05-1024-5ef0-bf1c-7b5c009a582b",
  findLiveCustomerWallet: jest.fn(),
  allocateCustomerDepositAddress: jest.fn(),
  allocateProductionCustomerDepositAddress: jest.fn(),
}));

const hierarchicalAccountService = require("../../services/crypto/turnkey/turnkeyHierarchicalAccountService");
const turnkeyWalletService = require("../../services/crypto/turnkey/turnkeyWalletService");
const {
  getOrCreateProductionCustomerDepositAddress,
} = require("../../services/crypto/turnkey/turnkeyDepositAddressService");

describe("getOrCreateProductionCustomerDepositAddress", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    hierarchicalAccountService.allocateProductionCustomerDepositAddress.mockResolvedValue({
      created: true,
      wallet: {
        id: `turnkey_${USER_ID}_avalanche_USDC`,
        userId: USER_ID,
        address: PROD_ADDR,
        status: "live",
        network: "avalanche",
        asset: "USDC",
        turnkeyWalletId: PRODUCTION_PARENT,
        derivationIndex: 0,
      },
    });
  });

  it("creates a production address and does not call the Fuji allocator", async () => {
    const result = await getOrCreateProductionCustomerDepositAddress(USER_ID);
    expect(result).toMatchObject({
      success: true,
      created: true,
      userId: USER_ID,
      environment: "production",
      network: "avalanche",
      asset: "USDC",
      address: PROD_ADDR,
      status: "live",
      turnkeyWalletId: PRODUCTION_PARENT,
      derivationIndex: 0,
    });
    expect(hierarchicalAccountService.allocateProductionCustomerDepositAddress)
        .toHaveBeenCalledWith(USER_ID);
    expect(hierarchicalAccountService.allocateCustomerDepositAddress).not.toHaveBeenCalled();
    expect(turnkeyWalletService.deleteFujiCustomerWallets).toHaveBeenCalledWith(USER_ID);
  });

  it("deletes leftover Fuji wallets when the production address already exists", async () => {
    hierarchicalAccountService.allocateProductionCustomerDepositAddress.mockResolvedValue({
      created: false,
      wallet: {
        address: PROD_ADDR,
        status: "live",
        turnkeyWalletId: PRODUCTION_PARENT,
        derivationIndex: 0,
      },
    });
    await getOrCreateProductionCustomerDepositAddress(USER_ID);
    expect(turnkeyWalletService.deleteFujiCustomerWallets).toHaveBeenCalledWith(USER_ID);
  });

  it("does not delete Fuji when production allocation fails", async () => {
    hierarchicalAccountService.allocateProductionCustomerDepositAddress
        .mockRejectedValue(new Error("turnkey down"));
    await expect(getOrCreateProductionCustomerDepositAddress(USER_ID)).rejects.toThrow("turnkey down");
    expect(turnkeyWalletService.deleteFujiCustomerWallets).not.toHaveBeenCalled();
  });

  it("returns the same production address on a second call", async () => {
    hierarchicalAccountService.allocateProductionCustomerDepositAddress
        .mockResolvedValueOnce({
          created: true,
          wallet: {
            address: PROD_ADDR,
            status: "live",
            turnkeyWalletId: PRODUCTION_PARENT,
            derivationIndex: 0,
          },
        })
        .mockResolvedValueOnce({
          created: false,
          wallet: {
            address: PROD_ADDR,
            status: "live",
            turnkeyWalletId: PRODUCTION_PARENT,
            derivationIndex: 0,
          },
        });
    const first = await getOrCreateProductionCustomerDepositAddress(USER_ID);
    const second = await getOrCreateProductionCustomerDepositAddress(USER_ID);
    expect(first.address).toBe(second.address);
    expect(second.created).toBe(false);
  });

  it("rejects an unknown user", async () => {
    await expect(getOrCreateProductionCustomerDepositAddress("missing_user"))
        .rejects.toMatchObject({code: "INVALID_USER"});
    expect(hierarchicalAccountService.allocateProductionCustomerDepositAddress)
        .not.toHaveBeenCalled();
  });
});
