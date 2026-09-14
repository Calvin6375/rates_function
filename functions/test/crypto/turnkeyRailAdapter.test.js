/**
 * @fileoverview Turnkey send flow: reservation, signing, broadcast, idempotency, errors.
 */

const mockAdd = jest.fn(async () => ({id: "fs_tx_1"}));
const mockIdempotencyDelete = jest.fn(async () => undefined);

jest.mock("../../libs/firestore", () => ({
  collection: jest.fn((name) => {
    if (name === "cryptoTransactions") {
      return {
        add: mockAdd,
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        get: jest.fn(async () => ({docs: []})),
      };
    }
    return {
      doc: jest.fn(() => ({delete: mockIdempotencyDelete})),
    };
  }),
  serverTimestamp: jest.fn(() => "ts"),
}));

jest.mock("../../services/ledger/ledgerService", () => ({
  getAvailableBalance: jest.fn(async () => 25),
}));

jest.mock("../../services/ledger/reservationService", () => ({
  reserveFunds: jest.fn(async () => ({reservationId: "res_key1"})),
  attachProviderTransactionId: jest.fn(async () => undefined),
  releaseReservation: jest.fn(async () => undefined),
}));

jest.mock("../../services/circle/sendIdempotencyService", () => ({
  acquireSendKey: jest.fn(),
  storeSendResult: jest.fn(async () => undefined),
}));

jest.mock("../../services/crypto/turnkey/turnkeyWalletService", () => ({
  getWallet: jest.fn(),
  getWalletByProviderId: jest.fn(),
  createWallet: jest.fn(),
}));

jest.mock("../../services/crypto/turnkey/turnkeyClient", () => ({
  isTurnkeyConfigured: jest.fn(() => true),
  getApiClient: jest.fn(),
}));

jest.mock("../../services/crypto/evm/evmRpcService", () => {
  const actual = jest.requireActual("../../services/crypto/evm/evmRpcService");
  return {
    ...actual,
    getTransactionCount: jest.fn(async () => 1),
    getFeeData: jest.fn(async () => ({
      maxFeePerGas: 30_000_000_000n,
      maxPriorityFeePerGas: 25_000_000_000n,
    })),
    estimateGas: jest.fn(async () => 65000n),
    assertSufficientGas: jest.fn(async () => undefined),
    broadcastTransaction: jest.fn(async () => "0xdeadbeef"),
    getOnChainBalances: jest.fn(),
    getTransactionStatus: jest.fn(),
    encodeUsdcTransfer: actual.encodeUsdcTransfer,
    serializeUnsignedTransaction: actual.serializeUnsignedTransaction,
  };
});

const reservationService = require("../../services/ledger/reservationService");
const sendIdempotencyService = require("../../services/circle/sendIdempotencyService");
const turnkeyWalletService = require("../../services/crypto/turnkey/turnkeyWalletService");
const turnkeyClient = require("../../services/crypto/turnkey/turnkeyClient");
const evmRpcService = require("../../services/crypto/evm/evmRpcService");
const adapter = require("../../services/crypto/providers/turnkeyRailAdapter");
const ledgerService = require("../../services/ledger/ledgerService");

const WALLET = {
  userId: "user_1",
  walletId: "tk-1",
  address: "0x1111111111111111111111111111111111111111",
};

