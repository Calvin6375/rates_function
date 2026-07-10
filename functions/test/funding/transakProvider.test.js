/**
 * @fileoverview Unit tests for Transak Funding Provider adapter.
 */

jest.mock("axios");

const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const transakProvider = require("../../services/funding/providers/transakProvider");
const { registerFundingProviders } = require("../../services/funding/fundingProviderInterface");
const config = require("../../config");

describe("transakProvider", () => {
  const webhookSecret = "transak_partner_access_token";

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TRANSAK_API_KEY = "test_api_key";
    process.env.TRANSAK_SECRET_KEY = webhookSecret;
    process.env.TRANSAK_WEBHOOK_SECRET = webhookSecret;
    process.env.TRANSAK_TREASURY_WALLET = "0xTreasuryWallet";
    process.env.TRANSAK_ENVIRONMENT = "staging";
    config.transak.treasuryWallet = "0xTreasuryWallet";
  });

  afterEach(() => {
    delete process.env.TRANSAK_API_KEY;
    delete process.env.TRANSAK_SECRET_KEY;
    delete process.env.TRANSAK_WEBHOOK_SECRET;
    delete process.env.TRANSAK_TREASURY_WALLET;
    delete process.env.TRANSAK_ENVIRONMENT;
    config.transak.treasuryWallet = null;
  });

  it("implements the Funding Provider interface", () => {
    expect(() => registerFundingProviders({ transak: transakProvider })).not.toThrow();
    expect(transakProvider.providerId).toBe("transak");
  });

  it("initializes funding with quote + widget session and treasury wallet", async () => {
    axios.get.mockResolvedValue({
      data: {
        data: {
          quoteId: "quote_123",
          cryptoAmount: 24.5,
          fiatCurrency: "USD",
          cryptoCurrency: "USDT",
        },
      },
    });
    axios.post.mockResolvedValue({
      data: {
        data: {
          widgetUrl: "https://global-stg.transak.com?sessionId=abc",
        },
      },
    });

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
    expect(result.raw.treasuryWallet).toBe("0xTreasuryWallet");

    const [quoteUrl, quoteOptions] = axios.get.mock.calls[0];
    expect(quoteUrl).toContain("/api/v2/lookup/quote");
    expect(quoteOptions.params.partnerOrderId).toBe("fund_123");
    expect(quoteOptions.params.fiatAmount).toBe(25);

    const [sessionUrl, sessionBody, sessionOptions] = axios.post.mock.calls[0];
    expect(sessionUrl).toContain("/api/v2/auth/session");
    expect(sessionBody.widgetParams.walletAddress).toBe("0xTreasuryWallet");
    expect(sessionBody.widgetParams.partnerOrderId).toBe("fund_123");
    expect(sessionBody.widgetParams.paymentMethod).toBe("credit_debit_card");
    expect(sessionOptions.headers["x-api-key"]).toBe("test_api_key");
  });

  it("throws when treasury wallet is not configured", async () => {
    delete process.env.TRANSAK_TREASURY_WALLET;
    config.transak.treasuryWallet = null;

    await expect(transakProvider.initializePayment({
      amount: 10,
      providerReference: "fund_missing_wallet",
    })).rejects.toThrow("TRANSAK_TREASURY_WALLET");
  });

  it("verifies successful funding by partnerOrderId", async () => {
    axios.get.mockResolvedValue({
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

    const [url, options] = axios.get.mock.calls[0];
    expect(url).toContain("/orders");
    expect(options.params["filter[partnerOrderId]"]).toBe("fund_123");
  });

  it("getFundingStatus aliases verifyPayment", async () => {
    axios.get.mockResolvedValue({
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
    const token = jwt.sign({ webhookData: order }, webhookSecret);
    const event = transakProvider.normalizeWebhook({ eventID: "ORDER_COMPLETED", data: token });

    expect(event).toEqual({
      providerReference: "fund_abc",
      providerTransactionId: "order_42",
      amount: 50,
      currency: "USD",
      status: "success",
      failureReason: null,
    });
  });

  it("returns null for unsupported webhook events", () => {
    expect(transakProvider.normalizeWebhook({ eventID: "UNKNOWN" })).toBeNull();
  });

  it("verifies webhook JWT signature", () => {
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

  it("normalizes failed order statuses", () => {
    const event = transakProvider.normalizeTransakOrder({
      id: "order_fail",
      partnerOrderId: "fund_fail",
      fiatAmount: 20,
      fiatCurrency: "USD",
      status: "FAILED",
      statusReason: "Card declined",
    });

    expect(event.status).toBe("failed");
    expect(event.failureReason).toBe("Card declined");
  });
});
