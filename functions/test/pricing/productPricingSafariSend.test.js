/**
 * @fileoverview Safari Card + B2B Send product pricing precedence.
 */

jest.mock("../../libs/firestore", () => ({
  collection: jest.fn(),
  serverTimestamp: jest.fn(() => ({_serverTimestamp: true})),
}));
jest.mock("../../services/walletService");
jest.mock("../../services/transactionService", () => ({
  TRANSACTION_TYPES: {b2b_send: "b2b_send"},
  STATUSES: {pending: "pending", completed: "completed"},
  createTransactionRecord: jest.fn().mockResolvedValue({transactionId: "txr_1"}),
}));
jest.mock("../../services/partnerRecipientService");
jest.mock("../../services/partnerService");
jest.mock("../../utils/notifications", () => ({
  NOTIFICATION_TYPES: {B2B_SEND_ADMIN_ALERT: "b2b_send_admin_alert"},
  createNotification: jest.fn(),
  sendPushNotification: jest.fn(),
  resolvePlatformAdminUserIds: jest.fn().mockResolvedValue([]),
}));

const {collection} = require("../../libs/firestore");
const config = require("../../config");
const productPricingService = require("../../services/pricing/productPricingService");
const walletService = require("../../services/walletService");
const {calculatePayoutFee} = require("../../services/safariCard/safariCardPayoutFeeService");
const b2bSendService = require("../../services/b2bSendService");

describe("Safari Card + B2B Send pricing precedence", () => {
  let previousB2b;
  let previousB2c;

  beforeEach(() => {
    jest.clearAllMocks();
    productPricingService.clearCache();
    previousB2b = config.safariCardPayoutFees.mpesaB2b;
    previousB2c = config.safariCardPayoutFees.mpesaB2c;
    config.safariCardPayoutFees.mpesaB2b = 10;
    config.safariCardPayoutFees.mpesaB2c = 10;
  });

  afterEach(() => {
    config.safariCardPayoutFees.mpesaB2b = previousB2b;
    config.safariCardPayoutFees.mpesaB2c = previousB2c;
    productPricingService.clearCache();
  });

  function mockConfig(products) {
    collection.mockImplementation(() => ({
      doc: (id) => ({
        get: jest.fn().mockResolvedValue({
          exists: id === "productPricing",
          data: () => ({products: products || {}}),
        }),
      }),
    }));
  }

  it("Safari Card falls back to env fee when pricing disabled", async () => {
    mockConfig({});
    const result = await calculatePayoutFee({
      userId: "u1",
      payoutType: "MPESA_B2B",
      amount: 1000,
      currency: "KES",
      recipient: {accountType: "TillNumber"},
    });
    expect(result.fee).toBe(10);
    expect(result.feeSource).toBe("env_flat_fee");
  });

  it("Safari Card uses buy_goods pricing for Till", async () => {
    mockConfig({
      buy_goods: {enabled: true, feePercent: 1.5, flatFeeKes: 0},
    });
    const result = await calculatePayoutFee({
      userId: "u1",
      payoutType: "MPESA_B2B",
      amount: 2000,
      currency: "KES",
      recipient: {accountType: "TillNumber"},
    });
    expect(result.fee).toBe(30);
    expect(result.totalDebit).toBe(2030);
    expect(result.feeSource).toBe("product_pricing:buy_goods");
  });

  it("buy_goods pricing does not affect PayBill", async () => {
    mockConfig({
      buy_goods: {enabled: true, feePercent: 1.5, flatFeeKes: 0},
    });
    const result = await calculatePayoutFee({
      userId: "u1",
      payoutType: "MPESA_B2B",
      amount: 2000,
      currency: "KES",
      recipient: {accountType: "PayBill"},
    });
    expect(result.fee).toBe(10);
    expect(result.feeSource).toBe("env_flat_fee");
  });

  it("MPESA_B2C is unaffected by enabled pay products", async () => {
    mockConfig({
      buy_goods: {enabled: true, feePercent: 1.5, flatFeeKes: 0},
      pay_bill: {enabled: true, feePercent: 1.25, flatFeeKes: 10},
    });
    const result = await calculatePayoutFee({
      userId: "u1",
      payoutType: "MPESA_B2C",
      amount: 1000,
      currency: "KES",
    });
    expect(result.fee).toBe(10);
    expect(result.feeSource).toBe("env_flat_fee");
  });

  it("USD_AED keeps corridor flat fee when send_ae enabled", async () => {
    mockConfig({
      send_ae: {enabled: true, feePercent: 2, flatFeeKes: 30},
    });
    walletService.getOrCreatePartnerWallet.mockResolvedValue({
      walletId: "w1",
      balances: {USD: 5250},
    });
    const quote = await b2bSendService.quoteSend({
      partnerId: "partner_1",
      amount: 1000,
      fromCurrency: "USD",
      toCurrency: "AED",
    });
    expect(quote.fees.ourFee).toBe(5);
    expect(String(quote.fees.feeSource)).not.toMatch(/product_pricing/);
  });

  it("KES_AED uses send_ae pricing when enabled", async () => {
    mockConfig({
      send_ae: {enabled: true, feePercent: 2, flatFeeKes: 30},
    });
    walletService.getOrCreatePartnerWallet.mockResolvedValue({
      walletId: "w1",
      balances: {KES: 100000},
    });
    const quote = await b2bSendService.quoteSend({
      partnerId: "partner_1",
      amount: 1000,
      fromCurrency: "KES",
      toCurrency: "AED",
    });
    expect(quote.fees.ourFee).toBe(50);
    expect(quote.fees.feeSource).toBe("product_pricing:send_ae");
    expect(quote.totalDeduction).toBe(1050);
  });

  it("KES_AED keeps corridor 0.5% when send_ae disabled", async () => {
    mockConfig({});
    walletService.getOrCreatePartnerWallet.mockResolvedValue({
      walletId: "w1",
      balances: {KES: 100000},
    });
    const quote = await b2bSendService.quoteSend({
      partnerId: "partner_1",
      amount: 1000,
      fromCurrency: "KES",
      toCurrency: "AED",
    });
    expect(quote.fees.ourFee).toBe(5);
    expect(quote.totalDeduction).toBe(1005);
  });
});
