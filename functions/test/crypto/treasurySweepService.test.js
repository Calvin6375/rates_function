/**
 * @fileoverview Customer USDC sweep to treasury: enqueue, gas, no ledger writes.
 */

const {ethers} = require("ethers");

const TREASURY = "0x952bBC4952A98a49E112d06DBaAe0FAA37eF080A";
const CUSTOMER = "0x2222222222222222222222222222222222222222";

const mockSweepStore = new Map();
const mockWalletDocs = [];

jest.mock("../../libs/firestore", () => ({
  collection: jest.fn((name) => {
    const api = {
      doc: jest.fn((id) => ({
        id,
        get: jest.fn(async () => ({
          exists: mockSweepStore.has(id),
          data: () => mockSweepStore.get(id),
        })),
        set: jest.fn(async (data, opts) => {
          const prev = mockSweepStore.get(id) || {};
          mockSweepStore.set(id, opts && opts.merge ? {...prev, ...data} : data);
        }),
      })),
      where: jest.fn(() => api),
      limit: jest.fn(() => api),
      get: jest.fn(async () => {
        if (name === "cryptoWallets") {
          return {docs: mockWalletDocs, empty: mockWalletDocs.length === 0};
        }
        const docs = [...mockSweepStore.entries()]
            .filter(([, row]) => row.status === "pending")
            .map(([id, data]) => ({
              id,
              data: () => data,
              ref: {
                set: jest.fn(async (update, opts) => {
                  const prev = mockSweepStore.get(id) || {};
                  mockSweepStore.set(id, opts && opts.merge ? {...prev, ...update} : update);
                }),
              },
            }));
        return {docs, size: docs.length};
      }),
    };
    return api;
  }),
  serverTimestamp: jest.fn(() => "ts"),
}));

jest.mock("../../services/crypto/providers/turnkeyRailAdapter", () => ({
  signAndBroadcast: jest.fn(async () => "0xsweep"),
}));

jest.mock("../../services/crypto/evm/evmRpcService", () => {
  const actual = jest.requireActual("../../services/crypto/evm/evmRpcService");
  return {
    ...actual,
    getErc20Balance: jest.fn(),
    getAvaxBalanceWei: jest.fn(),
    getFeeData: jest.fn(async () => ({
      maxFeePerGas: 25_000_000_000n,
      maxPriorityFeePerGas: 25_000_000_000n,
    })),
    estimateGas: jest.fn(async () => 65000n),
    encodeUsdcTransfer: actual.encodeUsdcTransfer,
  };
});

jest.mock("../../services/ledger/ledgerService", () => ({
  appendTransaction: jest.fn(),
  hasLedgerEntry: jest.fn(),
}));

const evmRpcService = require("../../services/crypto/evm/evmRpcService");
const adapter = require("../../services/crypto/providers/turnkeyRailAdapter");
const ledgerService = require("../../services/ledger/ledgerService");
const treasurySweepService = require("../../services/crypto/treasurySweepService");

