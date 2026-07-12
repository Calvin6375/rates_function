/**
 * @fileoverview Unit tests for Transak diagnostics helpers.
 */

jest.mock("axios");

const axios = require("axios");
const {
  PartnerConfigurationError,
  PARTNER_CONFIGURATION_MESSAGE,
  validateQuoteRequest,
  isPartnerConfigurationMessage,
  maskHeaders,
  wrapTransakHttpError,
  buildSupportReport,
  transakHttpRequest,
  getConfigSnapshot,
  isDebugEnabled,
} = require("../../services/funding/providers/transakDiagnostics");

describe("transakDiagnostics", () => {
  const getters = {
    getApiKey: () => "pk_test_api_key_123",
    getSecretKey: () => "secret_key",
    getWebhookSecret: () => "webhook_secret",
    getEnvironment: () => "staging",
    getPublicApiBaseUrl: () => "https://api-stg.transak.com",
    getGatewayApiBaseUrl: () => "https://api-gateway-stg.transak.com",
    getDefaultFiat: () => "USD",
    getDefaultCrypto: () => "USDT",
    getDefaultNetwork: () => "tron",
    getTreasuryWallet: () => "TGkPQsmAhRVh51bEj961EUavP3BjZqEnBb",
    isHeadlessEnabled: () => true,
    getIntegrationMode: () => "Headless",
    isConfigured: () => true,
    API_PATHS: {
      GET_PRICE: "/api/v1/pricing/public/quotes",
      CREATE_WIDGET_SESSION: "/api/v2/auth/session",
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.TRANSAK_DEBUG;
  });

  it("masks authorization headers", () => {
    const masked = maskHeaders({
      authorization: "Bearer secret",
      "access-token": "partner_token",
      "x-api-key": "pk_test",
      accept: "application/json",
    });

    expect(masked.authorization).toBe("***");
    expect(masked["access-token"]).toBe("***");
    expect(masked["x-api-key"]).toBe("***");
    expect(masked.accept).toBe("application/json");
  });

  it("validates required quote fields locally", () => {
    expect(() => validateQuoteRequest({
      partnerApiKey: "pk_test",
      fiatCurrency: "USD",
      cryptoCurrency: "USDT",
      network: "tron",
      fiatAmount: 10,
    })).not.toThrow();

    expect(() => validateQuoteRequest({
      fiatCurrency: "USD",
      cryptoCurrency: "USDT",
      network: "tron",
      fiatAmount: 10,
    })).toThrow("missing: partnerApiKey");

    expect(() => validateQuoteRequest({
      partnerApiKey: "pk_test",
      fiatCurrency: "USD",
      cryptoCurrency: "USDT",
      network: "tron",
      fiatAmount: 0,
    })).toThrow("fiatAmount must be a positive number");
  });

  it("detects partner account limitation messages", () => {
    const message = "There are some limitation in your partner account, Please contact us at support@transak.com.";
    expect(isPartnerConfigurationMessage(message)).toBe(true);
    expect(isPartnerConfigurationMessage("Partner not enabled")).toBe(true);
    expect(isPartnerConfigurationMessage("Unauthorized partner")).toBe(true);
    expect(isPartnerConfigurationMessage("Invalid amount")).toBe(false);
  });

  it("wraps partner limitation responses as PartnerConfigurationError", () => {
    const err = {
      message: "Request failed with status code 400",
      response: {
        status: 400,
        headers: { "x-request-id": "req_123" },
        data: {
          message: "There are some limitation in your partner account, Please contact us at support@transak.com.",
        },
      },
      config: {
        method: "get",
        url: "https://api-stg.transak.com/api/v1/pricing/public/quotes",
        params: {
          partnerApiKey: "pk_test_secret_key",
          fiatCurrency: "USD",
          cryptoCurrency: "USDT",
          network: "tron",
          fiatAmount: 10,
        },
        headers: { "x-api-key": "pk_test_secret_key" },
      },
    };

    const wrapped = wrapTransakHttpError(err, {
      correlationId: "corr_1",
      executionTimeMs: 42,
      configSnapshot: getConfigSnapshot(getters),
    });

    expect(wrapped).toBeInstanceOf(PartnerConfigurationError);
    expect(wrapped.message).toBe(PARTNER_CONFIGURATION_MESSAGE);
    expect(wrapped.details.statusCode).toBe(400);
    expect(wrapped.details.correlationId).toBe("corr_1");
    expect(wrapped.details.executionTimeMs).toBe(42);
    expect(wrapped.details.requestParams).toMatchObject({
      partnerApiKey: "pk_tes...",
      fiatCurrency: "USD",
      cryptoCurrency: "USDT",
      network: "tron",
      fiatAmount: 10,
    });
    expect(wrapped.details.requestHeaders["x-api-key"]).toBe("***");
  });

  it("includes request payload in support report", () => {
    const report = buildSupportReport(
        { correlationId: "corr_99", configSnapshot: getConfigSnapshot(getters) },
        {
          httpMethod: "GET",
          url: "https://api-stg.transak.com/api/v1/pricing/public/quotes",
          requestParams: {
            partnerApiKey: "pk_tes...",
            fiatCurrency: "USD",
            fiatAmount: 10,
          },
          statusCode: 400,
          responseBody: { message: "Partner not enabled" },
          executionTimeMs: 120,
          timestamp: "2026-07-10T18:00:00.000Z",
        },
    );

    expect(report).toContain("=== Transak Diagnostics ===");
    expect(report).toContain("Environment: staging");
    expect(report).toContain("Request params:");
    expect(report).toContain("\"fiatCurrency\":\"USD\"");
    expect(report).toContain("\"fiatAmount\":10");
    expect(report).toContain("HTTP status: 400");
    expect(report).toContain("Correlation ID: corr_99");
    expect(report).not.toContain("secret_key");
  });

  it("logs outgoing requests only when TRANSAK_DEBUG is enabled", async () => {
    axios.mockResolvedValue({ status: 200, data: { ok: true } });

    process.env.TRANSAK_DEBUG = "false";
    expect(isDebugEnabled()).toBe(false);
    await transakHttpRequest({
      method: "get",
      url: "https://api-stg.transak.com/api/v1/pricing/public/quotes",
      params: { partnerApiKey: "pk_test" },
      headers: { authorization: "Bearer secret" },
    });

    process.env.TRANSAK_DEBUG = "true";
    expect(isDebugEnabled()).toBe(true);
    await transakHttpRequest({
      method: "get",
      url: "https://api-stg.transak.com/api/v1/pricing/public/quotes",
      params: { partnerApiKey: "pk_test" },
      headers: { authorization: "Bearer secret" },
    });

    expect(axios).toHaveBeenCalledTimes(2);
  });
});
