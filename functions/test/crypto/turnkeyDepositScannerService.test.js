/**
 * @fileoverview Manual Fuji USDC deposit scanner: attribution and ignore rules.
 */

const {Interface} = require("ethers");
const {ERC20_TRANSFER_ABI} = require("../../services/crypto/evm/fujiNetwork");
const {toUsdcUnits} = require("../../services/crypto/evm/usdcUnits");

const USDC = "0x5425890298aed601595a70AB815c96711a31Bc65";
const OTHER_TOKEN = "0x1111111111111111111111111111111111111111";
const CUSTOMER = "0x3fa194303A09bEa29a76201D3f4C96E321345b2d";
const UNKNOWN = "0x9999999999999999999999999999999999999999";
const FROM = "0xF745b439965c66425958159e91E7e04224Fed29D";
const USER_ID = "zCSjRelA26UhDhAuzVycQ13zEFX2";
const TX_HASH = "0xabc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abcd";

const iface = new Interface(ERC20_TRANSFER_ABI);

const mockWalletDocs = [];

jest.mock("../../libs/firestore", () => ({
  collection: jest.fn(() => {
    const state = {addressLower: null};
    const api = {
      where: jest.fn((field, _op, value) => {
        if (field === "addressLower") state.addressLower = String(value || "").toLowerCase();
        return api;
      }),
      get: jest.fn(async () => {
        const docs = mockWalletDocs.filter((row) => {
          if (!state.addressLower) return true;
          return String(row.addressLower || "").toLowerCase() === state.addressLower;
        });
        return {
          empty: docs.length === 0,
          docs: docs.map((row) => ({id: row.id, data: () => row})),
        };
      }),
    };
    return api;
  }),
  serverTimestamp: jest.fn(() => "ts"),
}));

jest.mock("../../services/crypto/chainMonitorService", () => ({
  creditDeposit: jest.fn(async () => ({credited: true})),
}));

jest.mock("../../services/crypto/evm/evmRpcService", () => {
  const actual = jest.requireActual("../../services/crypto/evm/evmRpcService");
  return {
    ...actual,
    getBlockNumber: jest.fn(async () => 200),
    getUsdcTransferLogs: jest.fn(async () => []),
    getTransactionReceipt: jest.fn(),
    getTransaction: jest.fn(),
  };
});

const evmRpcService = require("../../services/crypto/evm/evmRpcService");
const chainMonitorService = require("../../services/crypto/chainMonitorService");
const {
  DepositScanError,
  assertBlockRange,
  assertSupportedScanTarget,
  isLiveFujiUsdcWallet,
  resolveCustomerWallet,
  validateTransfer,
  scanUsdcDeposits,
} = require("../../services/crypto/turnkey/turnkeyDepositScannerService");
const {assertAdminCaller} = require("../../http/turnkeyDepositHttp");

jest.mock("../../utils/adminClaims", () => ({
  verifyAdminFromToken: jest.fn(),
  isSuperAdmin: jest.fn(),
}));

const {verifyAdminFromToken, isSuperAdmin} = require("../../utils/adminClaims");
const {HttpsError} = require("firebase-functions/v2/https");

function liveWallet(overrides = {}) {
  return {
    id: "wal_1",
    userId: USER_ID,
    provider: "turnkey",
    status: "live",
    network: "avalanche-fuji",
    asset: "USDC",
    address: CUSTOMER,
    addressLower: CUSTOMER.toLowerCase(),
    ...overrides,
  };
}

function transferLog({
  token = USDC,
  to = CUSTOMER,
  from = FROM,
  value = toUsdcUnits("5"),
  txHash = TX_HASH,
  index = 0,
  blockNumber = 150,
} = {}) {
  const encoded = iface.encodeEventLog("Transfer", [from, to, value]);
  return {
    address: token,
    topics: encoded.topics,
    data: encoded.data,
    transactionHash: txHash,
    index,
    blockNumber,
  };
}

function okReceipt() {
  return {status: 1, hash: TX_HASH};
}

function okTx() {
  return {hash: TX_HASH, chainId: 43113};
}

describe("assertBlockRange", () => {
  it("rejects non-integers, inverted, and oversized ranges", () => {
    expect(() => assertBlockRange(1.5, 2)).toThrow(DepositScanError);
    expect(() => assertBlockRange(20, 10)).toThrow(DepositScanError);
    expect(() => assertBlockRange(1, 3000)).toThrow(DepositScanError);
  });

  it("accepts a small inclusive integer range", () => {
    expect(assertBlockRange(58364300, 58364350)).toEqual({
      fromBlock: 58364300,
      toBlock: 58364350,
    });
  });
});

describe("assertSupportedScanTarget", () => {
  it("rejects a non-Fuji network", () => {
    expect(() => assertSupportedScanTarget({network: "ethereum"})).toThrow(DepositScanError);
  });

  it("rejects a non-USDC asset", () => {
    expect(() => assertSupportedScanTarget({asset: "USDT"})).toThrow(DepositScanError);
  });
});

