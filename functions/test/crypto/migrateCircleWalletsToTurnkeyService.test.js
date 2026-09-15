/**
 * @fileoverview Circle → Turnkey deposit-address migration.
 */

const mockCircleDocs = [];
const mockAdds = [];
const mockDeletes = [];

jest.mock("../../libs/firestore", () => ({
  collection: jest.fn((name) => ({
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    get: jest.fn(async () => ({
      size: mockCircleDocs.length,
      docs: mockCircleDocs,
      empty: mockCircleDocs.length === 0,
    })),
    add: jest.fn(async (row) => {
      mockAdds.push({name, row});
      return {id: "mig_1"};
    }),
    doc: jest.fn((id) => ({
      id,
      delete: jest.fn(async () => {
        mockDeletes.push(id);
      }),
    })),
  })),
  serverTimestamp: jest.fn(() => "ts"),
}));

jest.mock("../../services/crypto/turnkey/turnkeyHierarchicalAccountService", () => ({
  findLiveCustomerWallet: jest.fn(),
  allocateCustomerDepositAddress: jest.fn(),
}));

const hierarchicalAccountService = require("../../services/crypto/turnkey/turnkeyHierarchicalAccountService");
const {
  migrateCircleWalletsToTurnkey,
} = require("../../services/crypto/turnkey/migrateCircleWalletsToTurnkeyService");

describe("migrateCircleWalletsToTurnkey", () => {
  beforeEach(() => {
    mockCircleDocs.length = 0;
    mockAdds.length = 0;
    mockDeletes.length = 0;
    jest.clearAllMocks();
    mockCircleDocs.push({
      id: "circle_1",
      data: () => ({
        userId: "user_a",
        provider: "circle",
        address: "0xcircleaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        walletId: "circle-wal-1",
      }),
    });
  });

  it("dry-run does not delete Circle mappings or create addresses", async () => {
    hierarchicalAccountService.findLiveCustomerWallet.mockResolvedValue(null);
    const result = await migrateCircleWalletsToTurnkey({apply: false});
    expect(result.apply).toBe(false);
    expect(result.planned).toBe(1);
    expect(result.migrated).toBe(0);
    expect(result.results[0].action).toBe("retire-circle-create-turnkey");
    expect(hierarchicalAccountService.allocateCustomerDepositAddress).not.toHaveBeenCalled();
    expect(mockDeletes).toEqual([]);
  });

  it("apply creates a Turnkey address then deletes the Circle mapping", async () => {
    hierarchicalAccountService.findLiveCustomerWallet.mockResolvedValue(null);
    hierarchicalAccountService.allocateCustomerDepositAddress.mockResolvedValue({
      created: true,
      wallet: {address: "0xturnkeyaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
    });
    const result = await migrateCircleWalletsToTurnkey({apply: true});
    expect(result.migrated).toBe(1);
    expect(result.results[0].newAddress).toBe("0xturnkeyaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(result.results[0].deletedCircleWallet).toBe(true);
    expect(mockDeletes).toEqual(["circle_1"]);
    expect(mockAdds[0].name).toBe("cryptoWalletMigrations");
  });

  it("keeps an existing Turnkey address and only removes Circle", async () => {
    hierarchicalAccountService.findLiveCustomerWallet.mockResolvedValue({
      address: "0xexistingturnkeyaaaaaaaaaaaaaaaaaaaaaa",
    });
    const result = await migrateCircleWalletsToTurnkey({apply: true});
    expect(hierarchicalAccountService.allocateCustomerDepositAddress).not.toHaveBeenCalled();
    expect(result.results[0].newAddress).toBe("0xexistingturnkeyaaaaaaaaaaaaaaaaaaaaaa");
    expect(mockDeletes).toEqual(["circle_1"]);
  });
});
