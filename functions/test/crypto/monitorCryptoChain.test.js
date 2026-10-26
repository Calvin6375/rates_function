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
    const result = await runScheduledChainMonitor({
      address: "0xabc",
      network: "avalanche",
    });
    expect(result.skipped).toBeUndefined();
    expect(result.deposits.network).toBe("avalanche");
    expect(chainMonitorService.runChainMonitor).toHaveBeenCalledWith({
      address: "0xabc",
      network: "avalanche",
    });
  });
});

describe("topup monitor window", () => {
  it("queues a scan at 5 minutes and another at 10 minutes", async () => {
    jest.resetModules();
    const {enqueueTopupMonitorRuns, FIRST_RUN_SECONDS, SECOND_RUN_SECONDS} =
      require("../../jobs/monitorCryptoChain");
    const queued = [];
    const result = await enqueueTopupMonitorRuns(
        {address: "0xabc", network: "avalanche", intentId: "intent_1"},
        {
          enqueue: async (payload, options) => {
            queued.push({payload, options});
          },
        },
    );
    expect(queued.map((row) => row.options.scheduleDelaySeconds)).toEqual([
      FIRST_RUN_SECONDS,
      SECOND_RUN_SECONDS,
    ]);
    expect(queued[0].payload.address).toBe("0xabc");
    expect(queued[1].options.id).toBe("intent_1_10m");
    expect(result.stopped).toBe(true);
    expect(result.queued).toHaveLength(2);
  });

  it("ignores an intent that is already pending", async () => {
    jest.resetModules();
    const {pendingTopupIntent} = require("../../jobs/monitorCryptoChain");
    const event = {
      params: {intentId: "intent_1"},
      data: {
        before: {exists: true, data: () => ({status: "pending"})},
        after: {exists: true, data: () => ({status: "pending", depositAddress: "0xabc"})},
      },
    };
    expect(pendingTopupIntent(event)).toBeNull();
  });
});
