/**
 * @fileoverview Fuji recon must not auto-adjust the ledger unless explicitly enabled.
 */

const {
  isReconcileAutoAdjustEnabled,
} = require("../../services/crypto/reconcileCryptoLedgerService");

describe("CRYPTO_RECONCILE_AUTO_ADJUST", () => {
  const original = process.env.CRYPTO_RECONCILE_AUTO_ADJUST;

  afterEach(() => {
    if (original == null) {
      delete process.env.CRYPTO_RECONCILE_AUTO_ADJUST;
    } else {
      process.env.CRYPTO_RECONCILE_AUTO_ADJUST = original;
    }
  });

  it("defaults to false for Fuji/test safety", () => {
    delete process.env.CRYPTO_RECONCILE_AUTO_ADJUST;
    expect(isReconcileAutoAdjustEnabled()).toBe(false);
  });

  it("can be enabled explicitly", () => {
    process.env.CRYPTO_RECONCILE_AUTO_ADJUST = "true";
    expect(isReconcileAutoAdjustEnabled()).toBe(true);
  });
});
