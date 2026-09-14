/**
 * @fileoverview Fuji USDC deposit test: validation, ledger credit, idempotency.
 */

const {Interface} = require("ethers");
const {ERC20_TRANSFER_ABI} = require("../../services/crypto/evm/fujiNetwork");
const {fromUsdcUnits, toUsdcUnits} = require("../../services/crypto/evm/usdcUnits");

const USDC = "0x5425890298aed601595a70AB815c96711a31Bc65";
const TREASURY = "0x952bBC4952A98a49E112d06DBaAe0FAA37eF080A";
const OTHER_TOKEN = "0x1111111111111111111111111111111111111111";
const OTHER_RECIPIENT = "0x2222222222222222222222222222222222222222";
const FROM = "0xF745b439965c66425958159e91E7e04224Fed29D";
const TX_HASH = "0xc0c3a9108e4f40019ecdaf9fb911095420aab2119bff2131623f33316f3538fb";
const RAW_20 = 20_000_000n;

const iface = new Interface(ERC20_TRANSFER_ABI);

jest.mock("../../admin", () => ({
  auth: () => ({
    getUserByEmail: jest.fn(async () => ({uid: "super_admin_uid"})),
  }),
  firestore: jest.fn(() => ({
    runTransaction: async (fn) => fn({get: async () => ({exists: false}), set: () => undefined}),
  })),
}));

jest.mock("../../libs/firestore", () => ({
  collection: jest.fn(() => ({
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    get: jest.fn(async () => ({empty: true, docs: []})),
    add: jest.fn(async () => ({id: "ctx_test"})),
    doc: jest.fn(() => ({get: jest.fn(async () => ({exists: false}))})),
  })),
  serverTimestamp: jest.fn(() => "ts"),
}));

jest.mock("../../services/ledger/ledgerService", () => ({
  hasLedgerEntry: jest.fn(async () => false),
  appendTransaction: jest.fn(async () => ({entryId: "cl_ref", newBalance: 20})),
  getLedgerBalance: jest.fn(async () => 20),
}));

jest.mock("../../services/crypto/evm/evmRpcService", () => {
  const actual = jest.requireActual("../../services/crypto/evm/evmRpcService");
  return {
    ...actual,
    getTransaction: jest.fn(),
    getTransactionReceipt: jest.fn(),
  };
});

const evmRpcService = require("../../services/crypto/evm/evmRpcService");
const ledgerService = require("../../services/ledger/ledgerService");
const {
  validateFujiUsdcDeposit,
  testProcessUsdcDeposit,
  DepositValidationError,
} = require("../../services/crypto/testProcessUsdcDepositService");

function transferLog({
  token = USDC,
  to = TREASURY,
  from = FROM,
  value = RAW_20,
  txHash = TX_HASH,
  index = 0,
} = {}) {
  const encoded = iface.encodeEventLog("Transfer", [from, to, value]);
  return {
    address: token,
    topics: encoded.topics,
    data: encoded.data,
    transactionHash: txHash,
    index,
    blockNumber: 100,
  };
}

function validPair({
  chainId = 43113,
  status = 1,
  token = USDC,
  to = TREASURY,
  value = RAW_20,
} = {}) {
  return {
    transaction: {hash: TX_HASH, chainId},
    receipt: {
      status,
      hash: TX_HASH,
      logs: [transferLog({token, to, value})],
    },
  };
}

describe("USDC raw amount conversion", () => {
  it("converts 20000000 raw units to 20 USDC", () => {
    expect(fromUsdcUnits(20_000_000n)).toBe(20);
    expect(fromUsdcUnits("20000000")).toBe(20);
    expect(toUsdcUnits("20")).toBe(20_000_000n);
  });
});

describe("validateFujiUsdcDeposit", () => {
  it("accepts a valid Fuji USDC transfer of 20", () => {
    const result = validateFujiUsdcDeposit(validPair());
    expect(result.amount).toBe(20);
    expect(result.raw).toBe("20000000");
    expect(result.token).toBe("USDC");
    expect(result.network).toBe("avalanche-fuji");
    expect(result.chainId).toBe(43113);
    expect(result.to).toBe(TREASURY.toLowerCase());
    expect(result.txHash).toBe(TX_HASH);
  });

  it("rejects the wrong chain", () => {
    expect(() => validateFujiUsdcDeposit(validPair({chainId: 1}))).toThrow(DepositValidationError);
    try {
      validateFujiUsdcDeposit(validPair({chainId: 1}));
    } catch (err) {
      expect(err.code).toBe("WRONG_CHAIN");
    }
  });

  it("rejects the wrong token contract", () => {
    try {
      validateFujiUsdcDeposit(validPair({token: OTHER_TOKEN}));
      throw new Error("expected reject");
    } catch (err) {
      expect(err.code).toBe("WRONG_TOKEN");
    }
  });

  it("rejects the wrong recipient", () => {
    try {
      validateFujiUsdcDeposit(validPair({to: OTHER_RECIPIENT}));
      throw new Error("expected reject");
    } catch (err) {
      expect(err.code).toBe("WRONG_RECIPIENT");
    }
  });

  it("rejects a failed transaction", () => {
    try {
      validateFujiUsdcDeposit(validPair({status: 0}));
      throw new Error("expected reject");
    } catch (err) {
      expect(err.code).toBe("TX_FAILED");
    }
  });

  it("rejects a zero amount", () => {
    try {
      validateFujiUsdcDeposit(validPair({value: 0n}));
      throw new Error("expected reject");
    } catch (err) {
      expect(err.code).toBe("INVALID_AMOUNT");
    }
  });
});

describe("testProcessUsdcDeposit", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ledgerService.hasLedgerEntry.mockResolvedValue(false);
    ledgerService.appendTransaction.mockResolvedValue({entryId: "cl_ref", newBalance: 20});
    evmRpcService.getTransaction.mockResolvedValue({hash: TX_HASH, chainId: 43113});
    evmRpcService.getTransactionReceipt.mockResolvedValue({
      status: 1,
      hash: TX_HASH,
      logs: [transferLog()],
    });
  });

  it("credits 20 USDC to the super-admin ledger", async () => {
    const result = await testProcessUsdcDeposit(TX_HASH, {userId: "super_admin_uid"});
    expect(result.success).toBe(true);
    expect(result.credited).toBe(true);
    expect(result.alreadyProcessed).toBe(false);
    expect(result.amount).toBe(20);
    expect(result.userId).toBe("super_admin_uid");
    expect(result.role).toBe("super_admin");
    expect(result.entryId).toBe("cl_ref");
    expect(result.balance).toBe(20);
    expect(ledgerService.appendTransaction).toHaveBeenCalledWith({
      userId: "super_admin_uid",
      type: "deposit",
      asset: "USDC",
      amount: 20,
      direction: "credit",
      source: "turnkey",
      referenceId: `${TX_HASH}_0`,
    });
  });

  it("does not credit a duplicate transaction hash", async () => {
    ledgerService.hasLedgerEntry.mockResolvedValue(true);
    ledgerService.getLedgerBalance.mockResolvedValue(20);
    const result = await testProcessUsdcDeposit(TX_HASH, {userId: "super_admin_uid"});
    expect(result.success).toBe(true);
    expect(result.alreadyProcessed).toBe(true);
    expect(result.credited).toBe(false);
    expect(result.balance).toBe(20);
    expect(ledgerService.appendTransaction).not.toHaveBeenCalled();
  });
});
