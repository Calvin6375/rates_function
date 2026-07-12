/**
 * @fileoverview Unit tests for Transak Funding Provider adapter.
 */

jest.mock("axios");

const jwt = require("jsonwebtoken");
const axios = require("axios");
const transakProvider = require("../../services/funding/providers/transakProvider");
const { PartnerConfigurationError } = require("../../services/funding/providers/transakDiagnostics");
const { registerFundingProviders } = require("../../services/funding/fundingProviderInterface");
const config = require("../../config");

describe("transakProvider", () => {
  const webhookSecret = "transak_partner_access_token";

  /**
   * transakHttpRequest calls axios(config) directly.
   * @param {...Object} responses
   */
  function mockAxiosResponses(...responses) {
    for (const response of responses) {
      if (response?.response) {
        axios.mockRejectedValueOnce(response);
      } else {
        axios.mockResolvedValueOnce(response);
      }
    }
  }

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TRANSAK_API_KEY = "test_api_key";
    process.env.TRANSAK_SECRET_KEY = webhookSecret;
    process.env.TRANSAK_WEBHOOK_SECRET = webhookSecret;
    process.env.TRANSAK_TREASURY_WALLET = "TGkPQsmAhRVh51bEj961EUavP3BjZqEnBb";
    process.env.TRANSAK_ENVIRONMENT = "staging";
    process.env.TRANSAK_DEFAULT_NETWORK = "tron";
    config.transak.treasuryWallet = "TGkPQsmAhRVh51bEj961EUavP3BjZqEnBb";
  });

  afterEach(() => {
    delete process.env.TRANSAK_API_KEY;
    delete process.env.TRANSAK_SECRET_KEY;
    delete process.env.TRANSAK_WEBHOOK_SECRET;
    delete process.env.TRANSAK_TREASURY_WALLET;
    delete process.env.TRANSAK_ENVIRONMENT;
    delete process.env.TRANSAK_DEFAULT_NETWORK;
    config.transak.treasuryWallet = null;
  });

  it("implements the Funding Provider interface", () => {
    expect(() => registerFundingProviders({ transak: transakProvider })).not.toThrow();
    expect(transakProvider.providerId).toBe("transak");
  });

  it("uses official Get Price + Create Widget URL APIs", async () => {
    mockAxiosResponses(
        {
          data: {
            response: {
              quoteId: "quote_123",
              cryptoAmount: 24.5,
              fiatCurrency: "USD",
              cryptoCurrency: "USDT",
              network: "tron",
            },
          },
        },
        {
          data: {
            data: {
              widgetUrl: "https://global-stg.transak.com?sessionId=abc",
            },
          },
        },
    );

    const result = await transakProvider.initializePayment({
      amount: 25,
      currency: "USD",
      email: "tourist@example.com",
      providerReference: "fund_123",
      fundingOrderId: "fund_123",
      userId: "user_1",
      correlationId: "corr_1",
      metadata: { product: "tourist" },
    });

    expect(result.checkoutUrl).toBe("https://global-stg.transak.com?sessionId=abc");
    expect(result.providerReference).toBe("fund_123");
    expect(result.providerTransactionId).toBe("quote_123");
    expect(result.raw.treasuryWallet).toBe("TGkPQsmAhRVh51bEj961EUavP3BjZqEnBb");

    const [quoteConfig] = axios.mock.calls[0];
    expect(quoteConfig.url).toBe("https://api-stg.transak.com/api/v1/pricing/public/quotes");
    expect(quoteConfig.method).toBe("get");
    expect(quoteConfig.params).toMatchObject({
      partnerApiKey: "test_api_key",
      fiatCurrency: "USD",
      cryptoCurrency: "USDT",
      network: "tron",
      isBuyOrSell: "BUY",
      fiatAmount: 25,
      paymentMethod: "credit_debit_card",
      walletAddress: "TGkPQsmAhRVh51bEj961EUavP3BjZqEnBb",
    });
    expect(quoteConfig.headers["x-api-key"]).toBe("test_api_key");

    const [sessionConfig] = axios.mock.calls[1];
    expect(sessionConfig.url).toBe("https://api-gateway-stg.transak.com/api/v2/auth/session");
    expect(sessionConfig.method).toBe("post");
    expect(sessionConfig.data.widgetParams.walletAddress).toBe("TGkPQsmAhRVh51bEj961EUavP3BjZqEnBb");
    expect(sessionConfig.data.widgetParams.partnerOrderId).toBe("fund_123");
    expect(sessionConfig.data.widgetParams.paymentMethod).toBe("credit_debit_card");
    expect(sessionConfig.headers["x-api-key"]).toBe("test_api_key");
    expect(sessionConfig.headers["access-token"]).toBe(webhookSecret);
    expect(sessionConfig.headers["x-user-ip"]).toBeTruthy();
  });

  it("throws when treasury wallet is not configured", async () => {
    delete process.env.TRANSAK_TREASURY_WALLET;
    config.transak.treasuryWallet = null;

    await expect(transakProvider.initializePayment({
      amount: 10,
      providerReference: "fund_no_split",
    })).rejects.toThrow("TRANSAK_TREASURY_WALLET");
  });

  it("verifies successful funding via official Get Orders API", async () => {
    mockAxiosResponses({
      data: {
        data: [{
          id: "order_999",
          partnerOrderId: "fund_123",
          fiatAmount: 25,
          fiatCurrency: "USD",
          status: "COMPLETED",
        }],
      },
    });

    const event = await transakProvider.verifyPayment("fund_123", {
      correlationId: "corr_1",
      fundingOrderId: "fund_123",
    });

    expect(event).toEqual({
      providerReference: "fund_123",
      providerTransactionId: "order_999",
      amount: 25,
      currency: "USD",
      status: "success",
      failureReason: null,
    });

    const [ordersConfig] = axios.mock.calls[0];
    expect(ordersConfig.url).toBe("https://api-stg.transak.com/partners/api/v2/orders");
    expect(ordersConfig.params["filter[partnerOrderId]"]).toBe("fund_123");
    expect(ordersConfig.headers["access-token"]).toBe(webhookSecret);
  });

  it("falls back to Get Order By ID when partnerOrderId lookup is empty", async () => {
    mockAxiosResponses(
        { data: { data: [] } },
        {
          data: {
            data: {
              id: "order_888",
              partnerOrderId: "fund_abc",
              fiatAmount: 10,
              fiatCurrency: "USD",
              status: "COMPLETED",
            },
          },
        },
    );

    const event = await transakProvider.verifyPayment("fund_abc", {
      transakOrderId: "order_888",
    });

    expect(event.providerTransactionId).toBe("order_888");
    expect(axios.mock.calls[1][0].url).toBe(
        "https://api-stg.transak.com/partners/api/v2/order/order_888",
    );
  });

  it("getFundingStatus aliases verifyPayment", async () => {
    mockAxiosResponses({
      data: {
        data: [{
          id: "order_1",
          partnerOrderId: "fund_abc",
          fiatAmount: 10,
          fiatCurrency: "USD",
          status: "AWAITING_PAYMENT_FROM_USER",
        }],
      },
    });

    const event = await transakProvider.getFundingStatus("fund_abc");
    expect(event.status).toBe("pending");
  });

  it("normalizes completed webhook payload from signed JWT", () => {
    const order = {
      id: "order_42",
      partnerOrderId: "fund_abc",
      fiatAmount: 50,
      fiatCurrency: "USD",
      status: "COMPLETED",
    };
    const token = jwt.sign({ eventID: "ORDER_COMPLETED", webhookData: order }, webhookSecret);
    const event = transakProvider.normalizeWebhook({ data: token });

    expect(event).toEqual({
      providerReference: "fund_abc",
      providerTransactionId: "order_42",
      amount: 50,
      currency: "USD",
      status: "success",
      failureReason: null,
    });
  });

  it("normalizes failed webhook events", () => {
    const order = {
      id: "order_fail",
      partnerOrderId: "fund_fail",
      fiatAmount: 20,
      fiatCurrency: "USD",
      status: "FAILED",
      statusReason: "Card declined",
    };
    const token = jwt.sign({ eventID: "ORDER_FAILED", webhookData: order }, webhookSecret);
    const event = transakProvider.normalizeWebhook({ data: token });

    expect(event.status).toBe("failed");
    expect(event.failureReason).toBe("Card declined");
  });

  it("returns null for unsupported webhook events", () => {
    expect(transakProvider.normalizeWebhook({ eventID: "UNKNOWN_EVENT" })).toBeNull();
  });

  it("verifies webhook JWT signature with Partner Access Token", () => {
    const token = jwt.sign({ webhookData: { partnerOrderId: "fund_1", status: "COMPLETED" } }, webhookSecret);
    const body = JSON.stringify({ eventID: "ORDER_COMPLETED", data: token });
    const req = { get: () => null };

    expect(transakProvider.verifyWebhookSignature(req, Buffer.from(body))).toBe(true);
  });

  it("rejects invalid webhook signature (replay attack)", () => {
    const token = jwt.sign({ webhookData: { partnerOrderId: "fund_1" } }, "wrong_secret");
    const body = JSON.stringify({ eventID: "ORDER_COMPLETED", data: token });
    const req = { get: () => null };

    expect(transakProvider.verifyWebhookSignature(req, Buffer.from(body))).toBe(false);
  });

  it("logs HTTP details on quote failure", async () => {
    mockAxiosResponses({
      message: "Request failed with status code 404",
      response: {
        status: 404,
        headers: { "x-request-id": "req_404" },
        data: { error: { message: "Not found", errorCode: 6005 } },
      },
      config: {
        method: "get",
        url: "https://api-stg.transak.com/api/v1/pricing/public/quotes",
      },
    });

    await expect(transakProvider.initializePayment({
      amount: 10,
      providerReference: "fund_fail",
    })).rejects.toThrow("Transak 404");
  });

  it("throws PartnerConfigurationError for partner account limitations", async () => {
    mockAxiosResponses({
      message: "Request failed with status code 400",
      response: {
        status: 400,
        headers: { "x-request-id": "req_400" },
        data: {
          message: "There are some limitation in your partner account, Please contact us at support@transak.com.",
        },
      },
      config: {
        method: "get",
        url: "https://api-stg.transak.com/api/v1/pricing/public/quotes",
      },
    });

    await expect(transakProvider.initializePayment({
      amount: 10,
      providerReference: "fund_partner_limit",
      correlationId: "corr_partner",
    })).rejects.toBeInstanceOf(PartnerConfigurationError);
  });

  it("exposes health status without secrets", () => {
    const health = transakProvider.getHealthStatus();

    expect(health).toMatchObject({
      configured: true,
      environment: "staging",
      baseUrl: "https://api-stg.transak.com",
      apiKeyPresent: true,
      secretPresent: true,
      treasuryWalletPresent: true,
      quoteEndpoint: "/api/v1/pricing/public/quotes",
      mode: "Headless",
    });
    expect(JSON.stringify(health)).not.toContain(webhookSecret);
    expect(JSON.stringify(health)).not.toContain("test_api_key");
  });
});
