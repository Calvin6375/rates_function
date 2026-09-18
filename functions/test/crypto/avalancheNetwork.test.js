/**
 * @fileoverview Avalanche mainnet vs Fuji network configuration.
 */

const {getFujiNetwork} = require("../../services/crypto/evm/fujiNetwork");
const {getAvalancheNetwork} = require("../../services/crypto/evm/avalancheNetwork");
const {
  assertSupportedNetwork,
  depositEventPrefix,
  getNetworkConfig,
  normalizeNetworkName,
} = require("../../services/crypto/evm/networkConfig");

describe("Avalanche mainnet configuration", () => {
  const originalEnv = {...process.env};

  afterEach(() => {
    process.env = {...originalEnv};
  });

  it("uses official Avalanche C-Chain USDC defaults", () => {
    const network = getAvalancheNetwork();
    expect(network.network).toBe("avalanche");
    expect(network.chainId).toBe(43114);
    expect(network.rpcUrl).toBe("https://api.avax.network/ext/bc/C/rpc");
    expect(network.usdcContract).toBe("0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e");
    expect(network.nativeToken).toBe("AVAX");
    expect(network.usdcDecimals).toBe(6);
  });

  it("does not replace Fuji configuration", () => {
    const fuji = getFujiNetwork();
    const mainnet = getAvalancheNetwork();
    expect(fuji.chainId).toBe(43113);
    expect(mainnet.chainId).toBe(43114);
    expect(fuji.network).toBe("avalanche-fuji");
    expect(mainnet.network).toBe("avalanche");
    expect(fuji.usdcContract).not.toBe(mainnet.usdcContract);
    expect(fuji.rpcUrl).toContain("avax-test.network");
    expect(mainnet.rpcUrl).toContain("api.avax.network");
  });

  it("resolves network config and deposit event prefixes independently", () => {
    expect(normalizeNetworkName("avalanche")).toBe("avalanche");
    expect(normalizeNetworkName("avalanche-fuji")).toBe("avalanche-fuji");
    expect(normalizeNetworkName(undefined)).toBe("avalanche-fuji");
    expect(getNetworkConfig("avalanche").chainId).toBe(43114);
    expect(getNetworkConfig("avalanche-fuji").chainId).toBe(43113);
    expect(depositEventPrefix("avalanche")).toBe("avax");
    expect(depositEventPrefix("avalanche-fuji")).toBe("avax-fuji");
  });

  it("rejects unsupported treasury networks", () => {
    expect(assertSupportedNetwork("avalanche")).toBe("avalanche");
    expect(assertSupportedNetwork("avalanche-fuji")).toBe("avalanche-fuji");
    expect(() => assertSupportedNetwork("ethereum")).toThrow(/Unsupported network/);
    expect(() => assertSupportedNetwork("")).toThrow(/Unsupported network/);
  });
});
