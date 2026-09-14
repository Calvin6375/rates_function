/**
 * @fileoverview Fuji network config, address validation, and USDC unit helpers.
 */

const {
  getFujiNetwork,
  isValidEvmAddress,
  isTreasuryAddress,
  normalizeAddress,
  TRANSFER_EVENT_TOPIC,
} = require("../../services/crypto/evm/fujiNetwork");
const {isValidUsdcAmount, toUsdcUnits, fromUsdcUnits} = require("../../services/crypto/evm/usdcUnits");
const {getTurnkeyConfig, isTurnkeyConfigured} = require("../../services/crypto/turnkey/turnkeyClient");

describe("Turnkey / Fuji configuration", () => {
  const originalEnv = {...process.env};

  afterEach(() => {
    process.env = {...originalEnv};
  });

  it("uses official Fuji defaults", () => {
    const network = getFujiNetwork();
    expect(network.chainId).toBe(43113);
    expect(network.network).toBe("avalanche-fuji");
    expect(network.blockchain).toBe("AVALANCHE");
    expect(network.rpcUrl).toContain("avax-test.network");
    expect(network.usdcContract).toBe("0x5425890298aed601595a70ab815c96711a31bc65");
    expect(network.nativeToken).toBe("AVAX");
    expect(network.treasuryAddress).toBe("0x952bbc4952a98a49e112d06dbaae0faa37ef080a");
  });

  it("allows RPC, chain id, and USDC contract to be overridden", () => {
    process.env.AVALANCHE_FUJI_CHAIN_ID = "43113";
    process.env.AVALANCHE_FUJI_RPC_URL = "https://example-fuji-rpc.test/ext/bc/C/rpc";
    process.env.AVALANCHE_FUJI_USDC_CONTRACT = "0x5425890298aed601595a70AB815c96711a31Bc65";
    const network = getFujiNetwork();
    expect(network.chainId).toBe(43113);
    expect(network.rpcUrl).toBe("https://example-fuji-rpc.test/ext/bc/C/rpc");
    expect(network.usdcContract).toBe("0x5425890298aed601595a70ab815c96711a31bc65");
  });

  it("reads Turnkey credentials from the environment only", () => {
    process.env.TURNKEY_ORGANIZATION_ID = "org_test";
    process.env.TURNKEY_API_PUBLIC_KEY = "pub_test";
    process.env.TURNKEY_API_PRIVATE_KEY = "priv_test";
    const cfg = getTurnkeyConfig();
    expect(cfg.organizationId).toBe("org_test");
    expect(cfg.apiPublicKey).toBe("pub_test");
    expect(cfg.apiPrivateKey).toBe("priv_test");
    expect(isTurnkeyConfigured()).toBe(true);
  });

  it("is not configured without credentials", () => {
    delete process.env.TURNKEY_ORGANIZATION_ID;
    delete process.env.TURNKEY_API_PUBLIC_KEY;
    delete process.env.TURNKEY_API_PRIVATE_KEY;
    jest.resetModules();
    const client = require("../../services/crypto/turnkey/turnkeyClient");
    expect(client.isTurnkeyConfigured()).toBe(false);
  });
});

describe("EVM address helpers", () => {
  it("accepts a valid checksum address", () => {
    expect(isValidEvmAddress("0x952bBC4952A98a49E112d06DBaAe0FAA37eF080A")).toBe(true);
  });

  it("rejects invalid and zero addresses", () => {
    expect(isValidEvmAddress("not-an-address")).toBe(false);
    expect(isValidEvmAddress("0x0000000000000000000000000000000000000000")).toBe(false);
    expect(isValidEvmAddress("")).toBe(false);
  });

  it("identifies the treasury address", () => {
    expect(isTreasuryAddress("0x952bBC4952A98a49E112d06DBaAe0FAA37eF080A")).toBe(true);
    expect(isTreasuryAddress("0x1111111111111111111111111111111111111111")).toBe(false);
  });

  it("normalizes addresses to lowercase", () => {
    expect(normalizeAddress("0xABC")).toBe("0xabc");
  });

  it("exposes the ERC-20 Transfer topic", () => {
    expect(TRANSFER_EVENT_TOPIC).toMatch(/^0xddf252ad/);
  });
});

describe("USDC units", () => {
  it("converts decimal amounts to 6-decimal units", () => {
    expect(toUsdcUnits("1.25")).toBe(1_250_000n);
    expect(fromUsdcUnits(1_250_000n)).toBe(1.25);
    expect(fromUsdcUnits(100000n)).toBe(0.1);
    expect(toUsdcUnits(fromUsdcUnits(100000n))).toBe(100000n);
  });

  it("rejects invalid amounts", () => {
    expect(isValidUsdcAmount(0)).toBe(false);
    expect(isValidUsdcAmount(-1)).toBe(false);
    expect(isValidUsdcAmount("1.1234567")).toBe(false);
    expect(isValidUsdcAmount("abc")).toBe(false);
    expect(isValidUsdcAmount("2")).toBe(true);
  });
});
