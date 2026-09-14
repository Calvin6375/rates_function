/**
 * @fileoverview Optional live Fuji checks. Skipped unless RUN_FUJI_INTEGRATION=1
 * and Turnkey + RPC env vars are present. Never required for CI.
 */

const RUN = process.env.RUN_FUJI_INTEGRATION === "1";
const describeFuji = RUN ? describe : describe.skip;

describeFuji("Avalanche Fuji live integration", () => {
  it("reads AVAX and USDC for the treasury test wallet", async () => {
    const evmRpcService = require("../../services/crypto/evm/evmRpcService");
    const balances = await evmRpcService.getOnChainBalances(
        "0x952bBC4952A98a49E112d06DBaAe0FAA37eF080A",
    );
    expect(Number(balances.avax)).toBeGreaterThanOrEqual(0);
    expect(balances.usdc).toBeGreaterThanOrEqual(0);
  });

  it("reports Turnkey configuration when credentials are set", () => {
    const {isTurnkeyConfigured} = require("../../services/crypto/turnkey/turnkeyClient");
    expect(isTurnkeyConfigured()).toBe(true);
  });
});