describe("isLiveFujiUsdcWallet", () => {
  it("requires live Fuji USDC Turnkey mapping", () => {
    expect(isLiveFujiUsdcWallet(liveWallet())).toBe(true);
    expect(isLiveFujiUsdcWallet(liveWallet({status: "inactive"}))).toBe(false);
    expect(isLiveFujiUsdcWallet(liveWallet({network: "mainnet"}))).toBe(false);
    expect(isLiveFujiUsdcWallet(liveWallet({asset: "USDT"}))).toBe(false);
  });
});

describe("resolveCustomerWallet", () => {
  beforeEach(() => {
    mockWalletDocs.length = 0;
  });

  it("attributes a known address to the mapped user, case-insensitively", async () => {
    mockWalletDocs.push(liveWallet());
    const resolved = await resolveCustomerWallet(CUSTOMER.toUpperCase());
    expect(resolved.reason).toBeNull();
    expect(resolved.wallet.userId).toBe(USER_ID);
  });

  it("ignores an unknown address", async () => {
    const resolved = await resolveCustomerWallet(UNKNOWN);
    expect(resolved).toEqual({wallet: null, reason: "unknown"});
  });

  it("ignores an inactive deposit address", async () => {
    mockWalletDocs.push(liveWallet({status: "disabled"}));
    const resolved = await resolveCustomerWallet(CUSTOMER);
    expect(resolved).toEqual({wallet: null, reason: "inactive"});
  });

  it("fails safely when multiple live users share the address", async () => {
    mockWalletDocs.push(
        liveWallet({id: "a", userId: "user_a"}),
        liveWallet({id: "b", userId: "user_b"}),
    );
    const resolved = await resolveCustomerWallet(CUSTOMER);
    expect(resolved).toEqual({wallet: null, reason: "ambiguous"});
  });
});

describe("validateTransfer", () => {
  const transfer = {
    from: FROM.toLowerCase(),
    to: CUSTOMER.toLowerCase(),
    value: 5_000_000n,
    txHash: TX_HASH,
    logIndex: 0,
    blockNumber: 150,
  };

  it("accepts a succeeded Fuji transfer with confirmations", () => {
    expect(validateTransfer(transfer, okReceipt(), okTx(), 200)).toBeNull();
  });

  it("ignores a failed transaction", () => {
    expect(validateTransfer(transfer, {status: 0}, okTx(), 200)).toBe("failed-tx");
  });

  it("ignores a zero-value transfer", () => {
    expect(validateTransfer({...transfer, value: 0n}, okReceipt(), okTx(), 200)).toBe("zero-amount");
  });

  it("ignores a transfer on the wrong chain", () => {
    expect(validateTransfer(transfer, okReceipt(), {chainId: 1}, 200)).toBe("wrong-network");
  });

  it("ignores an unconfirmed transfer", () => {
    const original = process.env.CRYPTO_CONFIRMATIONS;
    process.env.CRYPTO_CONFIRMATIONS = "12";
    expect(validateTransfer(transfer, okReceipt(), okTx(), 155)).toBe("unconfirmed");
    process.env.CRYPTO_CONFIRMATIONS = original;
  });
});