describe("turnkeyRailAdapter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    turnkeyWalletService.getWalletByProviderId.mockResolvedValue(WALLET);
    sendIdempotencyService.acquireSendKey.mockResolvedValue({acquired: true});
    turnkeyClient.getApiClient.mockReturnValue({
      signTransaction: jest.fn(async () => ({signedTransaction: "0xsigned"})),
    });
    evmRpcService.assertSufficientGas.mockResolvedValue(undefined);
    evmRpcService.broadcastTransaction.mockResolvedValue("0xdeadbeef");
  });

  it("returns ledger available balance, not on-chain balanceOf", async () => {
    ledgerService.getAvailableBalance.mockResolvedValue(12.5);
    await expect(adapter.getBalance("user_1")).resolves.toBe(12.5);
    expect(ledgerService.getAvailableBalance).toHaveBeenCalledWith("user_1", "USDC");
  });

  it("sends USDC: reserve, sign, broadcast, persist pending", async () => {
    const result = await adapter.send({
      fromWalletId: "tk-1",
      toAddress: "0x952bBC4952A98a49E112d06DBaAe0FAA37eF080A",
      amount: 5,
      userId: "user_1",
      idempotencyKey: "key1",
    });
    expect(reservationService.reserveFunds).toHaveBeenCalledWith("user_1", 5, "key1");
    expect(evmRpcService.broadcastTransaction).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.status).toBe("pending");
    expect(result.txHash).toBe("0xdeadbeef");
    expect(result.circleTransactionId).toBe("0xdeadbeef");
    expect(result.reservationId).toBe("res_key1");
    expect(sendIdempotencyService.storeSendResult).toHaveBeenCalled();
  });

  it("returns the cached result for a duplicate idempotency key", async () => {
    const cached = {success: true, txHash: "0xcached", status: "pending"};
    sendIdempotencyService.acquireSendKey.mockResolvedValue({
      acquired: false,
      cachedResult: cached,
    });
    const result = await adapter.send({
      fromWalletId: "tk-1",
      toAddress: "0x952bBC4952A98a49E112d06DBaAe0FAA37eF080A",
      amount: 5,
      userId: "user_1",
      idempotencyKey: "key1",
    });
    expect(result).toEqual(cached);
    expect(reservationService.reserveFunds).not.toHaveBeenCalled();
    expect(evmRpcService.broadcastTransaction).not.toHaveBeenCalled();
  });

  it("releases the reservation when signing fails before broadcast", async () => {
    turnkeyClient.getApiClient.mockReturnValue({
      signTransaction: jest.fn(async () => {
        throw new Error("enclave down");
      }),
    });
    await expect(adapter.send({
      fromWalletId: "tk-1",
      toAddress: "0x952bBC4952A98a49E112d06DBaAe0FAA37eF080A",
      amount: 5,
      userId: "user_1",
      idempotencyKey: "key1",
    })).rejects.toThrow(/Turnkey signing failure/);
    expect(reservationService.releaseReservation).toHaveBeenCalledWith("res_key1");
  });

  it("rejects an invalid destination address", async () => {
    await expect(adapter.send({
      fromWalletId: "tk-1",
      toAddress: "not-an-address",
      amount: 5,
      userId: "user_1",
      idempotencyKey: "key1",
    })).rejects.toThrow(/Invalid destination address/);
  });

  it("rejects an invalid amount", async () => {
    await expect(adapter.send({
      fromWalletId: "tk-1",
      toAddress: "0x952bBC4952A98a49E112d06DBaAe0FAA37eF080A",
      amount: -2,
      userId: "user_1",
      idempotencyKey: "key1",
    })).rejects.toThrow(/Invalid send parameters/);
  });

  it("rejects an unsupported asset", async () => {
    await expect(adapter.send({
      fromWalletId: "tk-1",
      toAddress: "0x952bBC4952A98a49E112d06DBaAe0FAA37eF080A",
      amount: 1,
      userId: "user_1",
      idempotencyKey: "key1",
      asset: "DOGE",
    })).rejects.toThrow(/Unsupported asset/);
  });

  it("surfaces insufficient AVAX gas", async () => {
    const {insufficientGas} = require("../../services/crypto/cryptoErrors");
    evmRpcService.assertSufficientGas.mockRejectedValue(insufficientGas());
    await expect(adapter.send({
      fromWalletId: "tk-1",
      toAddress: "0x952bBC4952A98a49E112d06DBaAe0FAA37eF080A",
      amount: 5,
      userId: "user_1",
      idempotencyKey: "key1",
    })).rejects.toThrow(/Insufficient AVAX gas/);
    expect(reservationService.releaseReservation).toHaveBeenCalled();
  });

  it("propagates insufficient TruePay balance from reserveFunds", async () => {
    reservationService.reserveFunds.mockRejectedValue(
        new Error("Insufficient USDC balance. Available: 1, requested: 5"),
    );
    await expect(adapter.send({
      fromWalletId: "tk-1",
      toAddress: "0x952bBC4952A98a49E112d06DBaAe0FAA37eF080A",
      amount: 5,
      userId: "user_1",
      idempotencyKey: "key1",
    })).rejects.toThrow(/Insufficient USDC balance/);
  });
});
