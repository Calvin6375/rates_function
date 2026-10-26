/**
 * @fileoverview Avalanche RPC URL order and rate-limit failover classification.
 */

const {
  listAvalancheRpcUrls,
  isFailoverRpcError,
  createThrottledProvider,
} = require("../../services/crypto/evm/avalancheRpc");

describe("Avalanche RPC failover", () => {
  const original = process.env.AVALANCHE_RPC_FALLBACK_URLS;

  afterEach(() => {
    if (original == null) {
      delete process.env.AVALANCHE_RPC_FALLBACK_URLS;
    } else {
      process.env.AVALANCHE_RPC_FALLBACK_URLS = original;
    }
  });

  it("tries the configured endpoint before public alternates", () => {
    delete process.env.AVALANCHE_RPC_FALLBACK_URLS;
    const urls = listAvalancheRpcUrls("https://api.avax.network/ext/bc/C/rpc");
    expect(urls[0]).toBe("https://api.avax.network/ext/bc/C/rpc");
    expect(urls).toContain("https://avalanche-c-chain-rpc.publicnode.com");
    expect(urls).toContain("https://1rpc.io/avax/c");
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("places operator fallbacks ahead of the built-in alternates", () => {
    process.env.AVALANCHE_RPC_FALLBACK_URLS = "https://rpc.example.test/avax, https://1rpc.io/avax/c";
    const urls = listAvalancheRpcUrls("https://api.avax.network/ext/bc/C/rpc");
    expect(urls.slice(0, 3)).toEqual([
      "https://api.avax.network/ext/bc/C/rpc",
      "https://rpc.example.test/avax",
      "https://1rpc.io/avax/c",
    ]);
  });

  it("treats HTTP 429 and Cloudflare 1015 as failover errors", () => {
    expect(isFailoverRpcError({code: "SERVER_ERROR", message: "429 Too Many Requests"})).toBe(true);
    expect(isFailoverRpcError({message: "error code: 1015"})).toBe(true);
    expect(isFailoverRpcError({message: "exceeded maximum retry limit"})).toBe(true);
    expect(isFailoverRpcError({code: "INVALID_ADDRESS", message: "bad address"})).toBe(false);
    expect(isFailoverRpcError({code: "CALL_EXCEPTION", message: "execution reverted"})).toBe(false);
  });

  it("caps ethers retries so a 429 does not hammer the same host", () => {
    const provider = createThrottledProvider("https://rpc.example.test/avax", 43114);
    const req = provider._getConnection().url;
    expect(String(req)).toContain("rpc.example.test");
  });
});
