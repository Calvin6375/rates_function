/**
 * @fileoverview Read-only Turnkey treasury USDC/AVAX balance lookup.
 */

const {Interface, ethers} = require("ethers");
const {ERC20_TRANSFER_ABI} = require("../../services/crypto/evm/fujiNetwork");

const originalEnv = {...process.env};
const iface = new Interface(ERC20_TRANSFER_ABI);
const decimalsSelector = iface.getFunction("decimals").selector;
const TREASURY = "0x952bBC4952A98a49E112d06DBaAe0FAA37eF080A";
const FUJI_USDC = "0x5425890298aed601595a70AB815c96711a31Bc65";
const MAINNET_USDC = "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E";
const USDT = "0x3333333333333333333333333333333333333333";
const OTHER_WALLET = "0x1111111111111111111111111111111111111111";

function loadModules() {
  jest.resetModules();
  const evmRpcService = require("../../services/crypto/evm/evmRpcService");
  const client = require("../../services/crypto/turnkey/turnkeyClient");
  return {client, evmRpcService};
}

function mockTreasuryWallet(client, address = TREASURY) {
  client.setApiClientForTests({
    getWallets: jest.fn(async () => ({
      wallets: [{walletId: "wal_treasury", walletName: "TruePay Treasury Dev"}],
    })),
    getWalletAccounts: jest.fn(async () => ({
      accounts: [{address, addressFormat: "ADDRESS_FORMAT_ETHEREUM"}],
    })),
    createWallet: jest.fn(),
  });
}

