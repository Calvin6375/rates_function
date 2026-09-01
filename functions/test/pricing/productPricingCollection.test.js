/**
 * @fileoverview Collection (payment link / checkout) product pricing precedence.
 */

const mockUpdatePartnerWalletBalance = jest.fn();
const mockCreateTransactionRecord = jest.fn();
const mockPaymentUpdate = jest.fn();

jest.mock("../../libs/firestore", () => ({
  collection: jest.fn(),
  serverTimestamp: jest.fn(() => ({_serverTimestamp: true})),
}));

jest.mock("../../admin", () => {
  const firestoreFn = jest.fn(() => ({
    collection: (name) => {
      if (name === "payments") {
        return {
          doc: () => ({
            get: jest.fn().mockResolvedValue({exists: false}),
            set: jest.fn().mockResolvedValue(undefined),
            update: mockPaymentUpdate,
          }),
        };
      }
      return {
        doc: () => ({
          get: jest.fn().mockResolvedValue({exists: false}),
          set: jest.fn().mockResolvedValue(undefined),
          update: jest.fn().mockResolvedValue(undefined),
        }),
      };
    },
  }));
  firestoreFn.FieldValue = {
    serverTimestamp: jest.fn(() => ({_serverTimestamp: true})),
    increment: jest.fn((n) => ({_increment: n})),
  };
  return {firestore: firestoreFn};
});

jest.mock("../../services/walletService", () => ({
  getOrCreatePartnerWallet: jest.fn().mockResolvedValue({walletId: "w1"}),
  updatePartnerWalletBalance: (...args) => mockUpdatePartnerWalletBalance(...args),
}));

jest.mock("../../services/transactionService", () => ({
  TRANSACTION_TYPES: {b2b_payment: "b2b_payment"},
  STATUSES: {completed: "completed"},
  createTransactionRecord: (...args) => mockCreateTransactionRecord(...args),
}));

jest.mock("../../libs/idempotency", () => ({
  executeWithIdempotency: jest.fn((_key, fn) => fn()),
}));

const {collection} = require("../../libs/firestore");
const productPricingService = require("../../services/pricing/productPricingService");
const {processB2bPaymentWebhook} = require("../../libs/b2bPayments");

describe("collection webhook pricing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    productPricingService.clearCache();
    mockUpdatePartnerWalletBalance.mockResolvedValue({
      previousBalance: 0,
      newBalance: 1000,
    });
    mockCreateTransactionRecord.mockResolvedValue({transactionId: "tx_1"});
    mockPaymentUpdate.mockResolvedValue(undefined);
  });

  function mockPricing(products) {
    collection.mockImplementation(() => ({
      doc: (id) => ({
        get: jest.fn().mockResolvedValue({
          exists: id === "productPricing",
          data: () => ({products: products || {}}),
        }),
      }),
    }));
  }

  it("credits full amount when collection pricing disabled", async () => {
    mockPricing({});
    await processB2bPaymentWebhook(
        {paymentId: "pay_1", amount: 1000, currency: "KES", completedAt: null, account: null},
        {},
        {partnerId: "p1", linkId: null, amount: 1000, currency: "KES"},
    );
    expect(mockUpdatePartnerWalletBalance).toHaveBeenCalledWith("p1", "KES", 1000);
  });

  it("applies checkout fee when enabled", async () => {
    mockPricing({
      checkout: {enabled: true, feePercent: 2.5, flatFeeKes: 0},
    });
    await processB2bPaymentWebhook(
        {paymentId: "pay_2", amount: 1000, currency: "KES", completedAt: null, account: null},
        {},
        {partnerId: "p1", linkId: null, amount: 1000, currency: "KES"},
    );
    expect(mockUpdatePartnerWalletBalance).toHaveBeenCalledWith("p1", "KES", 975);
    expect(mockCreateTransactionRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 1000,
          metadata: expect.objectContaining({
            platformFee: 25,
            netCredit: 975,
            pricingProductKey: "checkout",
          }),
        }),
    );
  });

  it("uses payment_links key when linkId present", async () => {
    mockPricing({
      payment_links: {enabled: true, feePercent: 2.5, flatFeeKes: 0},
      checkout: {enabled: true, feePercent: 10, flatFeeKes: 0},
    });
    await processB2bPaymentWebhook(
        {paymentId: "pay_3", amount: 1000, currency: "KES", completedAt: null, account: null},
        {},
        {partnerId: "p1", linkId: "link_1", amount: 1000, currency: "KES"},
    );
    expect(mockUpdatePartnerWalletBalance).toHaveBeenCalledWith("p1", "KES", 975);
  });

  it("clamps platform fee so credit is never negative", async () => {
    mockPricing({
      checkout: {enabled: true, feePercent: 0, flatFeeKes: 50},
    });
    await processB2bPaymentWebhook(
        {paymentId: "pay_4", amount: 20, currency: "KES", completedAt: null, account: null},
        {},
        {partnerId: "p1", linkId: null, amount: 20, currency: "KES"},
    );
    expect(mockUpdatePartnerWalletBalance).toHaveBeenCalledWith("p1", "KES", 0);
  });
});
