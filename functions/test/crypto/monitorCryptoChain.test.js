/**
 * @fileoverview Scheduled mainnet monitor runs only for the Turnkey rail.
 */

const originalEnv = {...process.env};

jest.mock("../../services/crypto/chainMonitorService", () => ({
  runChainMonitor: jest.fn(async () => ({
    deposits: {network: "avalanche", scanned: 1, credited: 0},
    sends: {pending: 0, completed: 0, failed: 0},
  })),
}));

describe("runScheduledChainMonitor", () => {
  afterEach(() => {
    process.env = {...originalEnv};
    jest.resetModules();
    jest.clearAllMocks();
  });

  it("skips when CRYPTO_RAIL_PROVIDER is not turnkey", async () => {
    process.env.CRYPTO_RAIL_PROVIDER = "circle";
    jest.resetModules();
    const chainMonitorService = require("../../services/crypto/chainMonitorService");
    const {runScheduledChainMonitor} = require("../../jobs/monitorCryptoChain");
    const result = await runScheduledChainMonitor();
    expect(result).toEqual({skipped: true, reason: "provider-not-turnkey"});
    expect(chainMonitorService.runChainMonitor).not.toHaveBeenCalled();
  });

  it("executes the mainnet monitor when CRYPTO_RAIL_PROVIDER=turnkey", async () => {
    process.env.CRYPTO_RAIL_PROVIDER = "turnkey";
    jest.resetModules();
    const chainMonitorService = require("../../services/crypto/chainMonitorService");
    const {runScheduledChainMonitor} = require("../../jobs/monitorCryptoChain");
    const result = await runScheduledChainMonitor();
    expect(result.skipped).toBeUndefined();
    expect(result.deposits.network).toBe("avalanche");
    expect(chainMonitorService.runChainMonitor).toHaveBeenCalledTimes(1);
  });
});
