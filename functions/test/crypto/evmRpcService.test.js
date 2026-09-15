/**
 * @fileoverview RPC helpers: USDC Transfer parsing, calldata, confirmation head.
 */

const {Interface} = require("ethers");
const evmRpcService = require("../../services/crypto/evm/evmRpcService");
const {ERC20_TRANSFER_ABI, TRANSFER_EVENT_TOPIC} = require("../../services/crypto/evm/fujiNetwork");
const {toUsdcUnits} = require("../../services/crypto/evm/usdcUnits");

const iface = new Interface(ERC20_TRANSFER_ABI);

describe("USDC Transfer event parsing", () => {
  it("parses a Transfer log", () => {
    const from = "0x1111111111111111111111111111111111111111";
    const to = "0x2222222222222222222222222222222222222222";
    const encoded = iface.encodeEventLog("Transfer", [from, to, toUsdcUnits("5")]);
    const parsed = evmRpcService.parseUsdcTransferLog({
      topics: encoded.topics,
      data: encoded.data,
      transactionHash: "0xabc123",
      index: 3,
      blockNumber: 99,
    });
    expect(parsed.from).toBe(from);
    expect(parsed.to).toBe(to);
    expect(parsed.value).toBe(5_000_000n);
    expect(parsed.txHash).toBe("0xabc123");
    expect(parsed.logIndex).toBe(3);
    expect(parsed.blockNumber).toBe(99);
  });

  it("returns null for a non-Transfer log", () => {
    expect(evmRpcService.parseUsdcTransferLog({
      topics: ["0xdeadbeef"],
      data: "0x",
    })).toBeNull();
  });

  it("uses the canonical Transfer topic", () => {
    expect(TRANSFER_EVENT_TOPIC).toBe(iface.getEvent("Transfer").topicHash);
  });

  it("adds a recipient topic when filtering deposits", () => {
    const to = "0x3fa194303A09bEa29a76201D3f4C96E321345b2d";
    const topics = evmRpcService.buildUsdcTransferTopics(to);
    expect(topics[0]).toBe(TRANSFER_EVENT_TOPIC);
    expect(topics[1]).toBeNull();
    expect(topics[2].endsWith(to.slice(2).toLowerCase())).toBe(true);
  });
});

describe("USDC transfer calldata and unsigned tx", () => {
  it("encodes ERC-20 transfer(to, amount)", () => {
    const to = "0x952bBC4952A98a49E112d06DBaAe0FAA37eF080A";
    const data = evmRpcService.encodeUsdcTransfer(to, toUsdcUnits("1.5"));
    const decoded = iface.decodeFunctionData("transfer", data);
    expect(decoded.to.toLowerCase()).toBe(to.toLowerCase());
    expect(decoded.amount).toBe(1_500_000n);
  });

  it("serializes an unsigned EIP-1559 transaction", () => {
    const hex = evmRpcService.serializeUnsignedTransaction({
      chainId: 43113,
      nonce: 1,
      maxPriorityFeePerGas: 25_000_000_000n,
      maxFeePerGas: 30_000_000_000n,
      gasLimit: 65000n,
      to: "0x5425890298aed601595a70AB815c96711a31Bc65",
      value: 0n,
      data: "0x",
    });
    expect(hex.startsWith("0x")).toBe(true);
    expect(hex.length).toBeGreaterThan(20);
  });
});

describe("confirmation head", () => {
  it("does not treat the latest block as confirmed when confirmations > 1", () => {
    expect(evmRpcService.confirmedHeadBlock(100, 3)).toBe(98);
    expect(evmRpcService.confirmedHeadBlock(100, 1)).toBe(100);
  });
});

describe("on-chain balances via mocked provider", () => {
  afterEach(() => {
    evmRpcService.setProviderForTests(null);
    evmRpcService.resetProvider();
  });

  it("reads AVAX and USDC from RPC", async () => {
    const {ethers} = require("ethers");
    const mock = {
      getBalance: jest.fn(async () => ethers.parseEther("1.5")),
      call: jest.fn(async () => {
        return iface.encodeFunctionResult("balanceOf", [2_500_000n]);
      }),
    };
    evmRpcService.setProviderForTests(mock);
    const balances = await evmRpcService.getOnChainBalances(
        "0x952bBC4952A98a49E112d06DBaAe0FAA37eF080A",
    );
    expect(balances.avax).toBe("1.5");
    expect(balances.usdc).toBe(2.5);
  });

  it("throws on an invalid address", async () => {
    await expect(evmRpcService.getOnChainBalances("nope")).rejects.toThrow("Invalid destination");
  });
});
