/**
 * @fileoverview Short-lived USDC deposit watch sessions.
 */

const ADDR_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ADDR_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const mockIntents = new Map();

jest.mock("../../libs/firestore", () => ({
  collection: jest.fn(() => ({
    doc: jest.fn((id) => ({
      id,
      get: jest.fn(async () => ({
        exists: mockIntents.has(id),
        data: () => mockIntents.get(id),
      })),
      set: jest.fn(async (data) => {
        const prev = mockIntents.get(id) || {};
        mockIntents.set(id, {...prev, ...data});
      }),
    })),
  })),
  serverTimestamp: jest.fn(() => "ts"),
}));

jest.mock("../../services/crypto/turnkey/turnkeyDepositAddressService", () => ({
  ASSET: "USDC",
  SUPPORTED_NETWORK: "avalanche-fuji",
  DepositAddressError: class DepositAddressError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "DepositAddressError";
      this.code = code;
    }
  },
  getOrCreateCustomerDepositAddress: jest.fn(),
}));

jest.mock("../../services/crypto/turnkey/turnkeyDepositScannerService", () => ({
  scanRecentUsdcDepositsForAddress: jest.fn(),
}));

const depositAddressService = require("../../services/crypto/turnkey/turnkeyDepositAddressService");
const scannerService = require("../../services/crypto/turnkey/turnkeyDepositScannerService");
const {
  startDepositWatch,
  runDepositWatchLoop,
  MONITOR_DURATION_MS,
  intentDocId,
} = require("../../services/crypto/turnkey/cryptoDepositMonitoringService");

describe("startDepositWatch", () => {
  beforeEach(() => {
    mockIntents.clear();
    jest.clearAllMocks();
    depositAddressService.getOrCreateCustomerDepositAddress.mockResolvedValue({
      depositAddress: ADDR_A,
    });
  });

  it("creates an intent for an authenticated user", async () => {
    const result = await startDepositWatch("userA", {asset: "USDC", network: "avalanche-fuji"});
    expect(result.success).toBe(true);
    expect(result.userId).toBe("userA");
    expect(result.address).toBe(ADDR_A);
    expect(result.status).toBe("monitoring");
    expect(result.intentId).toBe(intentDocId("userA"));
    expect(result.started).toBe(true);
    expect(mockIntents.get(result.intentId).status).toBe("pending");
  });

  it("reuses an active intent instead of starting another job", async () => {
    const first = await startDepositWatch("userA", {asset: "USDC"});
    mockIntents.get(first.intentId).expiresAt = new Date(Date.now() + 30_000);
    const second = await startDepositWatch("userA", {asset: "USDC"});
    expect(second.reusedIntent).toBe(true);
    expect(second.started).toBe(false);
    expect(second.intentId).toBe(first.intentId);
  });

  it("rejects an unauthenticated caller", async () => {
    await expect(startDepositWatch("", {asset: "USDC"})).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });

  it("rejects the wrong asset or network", async () => {
    await expect(startDepositWatch("userA", {asset: "USDT"})).rejects.toMatchObject({
      code: "WRONG_ASSET",
    });
    await expect(startDepositWatch("userA", {network: "ethereum"})).rejects.toMatchObject({
      code: "WRONG_NETWORK",
    });
  });
});

describe("runDepositWatchLoop", () => {
  beforeEach(() => {
    mockIntents.clear();
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.spyOn(global, "setTimeout");
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("credits a deposit detected during monitoring", async () => {
    const intentId = intentDocId("userA");
    mockIntents.set(intentId, {
      userId: "userA",
      depositAddress: ADDR_A,
      status: "pending",
      expiresAt: new Date(Date.now() + MONITOR_DURATION_MS),
    });
    scannerService.scanRecentUsdcDepositsForAddress.mockResolvedValue({
      creditedDeposits: 1,
      alreadyProcessed: 0,
      credits: [{
        userId: "userA",
        txHash: "0xdep",
        logIndex: 0,
        amount: 20,
        credited: true,
      }],
    });

    const result = await runDepositWatchLoop(intentId);
    expect(result.status).toBe("credited");
    expect(mockIntents.get(intentId).status).toBe("credited");
    expect(mockIntents.get(intentId).detectedTxHash).toBe("0xdep");
    expect(mockIntents.get(intentId).detectedAmount).toBe(20);
  });

  it("expires when nothing arrives", async () => {
    const intentId = intentDocId("userA");
    mockIntents.set(intentId, {
      userId: "userA",
      depositAddress: ADDR_A,
      status: "pending",
      expiresAt: new Date(Date.now() - 1),
    });
    const result = await runDepositWatchLoop(intentId);
    expect(result.status).toBe("expired");
    expect(mockIntents.get(intentId).status).toBe("expired");
    expect(scannerService.scanRecentUsdcDepositsForAddress).not.toHaveBeenCalled();
  });
});

describe("multi-user attribution during monitoring", () => {
  beforeEach(() => {
    mockIntents.clear();
    jest.clearAllMocks();
  });

  it("credits User A and User B separately", async () => {
    mockIntents.set(intentDocId("userA"), {
      userId: "userA",
      depositAddress: ADDR_A,
      status: "pending",
      expiresAt: new Date(Date.now() + MONITOR_DURATION_MS),
    });
    mockIntents.set(intentDocId("userB"), {
      userId: "userB",
      depositAddress: ADDR_B,
      status: "pending",
      expiresAt: new Date(Date.now() + MONITOR_DURATION_MS),
    });
    scannerService.scanRecentUsdcDepositsForAddress.mockImplementation(async (address) => {
      if (address === ADDR_A) {
        return {
          credits: [{userId: "userA", txHash: "0xa", logIndex: 0, amount: 20, credited: true}],
          creditedDeposits: 1,
        };
      }
      return {
        credits: [{userId: "userB", txHash: "0xb", logIndex: 0, amount: 50, credited: true}],
        creditedDeposits: 1,
      };
    });

    const [a, b] = await Promise.all([
      runDepositWatchLoop(intentDocId("userA")),
      runDepositWatchLoop(intentDocId("userB")),
    ]);
    expect(a.status).toBe("credited");
    expect(b.status).toBe("credited");
    expect(mockIntents.get(intentDocId("userA")).detectedAmount).toBe(20);
    expect(mockIntents.get(intentDocId("userB")).detectedAmount).toBe(50);
  });
});
