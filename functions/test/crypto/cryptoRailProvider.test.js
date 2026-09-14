/**
 * @fileoverview Provider factory: Circle remains selectable, Turnkey is opt-in.
 */

describe("cryptoRailProvider", () => {
  const originalEnv = {...process.env};

  afterEach(() => {
    process.env = {...originalEnv};
    jest.resetModules();
  });

  it("defaults to Circle for rollback safety", () => {
    delete process.env.CRYPTO_RAIL_PROVIDER;
    jest.resetModules();
    const provider = require("../../services/crypto/cryptoRailProvider");
    expect(provider.getCryptoRailProviderName()).toBe("circle");
    const adapter = provider.getCryptoRailAdapter();
    expect(adapter.PROVIDER).toBe("circle");
    expect(typeof adapter.send).toBe("function");
    expect(typeof adapter.createWallet).toBe("function");
    expect(typeof adapter.getWallet).toBe("function");
    expect(typeof adapter.getBalance).toBe("function");
    expect(typeof adapter.handleWebhookEvent).toBe("function");
  });

  it("selects the Turnkey adapter when CRYPTO_RAIL_PROVIDER=turnkey", () => {
    process.env.CRYPTO_RAIL_PROVIDER = "turnkey";
    jest.resetModules();
    const provider = require("../../services/crypto/cryptoRailProvider");
    expect(provider.getCryptoRailProviderName()).toBe("turnkey");
    const adapter = provider.getCryptoRailAdapter();
    expect(adapter.PROVIDER).toBe("turnkey");
    expect(typeof adapter.signTransaction).toBe("function");
    expect(typeof adapter.broadcastTransaction).toBe("function");
    expect(typeof adapter.getTransactionStatus).toBe("function");
  });

  it("keeps Circle adapter exports intact", () => {
    const circle = require("../../services/circle/circleRailAdapter");
    expect(circle.PROVIDER).toBe("circle");
    expect(circle.ASSET).toBe("USDC");
    expect(typeof circle.handleWebhookEvent).toBe("function");
    expect(typeof circle.verifyWebhookSignature).toBe("function");
    expect(typeof circle.normalizeCircleEvent).toBe("function");
  });
});
