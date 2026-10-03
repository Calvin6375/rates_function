/**
 * @fileoverview PayLio checkout, fee pass-through, and payment-status mapping.
 */

jest.mock("axios");
jest.mock("../../services/funding/fundingOrderService", () => ({
  getFundingOrder: jest.fn(),
  updateFundingOrder: jest.fn(),
}));

const axios = require("axios");
const paylioProvider = require("../../services/funding/providers/paylioProvider");
const fundingOrderService = require("../../services/funding/fundingOrderService");
const { registerFundingProviders } = require("../../services/funding/fundingProviderInterface");

const WALLET = "0x1111111111111111111111111111111111111111";

function checkoutResponse() {
  return {
    data: {
      checkout_url: "https://paylio.org/pay/clx_pay_1",
      ipn_token: "ipn_token_1",
      payment_id: "clx_pay_1",
      amount: "53.18",
      original_amount: "49.99",
      customer_fee_amount: "3.19",
      pass_fee_to_customer: true,
      fee_percent: 5,
      status: "unpaid",
    },
  };
}

describe("paylioProvider", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.PAYLIO_API_KEY = "plio_test_key";
    process.env.PAYLIO_POLYGON_WALLET = WALLET;
    process.env.PAYLIO_CALLBACK_BASE_URL = "https://example.com/handlePaylioWebhook";
  });

  afterEach(() => {
    delete process.env.PAYLIO_API_KEY;
    delete process.env.PAYLIO_POLYGON_WALLET;
    delete process.env.PAYLIO_CALLBACK_BASE_URL;
  });

  it("implements the Funding Provider interface", () => {
    expect(() => registerFundingProviders({ paylio: paylioProvider })).not.toThrow();
    expect(paylioProvider.providerId).toBe("paylio");
  });

  it("creates a USD checkout and passes the fee to the customer", async () => {
    axios.post.mockResolvedValue(checkoutResponse());

    const result = await paylioProvider.initializePayment({
      amount: 49.99,
      currency: "USD",
      email: "tourist@example.com",
      fundingOrderId: "fund_pl_1",
      userId: "user_1",
      correlationId: "corr_1",
    });

    expect(result.checkoutUrl).toBe("https://paylio.org/pay/clx_pay_1");
    expect(result.providerReference).toBe("ipn_token_1");
    expect(result.providerTransactionId).toBe("clx_pay_1");
    expect(result.raw).toMatchObject({
      requestedAmount: 49.99,
      providerFee: 3.19,
      customerPayAmount: 53.18,
      netSettlementAmount: null,
      feePercent: 5,
      passFeeToCustomer: true,
    });

    const [url, body, options] = axios.post.mock.calls[0];
    expect(url).toBe("https://paylio.org/api/v1/wallet");
    expect(body).toMatchObject({
      address: WALLET,
      amount: "49.99",
      currency: "USD",
      passFeeToCustomer: true,
      note: "fundingOrderId=fund_pl_1",
      email: "tourist@example.com",
    });
    expect(body.callback).toContain("fundingOrderId=fund_pl_1");
    expect(options.headers.Authorization).toBe("Bearer plio_test_key");
    expect(JSON.stringify(body)).not.toContain("plio_test_key");
  });

  it("rejects KES checkout", async () => {
    await expect(paylioProvider.initializePayment({
      amount: 100,
      currency: "KES",
      fundingOrderId: "fund_pl_1",
    })).rejects.toThrow("PayLio funding supports USD, EUR, INR, CAD only");
    expect(axios.post).not.toHaveBeenCalled();
  });

  it("surfaces a PayLio API failure without the API key", async () => {
    axios.post.mockRejectedValue({
      message: "Request failed",
      response: { status: 400, data: { error: "Invalid wallet", code: "bad_wallet" } },
    });

    await expect(paylioProvider.initializePayment({
      amount: 10,
      currency: "USD",
      fundingOrderId: "fund_pl_1",
    })).rejects.toThrow("PayLio 400: Invalid wallet");
  });

  it("treats paid plus completed forwarding as success and keeps the customer charge amount", async () => {
    axios.get.mockResolvedValue({
      data: {
        status: "paid",
        forward_status: "completed",
        amount: "53.18",
        original_amount: "49.99",
        customer_fee_amount: "3.19",
        forwarded_amount: "49.40",
        currency: "USD",
        payment_id: "clx_pay_1",
        coin: "polygon_usdc",
        txid_out: "0xabc",
      },
    });

    const verified = await paylioProvider.verifyPayment("ipn_token_1");
    expect(verified).toMatchObject({
      providerReference: "ipn_token_1",
      providerTransactionId: "clx_pay_1",
      amount: 53.18,
      requestedAmount: 49.99,
      providerFee: 3.19,
      customerPayAmount: 53.18,
      netSettlementAmount: 49.4,
      currency: "USD",
      status: "success",
    });
    expect(fundingOrderService.updateFundingOrder).not.toHaveBeenCalled();
    const [url, options] = axios.get.mock.calls[0];
    expect(url).toBe("https://paylio.org/api/v1/payment-status");
    expect(options.params).toEqual({ ipn_token: "ipn_token_1" });
    expect(options.headers.Authorization).toBe("Bearer plio_test_key");
  });

  it("does not succeed when the payment is paid but USDC forwarding is still processing", async () => {
    axios.get.mockResolvedValue({
      data: {
        status: "paid",
        forward_status: "processing",
        amount: "53.18",
        original_amount: "49.99",
        currency: "USD",
      },
    });

    await expect(paylioProvider.verifyPayment("ipn_token_1")).resolves.toMatchObject({
      status: "pending",
      amount: 53.18,
    });
  });

  it("maps unpaid to pending and canceled to failed", async () => {
    axios.get.mockResolvedValueOnce({ data: { status: "unpaid", amount: "53.18", currency: "USD" } });
    await expect(paylioProvider.verifyPayment("ipn_token_1")).resolves.toMatchObject({ status: "pending" });

    axios.get.mockResolvedValueOnce({
      data: { status: "canceled", forward_status: "pending", amount: "53.18", currency: "USD" },
    });
    await expect(paylioProvider.verifyPayment("ipn_token_1")).resolves.toMatchObject({
      status: "failed",
      failureReason: "Payment canceled",
    });
  });

  it("rejects a callback that has no ipn_token", () => {
    expect(paylioProvider.verifyWebhookSignature({ query: {} }, "")).toBe(false);
    expect(paylioProvider.verifyWebhookSignature({ query: { ipn_token: "ipn_token_1", status: "paid" } }, "")).toBe(true);
    expect(paylioProvider.normalizeWebhook({ ipn_token: "ipn_token_1", status: "paid", amount: "53.18" })).toMatchObject({
      providerReference: "ipn_token_1",
      status: "success",
    });
    expect(paylioProvider.normalizeWebhook({ status: "paid" })).toBeNull();
  });
});
