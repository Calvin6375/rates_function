/**
 * @fileoverview Consumer-users list exposes ledger USDC, not users.USDT.
 */

const mockAggregates = new Map();

jest.mock("../admin", () => ({
  firestore: Object.assign(jest.fn(() => ({
    getAll: async (...refs) => refs.map((ref) => {
      const data = mockAggregates.get(ref.id);
      return {
        id: ref.id,
        exists: data != null,
        data: () => data,
      };
    }),
  })), {
    FieldPath: {documentId: () => "__name__"},
  }),
}));

jest.mock("../libs/firestore", () => ({
  collection: jest.fn((name) => ({
    doc: jest.fn((id) => ({id, path: `${name}/${id}`})),
  })),
}));

jest.mock("../services/b2bWalletBalanceSync", () => ({
  readUserCurrencyBalances: jest.fn(() => ({USD: 0, KES: 0, USDT: 0})),
  isB2bDashboardUser: jest.fn(() => false),
  loadPartnerWalletBalancesByIds: jest.fn(async () => ({})),
}));

const platformConsumerService = require("../services/platformConsumerService");

describe("consumer-users USDC overlay", () => {
  beforeEach(() => {
    mockAggregates.clear();
  });

  it("attaches walletAggregates.USDC onto each user", async () => {
    mockAggregates.set("zCSjRelA26UhDhAuzVycQ13zEFX2", {USDC: 20});
    const users = await platformConsumerService.attachLedgerUsdc([
      {userId: "zCSjRelA26UhDhAuzVycQ13zEFX2", USDT: 0, USDC: 0},
      {userId: "customer_1", USDT: 5, USDC: 0},
    ]);
    expect(users[0].USDC).toBe(20);
    expect(users[1].USDC).toBe(0);
    expect(users[1].USDT).toBe(5);
  });
});