describe("scanUsdcDeposits", () => {
  beforeEach(() => {
    mockWalletDocs.length = 0;
    mockWalletDocs.push(liveWallet());
    jest.clearAllMocks();
    evmRpcService.getBlockNumber.mockResolvedValue(200);
    evmRpcService.getTransactionReceipt.mockResolvedValue(okReceipt());
    evmRpcService.getTransaction.mockResolvedValue(okTx());
    evmRpcService.getUsdcTransferLogs.mockResolvedValue([transferLog()]);
    chainMonitorService.creditDeposit.mockResolvedValue({credited: true});
  });

  it("credits a Transfer to a registered customer deposit address", async () => {
    const result = await scanUsdcDeposits({fromBlock: 140, toBlock: 160});
    expect(result).toMatchObject({
      success: true,
      network: "avalanche-fuji",
      asset: "USDC",
      scannedEvents: 1,
      matchedDeposits: 1,
      creditedDeposits: 1,
      alreadyProcessed: 0,
      ignoredEvents: 0,
    });
    expect(chainMonitorService.creditDeposit).toHaveBeenCalledWith(
        expect.objectContaining({
          to: CUSTOMER.toLowerCase(),
          txHash: TX_HASH,
          logIndex: 0,
        }),
        expect.objectContaining({userId: USER_ID}),
    );
  });

  it("ignores a transfer to an unknown address", async () => {
    mockWalletDocs.length = 0;
    evmRpcService.getUsdcTransferLogs.mockResolvedValue([transferLog({to: UNKNOWN})]);
    const result = await scanUsdcDeposits({fromBlock: 140, toBlock: 160});
    expect(result.matchedDeposits).toBe(0);
    expect(result.ignoredEvents).toBe(1);
    expect(chainMonitorService.creditDeposit).not.toHaveBeenCalled();
  });

  it("ignores a log from the wrong token contract", async () => {
    evmRpcService.getUsdcTransferLogs.mockResolvedValue([transferLog({token: OTHER_TOKEN})]);
    const result = await scanUsdcDeposits({fromBlock: 140, toBlock: 160});
    expect(result.ignoredEvents).toBe(1);
    expect(chainMonitorService.creditDeposit).not.toHaveBeenCalled();
  });

  it("rejects a scan targeting the wrong network", async () => {
    await expect(scanUsdcDeposits({
      fromBlock: 140,
      toBlock: 160,
      network: "ethereum",
    })).rejects.toBeInstanceOf(DepositScanError);
  });

  it("ignores a failed transaction", async () => {
    evmRpcService.getTransactionReceipt.mockResolvedValue({status: 0});
    const result = await scanUsdcDeposits({fromBlock: 140, toBlock: 160});
    expect(result.ignoredEvents).toBe(1);
    expect(chainMonitorService.creditDeposit).not.toHaveBeenCalled();
  });

  it("ignores a zero-value transfer", async () => {
    evmRpcService.getUsdcTransferLogs.mockResolvedValue([
      transferLog({value: 0n}),
    ]);
    const result = await scanUsdcDeposits({fromBlock: 140, toBlock: 160});
    expect(result.ignoredEvents).toBe(1);
    expect(chainMonitorService.creditDeposit).not.toHaveBeenCalled();
  });

  it("ignores an inactive deposit address", async () => {
    mockWalletDocs.length = 0;
    mockWalletDocs.push(liveWallet({status: "inactive"}));
    const result = await scanUsdcDeposits({fromBlock: 140, toBlock: 160});
    expect(result.ignoredEvents).toBe(1);
    expect(chainMonitorService.creditDeposit).not.toHaveBeenCalled();
  });

  it("counts a duplicate txHash+logIndex as already processed", async () => {
    chainMonitorService.creditDeposit.mockResolvedValue({credited: false, duplicate: true});
    const result = await scanUsdcDeposits({fromBlock: 140, toBlock: 160});
    expect(result.creditedDeposits).toBe(0);
    expect(result.alreadyProcessed).toBe(1);
    expect(result.matchedDeposits).toBe(1);
  });

  it("uses a distinct idempotency key for each Transfer log in the same transaction", async () => {
    evmRpcService.getUsdcTransferLogs.mockResolvedValue([
      transferLog({index: 0}),
      transferLog({index: 1, to: CUSTOMER}),
    ]);
    await scanUsdcDeposits({fromBlock: 140, toBlock: 160});
    expect(chainMonitorService.creditDeposit).toHaveBeenCalledTimes(2);
    expect(chainMonitorService.creditDeposit.mock.calls[0][0].logIndex).toBe(0);
    expect(chainMonitorService.creditDeposit.mock.calls[1][0].logIndex).toBe(1);
  });

  it("credits two users independently from the same block range", async () => {
    const otherUser = "user_b";
    const otherAddr = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    mockWalletDocs.length = 0;
    mockWalletDocs.push(
        liveWallet(),
        liveWallet({
          id: "wal_b",
          userId: otherUser,
          address: otherAddr,
          addressLower: otherAddr,
        }),
    );
    evmRpcService.getUsdcTransferLogs.mockResolvedValue([
      transferLog({to: CUSTOMER, value: toUsdcUnits("20"), txHash: TX_HASH, index: 0}),
      transferLog({
        to: otherAddr,
        value: toUsdcUnits("50"),
        txHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        index: 0,
      }),
    ]);
    chainMonitorService.creditDeposit
        .mockResolvedValueOnce({credited: true})
        .mockResolvedValueOnce({credited: true});
    const result = await scanUsdcDeposits({fromBlock: 140, toBlock: 160});
    expect(result.creditedDeposits).toBe(2);
    expect(chainMonitorService.creditDeposit.mock.calls[0][1].userId).toBe(USER_ID);
    expect(chainMonitorService.creditDeposit.mock.calls[1][1].userId).toBe(otherUser);
  });

  it("does not credit when the address mapping is ambiguous", async () => {
    mockWalletDocs.length = 0;
    mockWalletDocs.push(
        liveWallet({id: "a", userId: "user_a"}),
        liveWallet({id: "b", userId: "user_b"}),
    );
    const result = await scanUsdcDeposits({fromBlock: 140, toBlock: 160});
    expect(result.ignoredEvents).toBe(1);
    expect(chainMonitorService.creditDeposit).not.toHaveBeenCalled();
  });
});

describe("scanTurnkeyUsdcDeposits admin auth", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects a non-admin caller", async () => {
    verifyAdminFromToken.mockReturnValue(false);
    isSuperAdmin.mockResolvedValue(false);
    await expect(assertAdminCaller({uid: "u1", token: {}})).rejects.toBeInstanceOf(HttpsError);
  });

  it("allows a platform admin", async () => {
    verifyAdminFromToken.mockReturnValue(true);
    isSuperAdmin.mockResolvedValue(false);
    await expect(assertAdminCaller({uid: "admin", token: {}})).resolves.toBeUndefined();
  });
});