function mockProvider(evmRpcService, {
  usdcUnits = 1_250_000n,
  usdtUnits = 3_000_000n,
  avaxWei = ethers.parseEther("0.5"),
} = {}) {
  const mock = {
    getBalance: jest.fn(async () => avaxWei),
    call: jest.fn(async ({to, data}) => {
      if (String(data).startsWith(decimalsSelector)) {
        return iface.encodeFunctionResult("decimals", [6]);
      }
      const target = String(to).toLowerCase();
      if (target === FUJI_USDC.toLowerCase() || target === MAINNET_USDC.toLowerCase()) {
        return iface.encodeFunctionResult("balanceOf", [usdcUnits]);
      }
      if (target === USDT.toLowerCase()) {
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
    process.env.CRYPTO_TREASURY_ADDRESS = TREASURY;
    delete process.env.AVALANCHE_FUJI_USDT_CONTRACT;
    return loadModules();
  }

  it("retrieves the Fuji USDC balance for the treasury address", async () => {
    const {client, evmRpcService} = configured();
    mockTreasuryWallet(client);
    mockProvider(evmRpcService, {usdcUnits: 1_250_000n});

    const result = await client.getTurnkeyTreasuryBalances();
    expect(result.success).toBe(true);
    expect(result.address.toLowerCase()).toBe(TREASURY.toLowerCase());
    expect(result.wallet.address.toLowerCase()).toBe(TREASURY.toLowerCase());
    expect(result.network).toBe("avalanche-fuji");
    expect(result.chainId).toBe(43113);
    expect(result.checkedAt).toEqual(expect.any(String));
    expect(result.balances.USDC).toEqual({
      balance: "1.250000",
      rawBalance: "1250000",
      decimals: 6,
      raw: "1250000",
    });
  });

  it("retrieves mainnet USDC and AVAX for chain 43114", async () => {
    const {client, evmRpcService} = configured();
    mockTreasuryWallet(client);
    const provider = mockProvider(evmRpcService, {
      usdcUnits: 4_250_000n,
      avaxWei: ethers.parseEther("1.25"),
    });

    const result = await client.getTurnkeyTreasuryBalances({network: "avalanche"});
    expect(result.success).toBe(true);
    expect(result.network).toBe("avalanche");
    expect(result.chainId).toBe(43114);
    expect(result.wallet.address).toBe(TREASURY);
    expect(result.balances.USDC).toEqual({
      balance: "4.250000",
      rawBalance: "4250000",
      decimals: 6,
      raw: "4250000",
    });
    expect(result.balances.AVAX).toEqual({
      balance: "1.25000000",
      rawBalance: ethers.parseEther("1.25").toString(),
      decimals: 18,
      raw: ethers.parseEther("1.25").toString(),
    });
    expect(result.balances.USDT).toBeUndefined();

    const usdcCalls = provider.call.mock.calls.filter(([req]) =>
      String(req.to).toLowerCase() === MAINNET_USDC.toLowerCase());
    expect(usdcCalls.length).toBeGreaterThan(0);
    expect(provider.getBalance).toHaveBeenCalledWith(TREASURY);
  });

  it("converts raw mainnet USDC units with 6 decimals", async () => {
    const {client, evmRpcService} = configured();
    mockTreasuryWallet(client);
    mockProvider(evmRpcService, {usdcUnits: 1n});

    const result = await client.getTurnkeyTreasuryBalances({network: "avalanche"});
    expect(result.balances.USDC).toEqual({
      balance: "0.000001",
      rawBalance: "1",
      decimals: 6,
      raw: "1",
    });
  });

  it("retrieves the USDT balance when a Fuji contract is already configured", async () => {
    process.env.TURNKEY_ORGANIZATION_ID = "org_test";
    process.env.TURNKEY_API_PUBLIC_KEY = "pub_test";
    process.env.TURNKEY_API_PRIVATE_KEY = "priv_secret_value";
    process.env.CRYPTO_TREASURY_ADDRESS = TREASURY;
    process.env.AVALANCHE_FUJI_USDT_CONTRACT = USDT;
    const {client, evmRpcService} = loadModules();
    mockTreasuryWallet(client);
    mockProvider(evmRpcService, {usdtUnits: 3_000_000n});

    const result = await client.getTurnkeyTreasuryBalances({network: "avalanche-fuji"});
    expect(result.network).toBe("avalanche-fuji");
    expect(result.chainId).toBe(43113);
    expect(result.balances.USDT).toEqual({
      balance: "3.000000",
      rawBalance: "3000000",
      decimals: 6,
      raw: "3000000",
    });
  });

  it("converts raw ERC-20 units with on-chain decimals", () => {
    const {evmRpcService} = configured();
    expect(evmRpcService.formatTokenBalance(0n, 6)).toBe("0");
    expect(evmRpcService.formatTokenBalance(1_250_000n, 6)).toBe("1.250000");
    expect(evmRpcService.formatTokenBalance("1000000", 6)).toBe("1.000000");
    expect(evmRpcService.formatTokenBalance(1n, 6)).toBe("0.000001");
    expect(evmRpcService.formatFixedTokenBalance(0n, 6)).toBe("0.000000");
    expect(evmRpcService.formatFixedTokenBalance(1_250_000n, 6)).toBe("1.250000");
    expect(evmRpcService.formatFixedTokenBalance(ethers.parseEther("0.5"), 18, 8)).toBe("0.50000000");
  });

  it("rejects an unsupported network", async () => {
    const {client} = configured();
    mockTreasuryWallet(client);
    await expect(client.getTurnkeyTreasuryBalances({network: "ethereum"}))
        .rejects.toMatchObject({code: "UNSUPPORTED_NETWORK"});
  });

  it("fails safely when the Turnkey address is not the configured treasury", async () => {
    const {client, evmRpcService} = configured();
    mockTreasuryWallet(client, OTHER_WALLET);
    mockProvider(evmRpcService);
    await expect(client.getTurnkeyTreasuryBalances({network: "avalanche"}))
        .rejects.toMatchObject({
          code: "TREASURY_CONFIG_INVALID",
          message: expect.stringMatching(/does not match the configured TruePay treasury/),
        });
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

    await client.getTurnkeyTreasuryBalances({network: "avalanche"});
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
        throw new Error("rpc denied priv_secret_value X-Stamp:abc https://api.avax.network/ext/bc/C/rpc");
      }),
    });

    await expect(client.getTurnkeyTreasuryBalances({network: "avalanche"}))
        .rejects.toThrow(/Turnkey treasury balance lookup failed/);
    const joined = logs.join("\n");
    expect(joined).not.toContain("priv_secret_value");
    expect(joined).not.toContain("X-Stamp:abc");
    expect(joined).not.toContain("https://api.avax.network/ext/bc/C/rpc");
    spy.mockRestore();
  });

  it("does not return secrets", async () => {
    const {client, evmRpcService} = configured();
    mockTreasuryWallet(client);
    mockProvider(evmRpcService);
    const result = await client.getTurnkeyTreasuryBalances({network: "avalanche"});
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("priv_secret_value");
    expect(serialized).not.toContain("pub_test");
    expect(serialized).not.toContain("org_test");
    expect(serialized).not.toContain("api.avax.network");
    expect(result).not.toHaveProperty("apiPrivateKey");
    expect(result).not.toHaveProperty("rpcUrl");
  });
});