describe("treasurySweepService", () => {
  beforeEach(() => {
    mockSweepStore.clear();
    mockWalletDocs.length = 0;
    jest.clearAllMocks();
    evmRpcService.getErc20Balance.mockResolvedValue({
      raw: "3000000",
      decimals: 6,
      balance: "3",
    });
    evmRpcService.getAvaxBalanceWei.mockImplementation(async (address) => {
      if (String(address).toLowerCase() === TREASURY.toLowerCase()) {
        return ethers.parseEther("1");
      }
      return 0n;
    });
    adapter.signAndBroadcast.mockResolvedValue("0xsweep");
  });

  it("enqueues a sweep after credit and is idempotent", async () => {
    const first = await treasurySweepService.enqueueSweepAfterCredit({
      userId: "user_1",
      fromAddress: CUSTOMER,
      amount: 3,
      network: "avalanche",
      depositReferenceId: "0xdep1_0",
      depositTxHash: "0xdep1",
    });
    expect(first).toEqual({enqueued: true, sweepId: "avalanche_0xdep1_0"});
    const row = mockSweepStore.get("avalanche_0xdep1_0");
    expect(row.status).toBe("pending");
    expect(row.toAddress).toBe(TREASURY);
    expect(row.fromAddress).toBe(ethers.getAddress(CUSTOMER));

    const second = await treasurySweepService.enqueueSweepAfterCredit({
      userId: "user_1",
      fromAddress: CUSTOMER,
      amount: 3,
      network: "avalanche",
      depositReferenceId: "0xdep1_0",
    });
    expect(second).toEqual({
      enqueued: false,
      reason: "already-pending",
      sweepId: "avalanche_0xdep1_0",
    });
  });

  it("does not enqueue a sweep from the treasury itself", async () => {
    const result = await treasurySweepService.enqueueSweepAfterCredit({
      fromAddress: TREASURY,
      amount: 3,
      network: "avalanche",
      depositReferenceId: "0xself_0",
    });
    expect(result).toEqual({enqueued: false, reason: "already-treasury"});
    expect(mockSweepStore.size).toBe(0);
  });

  it("does not enqueue a Fuji / testnet sweep", async () => {
    const result = await treasurySweepService.enqueueSweepAfterCredit({
      fromAddress: CUSTOMER,
      amount: 3,
      network: "avalanche-fuji",
      depositReferenceId: "0xfuji_0",
    });
    expect(result).toEqual({enqueued: false, reason: "testnet"});
    expect(mockSweepStore.size).toBe(0);
  });

  it("does not scan testnet wallets for leftover USDC", async () => {
    const result = await treasurySweepService.enqueueOutstandingSweeps("avalanche-fuji");
    expect(result).toEqual({enqueued: 0, checked: 0, skipped: 0, reason: "testnet"});
    expect(evmRpcService.getErc20Balance).not.toHaveBeenCalled();
  });

  it("rejects an invalid source address", async () => {
    const result = await treasurySweepService.enqueueSweepAfterCredit({
      fromAddress: "not-an-address",
      amount: 3,
      network: "avalanche",
      depositReferenceId: "0xbad_0",
    });
    expect(result).toEqual({enqueued: false, reason: "invalid-from"});
  });

  it("sweeps on-chain leftover and does not write the ledger", async () => {
    await treasurySweepService.enqueueSweepAfterCredit({
      userId: "user_1",
      fromAddress: CUSTOMER,
      amount: 3,
      network: "avalanche",
      depositReferenceId: "0xdep1_0",
    });
    const result = await treasurySweepService.processPendingSweeps("avalanche");
    expect(result.swept).toBe(1);
    expect(adapter.signAndBroadcast).toHaveBeenCalledWith(expect.objectContaining({
      fromAddress: TREASURY,
      toAddress: ethers.getAddress(CUSTOMER),
      asset: "AVAX",
      network: "avalanche",
    }));
    expect(adapter.signAndBroadcast).toHaveBeenCalledWith(expect.objectContaining({
      fromAddress: ethers.getAddress(CUSTOMER),
      toAddress: TREASURY,
      amount: 3,
      asset: "USDC",
      network: "avalanche",
    }));
    expect(mockSweepStore.get("avalanche_0xdep1_0").status).toBe("complete");
    expect(ledgerService.appendTransaction).not.toHaveBeenCalled();
  });

  it("marks an empty customer address complete without broadcasting", async () => {
    evmRpcService.getErc20Balance.mockResolvedValue({
      raw: "0",
      decimals: 6,
      balance: "0",
    });
    await treasurySweepService.enqueueSweepAfterCredit({
      fromAddress: CUSTOMER,
      amount: 3,
      network: "avalanche",
      depositReferenceId: "0xempty_0",
    });
    const result = await treasurySweepService.processPendingSweeps("avalanche");
    expect(result.swept).toBe(0);
    expect(adapter.signAndBroadcast).not.toHaveBeenCalled();
    expect(mockSweepStore.get("avalanche_0xempty_0").status).toBe("complete");
  });

  it("keeps the sweep pending when treasury AVAX cannot fund gas", async () => {
    evmRpcService.getAvaxBalanceWei.mockResolvedValue(0n);
    await treasurySweepService.enqueueSweepAfterCredit({
      fromAddress: CUSTOMER,
      amount: 3,
      network: "avalanche",
      depositReferenceId: "0xgas_0",
    });
    const result = await treasurySweepService.processPendingSweeps("avalanche");
    expect(result.failed).toBe(1);
    expect(mockSweepStore.get("avalanche_0xgas_0").status).toBe("pending");
    expect(mockSweepStore.get("avalanche_0xgas_0").lastError).toMatch(/insufficient AVAX/i);
    expect(adapter.signAndBroadcast).not.toHaveBeenCalled();
  });

  it("enqueues leftover customer USDC as an outstanding sweep", async () => {
    mockWalletDocs.push({
      id: "w1",
      data: () => ({
        userId: "user_1",
        address: CUSTOMER,
        provider: "turnkey",
        network: "avalanche",
        asset: "USDC",
        status: "live",
      }),
    });
    evmRpcService.getErc20Balance.mockResolvedValue({
      raw: "11708165",
      decimals: 6,
      balance: "11.708165",
    });
    const result = await treasurySweepService.enqueueOutstandingSweeps("avalanche");
    expect(result.enqueued).toBe(1);
    expect(result.checked).toBe(1);
    const row = [...mockSweepStore.values()][0];
    expect(row.type).toBe("outstanding");
    expect(row.fromAddress).toBe(ethers.getAddress(CUSTOMER));
    expect(row.toAddress).toBe(TREASURY);
    expect(row.status).toBe("pending");
  });
});
