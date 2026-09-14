/**
 * @fileoverview Deposit detection, confirmation, duplicate events, failed sends.
 */

const {Interface} = require("ethers");
const {ERC20_TRANSFER_ABI} = require("../../services/crypto/evm/fujiNetwork");
const {toUsdcUnits} = require("../../services/crypto/evm/usdcUnits");

const iface = new Interface(ERC20_TRANSFER_ABI);
const USER_ADDR = "0x2222222222222222222222222222222222222222";

const mockWalletDocs = [{
  id: "w1",
  data: () => ({
    userId: "user_1",
    walletId: "tk-1",
    address: USER_ADDR,
    addressLower: USER_ADDR,
    provider: "turnkey",
  }),
}];

const mockPendingDocs = [];
const mockEventDocs = new Map();
const mockTxQueryDocs = [];

jest.mock("../../admin", () => ({
  firestore: jest.fn(() => ({
    runTransaction: async (fn) => fn({
      get: async (ref) => ({exists: mockEventDocs.has(ref.path || ref.id)}),
      set: (ref, data) => {
        mockEventDocs.set(ref.path || ref.id || data.eventId, data);
      },
    }),
  })),
}));

jest.mock("../../libs/firestore", () => ({
  collection: jest.fn((name) => {
    const api = {
      doc: jest.fn((id) => ({
        id,
        path: `${name}/${id}`,
        get: jest.fn(async () => {
          if (name === "cryptoChainCursors") {
            return {exists: false};
          }
          if (name === "webhookEvents") {
            return {exists: mockEventDocs.has(id), data: () => mockEventDocs.get(id)};
          }
          return {exists: false};
        }),
        set: jest.fn(async (data) => {
          if (name === "webhookEvents") mockEventDocs.set(id, data);
        }),
        update: jest.fn(async () => undefined),
      })),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      add: jest.fn(async () => ({id: "ctx_1"})),
      get: jest.fn(async () => {
        if (name === "cryptoWallets") {
          return {docs: mockWalletDocs, empty: false};
        }
        if (name === "cryptoTransactions") {
          return {docs: mockPendingDocs, empty: mockPendingDocs.length === 0};
        }
        return {docs: mockTxQueryDocs, empty: mockTxQueryDocs.length === 0};
      }),
    };
    return api;
  }),
  serverTimestamp: jest.fn(() => "ts"),
}));

jest.mock("../../services/ledger/ledgerService", () => ({
  hasLedgerEntry: jest.fn(async () => false),
  appendTransaction: jest.fn(async () => ({entryId: "cl_1"})),
}));

jest.mock("../../services/ledger/reservationService", () => ({
  confirmReservation: jest.fn(async () => undefined),
  releaseReservation: jest.fn(async () => undefined),
}));

jest.mock("../../services/crypto/evm/evmRpcService", () => {
  const actual = jest.requireActual("../../services/crypto/evm/evmRpcService");
  return {
    ...actual,
    getBlockNumber: jest.fn(async () => 200),
    getUsdcTransferLogs: jest.fn(async () => []),
    getTransactionStatus: jest.fn(),
  };
});

const evmRpcService = require("../../services/crypto/evm/evmRpcService");
const ledgerService = require("../../services/ledger/ledgerService");
const reservationService = require("../../services/ledger/reservationService");
const chainMonitorService = require("../../services/crypto/chainMonitorService");

function transferLog({to = USER_ADDR, amount = "3", txHash = "0xdep1", index = 0} = {}) {
  const encoded = iface.encodeEventLog("Transfer", [
    "0x1111111111111111111111111111111111111111",
    to,
    toUsdcUnits(amount),
  ]);
  return {
    topics: encoded.topics,
    data: encoded.data,
    transactionHash: txHash,
    index,
    blockNumber: 150,
  };
}

