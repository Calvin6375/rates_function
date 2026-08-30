/**
 * @fileoverview Supported currencies derived from customerRates book.
 */

const {
  buildSupportedCurrenciesPayload,
  setSupportedCountries,
  SET_DEPRECATED_MESSAGE,
} = require("../services/supportedCountriesService");

describe("buildSupportedCurrenciesPayload", () => {
  it("lists canonical currency keys from the rates book", () => {
    const payload = buildSupportedCurrenciesPayload({
      rateVersion: 12,
      rates: {
        ETB: {buyRate: 1.4415, sellRate: 1.4327},
        USDC: {buyRate: 129.5, sellRate: 128.15},
        KES: {buyRate: 1, sellRate: 1},
      },
      updatedAt: "2026-08-30T00:00:00.000Z",
    });

    expect(payload.success).toBe(true);
    expect(payload.source).toBe("customerRates");
    expect(payload.rateVersion).toBe(12);
    expect(payload.currencies).toEqual(["ETB", "KES", "USDC"]);
    expect(payload.countries).toEqual(payload.currencies);
    expect(payload.isDefault).toBe(false);
    expect(payload.updatedAt).toBe("2026-08-30T00:00:00.000Z");
  });

  it("reads legacy USDT/ETB keys as currency ETB (KES always present)", () => {
    const payload = buildSupportedCurrenciesPayload({
      rates: {
        "USDT/ETB": {buyRate: 1.4415, sellRate: 1.4327},
        "USDT/USD": {buyRate: 130, sellRate: 129},
      },
    });

    expect(payload.currencies).toEqual(["ETB", "KES", "USD"]);
    expect(payload.countries).toEqual(["ETB", "KES", "USD"]);
  });

  it("marks isDefault when no rates stored (still includes numeraire KES)", () => {
    const payload = buildSupportedCurrenciesPayload(null);
    expect(payload.currencies).toEqual(["KES"]);
    expect(payload.countries).toEqual(["KES"]);
    expect(payload.isDefault).toBe(true);
    expect(payload.rateVersion).toBeNull();
  });
});

describe("setSupportedCountries", () => {
  it("rejects writes and points admins at PUT /api/config/fees", async () => {
    await expect(setSupportedCountries("admin-uid", ["ETH"], {replace: false}))
        .rejects.toMatchObject({
          message: SET_DEPRECATED_MESSAGE,
          code: "failed-precondition",
          deprecated: true,
        });
  });
});
