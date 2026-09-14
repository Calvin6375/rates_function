/**
 * @fileoverview Read-only Turnkey treasury USDC/USDT balance lookup.
 */

const {Interface, ethers} = require("ethers");
const {ERC20_TRANSFER_ABI} = require("../../services/crypto/evm/fujiNetwork");

const originalEnv = {...process.env};
const iface = new Interface(ERC20_TRANSFER_ABI);
const decimalsSelector = iface.getFunction("decimals").selector;
const TREASURY = "0x952bBC4952A98a49E112d06DBaAe0FAA37eF080A";
const USDC = "0x5425890298aed601595a70AB815c96711a31Bc65";
const USDT = "0x3333333333333333333333333333333333333333";

function loadModules() {
  jest.resetModules();
  const evmRpcService = require("../../services/crypto/evm/evmRpcService");
  const client = require("../../services/crypto/turnkey/turnkeyClient");
  return {client, evmRpcService};
}

function mockTreasuryWallet(client) {
  client.setApiClientForTests({
    getWallets: jest.fn(async () => ({
      wallets: [{walletId: "wal_treasury", walletName: "TruePay Treasury Dev"}],
    })),
    getWalletAccounts: jest.fn(async () => ({
      accounts: [{address: TREASURY, addressFormat: "ADDRESS_FORMAT_ETHEREUM"}],
    })),
    createWallet: jest.fn(),
  });
}

function mockProvider(evmRpcService, {usdcUnits = 1_250_000n, usdtUnits = 3_000_000n} = {}) {
  const mock = {
    getBalance: jest.fn(async () => ethers.parseEther("0.5")),
    call: jest.fn(async ({to, data}) => {
      if (String(data).startsWith(decimalsSelector)) {
        return iface.encodeFunctionResult("decimals", [6]);
      }
      if (String(to).toLowerCase() === USDC.toLowerCase()) {
        return iface.encodeFunctionResult("balanceOf", [usdcUnits]);
      }
      if (String(to).toLowerCase() === USDT.toLowerCase()) {
        return iface.encodeFunctionResult("balanceOf", [usdtUnits]);
      }
      throw new Error(`unexpected call ${to}`);
    }),
    broadcastTransaction: jest.fn(),
    sendTransaction: jest.fn(),
  };
  evmRpcService.setProviderForTests(mock);
  return mock;
}

describe("getTurnkeyTreasuryBalances", () => {
  afterEach(() => {
    process.env = {...originalEnv};
    jest.resetModules();
  });

  function configured() {
    process.env.TURNKEY_ORGANIZATION_ID = "org_test";
    process.env.TURNKEY_API_PUBLIC_KEY = "pub_test";
    process.env.TURNKEY_API_PRIVATE_KEY = "priv_secret_value";
    delete process.env.AVALANCHE_FUJI_USDT_CONTRACT;
    return loadModules();
  }

  it("retrieves the USDC balance for the treasury address", async () => {
    const {client, evmRpcService} = configured();
    mockTreasuryWallet(client);
    mockProvider(evmRpcService, {usdcUnits: 1_250_000n});

    const result = await client.getTurnkeyTreasuryBalances();
    expect(result.success).toBe(true);
    expect(result.address.toLowerCase()).toBe(TREASURY.toLowerCase());
    expect(result.network).toBe("avalanche-fuji");
    expect(result.balances.USDC).toEqual({
      raw: "1250000",
      decimals: 6,
      balance: "1.250000",
    });
  });

  it("retrieves the USDT balance when a contract is already configured", async () => {
    process.env.TURNKEY_ORGANIZATION_ID = "org_test";
    process.env.TURNKEY_API_PUBLIC_KEY = "pub_test";
    process.env.TURNKEY_API_PRIVATE_KEY = "priv_secret_value";
    process.env.AVALANCHE_FUJI_USDT_CONTRACT = USDT;
    const {client, evmRpcService} = loadModules();
    mockTreasuryWallet(client);
    mockProvider(evmRpcService, {usdtUnits: 3_000_000n});

    const result = await client.getTurnkeyTreasuryBalances();
    expect(result.balances.USDT).toEqual({
      raw: "3000000",
      decimals: 6,
      balance: "3.000000",
    });
  });

  it("converts raw ERC-20 units with on-chain decimals", () => {
    const {evmRpcService} = configured();
    expect(evmRpcService.formatTokenBalance(0n, 6)).toBe("0");
    expect(evmRpcService.formatTokenBalance(1_250_000n, 6)).toBe("1.250000");
    expect(evmRpcService.formatTokenBalance("1000000", 6)).toBe("1.000000");
    expect(evmRpcService.formatTokenBalance(1n, 6)).toBe("0.000001");
  });

  it("is read-only: no Turnkey create/sign and no RPC broadcast", async () => {
    const {client, evmRpcService} = configured();
    const turnkey = {
      getWallets: jest.fn(async () => ({
        wallets: [{walletId: "wal_treasury", walletName: "TruePay Treasury Dev"}],
      })),
      getWalletAccounts: jest.fn(async () => ({
        accounts: [{address: TREASURY, addressFormat: "ADDRESS_FORMAT_ETHEREUM"}],
      })),
      createWallet: jest.fn(),
      signTransaction: jest.fn(),
    };
    client.setApiClientForTests(turnkey);
    const provider = mockProvider(evmRpcService);

    await client.getTurnkeyTreasuryBalances();
    expect(turnkey.createWallet).not.toHaveBeenCalled();
    expect(turnkey.signTransaction).not.toHaveBeenCalled();
    expect(provider.broadcastTransaction).not.toHaveBeenCalled();
    expect(provider.sendTransaction).not.toHaveBeenCalled();
    expect(provider.call).toHaveBeenCalled();
  });

  it("sanitizes RPC/Turnkey errors", async () => {
    const {client, evmRpcService} = configured();
    mockTreasuryWallet(client);
    const logs = [];
    const spy = jest.spyOn(console, "error").mockImplementation((line) => logs.push(String(line)));
    evmRpcService.setProviderForTests({
      getBalance: jest.fn(async () => 0n),
      call: jest.fn(async () => {
        throw new Error("rpc denied priv_secret_value X-Stamp:abc https://api.avax-test.network/ext/bc/C/rpc");
      }),
    });

    await expect(client.getTurnkeyTreasuryBalances()).rejects.toThrow(/Turnkey treasury balance lookup failed/);
    const joined = logs.join("\n");
    expect(joined).not.toContain("priv_secret_value");
    expect(joined).not.toContain("X-Stamp:abc");
    expect(joined).not.toContain("https://api.avax-test.network/ext/bc/C/rpc");
    spy.mockRestore();
  });

  it("does not return secrets", async () => {
    const {client, evmRpcService} = configured();
    mockTreasuryWallet(client);
    mockProvider(evmRpcService);
    const result = await client.getTurnkeyTreasuryBalances();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("priv_secret_value");
    expect(serialized).not.toContain("pub_test");
    expect(serialized).not.toContain("org_test");
    expect(serialized).not.toContain("api.avax-test.network");
    expect(result).not.toHaveProperty("apiPrivateKey");
    expect(result).not.toHaveProperty("rpcUrl");
  });
});
