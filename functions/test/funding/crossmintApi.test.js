/**
 * @fileoverview Staging vs production Crossmint env selection.
 */

const ENV_KEYS = [
  "CROSSMINT_ENVIRONMENT",
  "CROSSMINT_SERVER_API_KEY",
  "CROSSMINT_SERVER_API_KEY_PROD",
  "CROSSMINT_CLIENT_API_KEY",
  "CROSSMINT_CLIENT_API_KEY_PROD",
  "CROSSMINT_TOKEN_LOCATOR",
  "CROSSMINT_TOKEN_LOCATOR_PROD",
  "CROSSMINT_CHAIN",
  "CROSSMINT_CHAIN_PROD",
  "CROSSMINT_BASE_URL",
  "CROSSMINT_BASE_URL_PROD",
  "CROSSMINT_COLLECTION_WALLET",
  "CROSSMINT_COLLECTION_WALLET_PROD",
  "CROSSMINT_USER_LOCATOR",
  "CROSSMINT_USER_LOCATOR_PROD",
  "CROSSMINT_WEBHOOK_SECRET",
  "CROSSMINT_WEBHOOK_SECRET_PROD",
];

describe("crossmintApi environment", () => {
  const previous = {};

  beforeEach(() => {
    ENV_KEYS.forEach((key) => {
      previous[key] = process.env[key];
      delete process.env[key];
    });
    jest.resetModules();
  });

  afterEach(() => {
    ENV_KEYS.forEach((key) => {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    });
    jest.resetModules();
  });

  it("defaults to staging host and sepolia locator", () => {
    const api = require("../../services/funding/providers/crossmintApi");
    expect(api.environment()).toBe("staging");
    expect(api.apiBaseUrl()).toBe("https://staging.crossmint.com/api");
    expect(api.tokenLocator()).toBe("base-sepolia:0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(api.chain()).toBe("base-sepolia");
  });

  it("uses production host, Base USDC locator, and _PROD secrets", () => {
    process.env.CROSSMINT_ENVIRONMENT = "production";
    process.env.CROSSMINT_SERVER_API_KEY_PROD = "sk_production_testkey";
    process.env.CROSSMINT_CLIENT_API_KEY_PROD = "ck_production_testkey";
    process.env.CROSSMINT_COLLECTION_WALLET_PROD = "0xProdWallet";
    process.env.CROSSMINT_USER_LOCATOR_PROD = "email:ops@truepay.africa";
    process.env.CROSSMINT_WEBHOOK_SECRET_PROD = "whsec_prod";
    const api = require("../../services/funding/providers/crossmintApi");
    expect(api.environment()).toBe("production");
    expect(api.apiBaseUrl()).toBe("https://www.crossmint.com/api");
    expect(api.tokenLocator()).toBe("base:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(api.chain()).toBe("base");
    expect(api.collectionWallet()).toBe("0xProdWallet");
    expect(api.webhookSecret()).toBe("whsec_prod");
    expect(api.buildEmbeddedCheckoutUrl({
      orderId: "ord_1",
      clientSecret: "cs_1",
    })).toMatch(/^https:\/\/www\.crossmint\.com\/sdk\/2024-03-05\/embedded-checkout\?/);
  });

  it("rejects a staging locator and staging client key in production", () => {
    process.env.CROSSMINT_ENVIRONMENT = "production";
    process.env.CROSSMINT_TOKEN_LOCATOR_PROD =
      "base-sepolia:0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    process.env.CROSSMINT_CLIENT_API_KEY_PROD = "ck_staging_notallowed";
    const api = require("../../services/funding/providers/crossmintApi");
    expect(() => api.tokenLocator()).toThrow(/not valid for this environment/);
    expect(() => api.buildEmbeddedCheckoutUrl({
      orderId: "ord_1",
      clientSecret: "cs_1",
    })).toThrow(/ck_production_/);
  });

  it("does not read staging secrets while production is selected", () => {
    process.env.CROSSMINT_ENVIRONMENT = "production";
    process.env.CROSSMINT_COLLECTION_WALLET = "0xStagingWallet";
    const api = require("../../services/funding/providers/crossmintApi");
    expect(() => api.collectionWallet()).toThrow(/CROSSMINT_COLLECTION_WALLET_PROD/);
  });
});