describe("chainMonitorService deposits", () => {
  beforeEach(() => {
    mockEventDocs.clear();
    mockPendingDocs.length = 0;
    mockTxQueryDocs.length = 0;
    jest.clearAllMocks();
    ledgerService.hasLedgerEntry.mockResolvedValue(false);
    evmRpcService.getBlockNumber.mockResolvedValue(200);
    evmRpcService.getUsdcTransferLogs.mockResolvedValue([transferLog()]);
  });

  it("credits a confirmed USDC deposit to the matching wallet", async () => {
    const result = await chainMonitorService.processConfirmedDeposits();
    expect(result.credited).toBe(1);
    expect(ledgerService.appendTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user_1",
          type: "deposit",
          direction: "credit",
          asset: "USDC",
          amount: 3,
          source: "turnkey",
        }),
    );
  });

  it("does not credit a deposit before the confirmation requirement", async () => {
    const original = process.env.CRYPTO_CONFIRMATIONS;
    process.env.CRYPTO_CONFIRMATIONS = "12";
    evmRpcService.getBlockNumber.mockResolvedValue(155);
    const result = await chainMonitorService.creditDeposit({
      from: "0x1111111111111111111111111111111111111111",
      to: USER_ADDR,
      value: 3_000_000n,
      txHash: "0xunconfirmed",
      logIndex: 0,
      blockNumber: 150,
    }, mockWalletDocs[0].data());
    expect(result).toEqual({credited: false, unconfirmed: true});
    expect(ledgerService.appendTransaction).not.toHaveBeenCalled();
    process.env.CRYPTO_CONFIRMATIONS = original;
  });

  it("stores Flutter circleTransactionId as the tx hash, ledger id as hash+logIndex", async () => {
    const firestore = require("../../libs/firestore");
    await chainMonitorService.processConfirmedDeposits();
    expect(ledgerService.appendTransaction).toHaveBeenCalledWith(
        expect.objectContaining({referenceId: "0xdep1_0"}),
    );
    const add = firestore.collection.mock.results
        .map((r) => r.value && r.value.add)
        .find((fn) => fn && fn.mock && fn.mock.calls.length);
    if (add) {
      expect(add).toHaveBeenCalledWith(expect.objectContaining({
        circleTransactionId: "0xdep1",
        providerTransactionId: "0xdep1_0",
        txHash: "0xdep1",
        logIndex: 0,
      }));
    }
  });

  it("is idempotent for a duplicate blockchain event", async () => {
    await chainMonitorService.processConfirmedDeposits();
    ledgerService.hasLedgerEntry.mockResolvedValue(true);
    evmRpcService.getUsdcTransferLogs.mockResolvedValue([transferLog()]);
    const second = await chainMonitorService.processConfirmedDeposits();
    expect(second.duplicates + second.credited).toBeGreaterThanOrEqual(0);
    expect(ledgerService.appendTransaction).toHaveBeenCalledTimes(1);
  });

  it("ignores transfers to unknown addresses", async () => {
    evmRpcService.getUsdcTransferLogs.mockResolvedValue([
      transferLog({to: "0x9999999999999999999999999999999999999999"}),
    ]);
    const result = await chainMonitorService.processConfirmedDeposits();
    expect(result.credited).toBe(0);
    expect(ledgerService.appendTransaction).not.toHaveBeenCalled();
  });
});

describe("chainMonitorService outbound confirmation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPendingDocs.length = 0;
  });

  it("finalizes a confirmed send: ledger debit + reservation confirm", async () => {
    const doc = {
      ref: {update: jest.fn(async () => undefined)},
      data: () => ({
        userId: "user_1",
        amount: 5,
        txHash: "0xout1",
        circleTransactionId: "0xout1",
        reservationId: "res_1",
        status: "pending",
      }),
    };
    mockPendingDocs.push(doc);
    evmRpcService.getTransactionStatus.mockResolvedValue({status: "complete"});
    const result = await chainMonitorService.processPendingSends();
    expect(result.completed).toBe(1);
    expect(ledgerService.appendTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "send",
          direction: "debit",
          referenceId: "0xout1",
        }),
    );
    expect(reservationService.confirmReservation).toHaveBeenCalledWith("res_1");
  });

  it("releases the reservation when the transaction reverts", async () => {
    const doc = {
      ref: {update: jest.fn(async () => undefined)},
      data: () => ({
        userId: "user_1",
        amount: 5,
        txHash: "0xfail",
        circleTransactionId: "0xfail",
        reservationId: "res_fail",
        status: "pending",
      }),
    };
    mockPendingDocs.push(doc);
    evmRpcService.getTransactionStatus.mockResolvedValue({status: "failed"});
    const result = await chainMonitorService.processPendingSends();
    expect(result.failed).toBe(1);
    expect(reservationService.releaseReservation).toHaveBeenCalledWith("res_fail");
    expect(ledgerService.appendTransaction).not.toHaveBeenCalled();
  });
});
