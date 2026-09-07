/**
 * @fileoverview Paystack rail for B2B product payment-link checkout.
 */

const mockOrderSet = jest.fn();
const mockMappingSet = jest.fn();
const mockLinkUpdate = jest.fn();

jest.mock("../../admin", () => {
  const firestoreFn = jest.fn(() => ({
    collection: (name) => {
      if (name === "orders") {
        return {
          doc: () => ({
            id: "ord_pl_1",
            set: mockOrderSet,
          }),
        };
      }
      if (name === "invoiceMappings") {
        return {
          doc: () => ({
            set: mockMappingSet,
          }),
        };
      }
      return {
        doc: () => ({
          set: jest.fn(),
          update: jest.fn(),
          get: jest.fn().mockResolvedValue({ exists: false }),
        }),
      };
    },
  }));
  return {
    firestore: firestoreFn,
    database: jest.fn(() => ({ref: jest.fn()})),
  };
});

jest.mock("../../libs/firestore", () => ({
  collection: jest.fn((name) => {
    if (name === "paymentLinks") {
      return {
        doc: () => ({ update: mockLinkUpdate }),
      };
    }
    return {
      doc: () => ({
        set: jest.fn(),
        update: jest.fn(),
        get: jest.fn().mockResolvedValue({ exists: false }),
      }),
    };
  }),
  serverTimestamp: jest.fn(() => ({ _serverTimestamp: true })),
}));

jest.mock("../../services/paymentLinkService", () => ({
  getPublicPaymentLink: jest.fn(),
  buildHostedSuccessUrl: jest.fn(() => "https://example.test/b2bPortal/l/pl_1/success"),
  effectiveStatus: jest.fn((d) => d.status),
}));

jest.mock("../../services/funding/c2bFundingFxService", () => ({
  convertToKesForPaystack: jest.fn(),
}));

jest.mock("../../services/funding/fundingOrderService", () => ({
  generateFundingOrderId: jest.fn(() => "fund_pl_1"),
  createFundingOrder: jest.fn(),
  updateFundingOrder: jest.fn(async (id, patch) => ({ id, ...patch })),
}));

jest.mock("../../services/funding/fundingRailService", () => ({
  initializePayment: jest.fn(),
}));

jest.mock("../../services/paymentRailService", () => ({
  SUPPORTED_RAILS: {
    paystack: "paystack",
    intasend: "intasend",
    manual: "manual",
    circle: "circle",
  },
  defaultRail: jest.fn(() => "paystack"),
  sanitizeIntaSendApiRef: jest.fn((preferred, fallback) => preferred || fallback),
  collectCheckoutIdentifierIds: jest.fn(() => []),
  createSession: jest.fn(),
}));

const paymentLinkService = require("../../services/paymentLinkService");
const { convertToKesForPaystack } = require("../../services/funding/c2bFundingFxService");
const fundingOrderService = require("../../services/funding/fundingOrderService");
const fundingRailService = require("../../services/funding/fundingRailService");
const paymentRailService = require("../../services/paymentRailService");
const checkoutService = require("../../services/b2bPaymentLinkCheckoutService");

describe("b2b payment link Paystack checkout", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOrderSet.mockResolvedValue(undefined);
    mockMappingSet.mockResolvedValue(undefined);
    mockLinkUpdate.mockResolvedValue(undefined);

    paymentLinkService.getPublicPaymentLink.mockResolvedValue({
      linkId: "pl_1",
      partnerId: "partner_1",
      status: "active",
      amount: 1000,
      currency: "KES",
      bookingReference: "ROOM-1",
      description: "Deluxe",
    });
    convertToKesForPaystack.mockResolvedValue({
      requestedAmount: 1000,
      requestedCurrency: "KES",
      amountKes: 1000,
      paystackCurrency: "KES",
      fxRate: 1,
    });
    fundingOrderService.createFundingOrder.mockResolvedValue({
      id: "fund_pl_1",
      providerReference: "fund_pl_1",
      metadata: {
        product: "b2b_payment_link",
        partnerId: "partner_1",
        linkId: "pl_1",
        requestedAmount: 1000,
        requestedCurrency: "KES",
      },
    });
    fundingRailService.initializePayment.mockResolvedValue({
      checkoutUrl: "https://checkout.paystack.com/pl_test",
      providerReference: "fund_pl_1",
      providerTransactionId: "12345",
    });
  });

  it("uses the Paystack default rail from paymentRailService", () => {
    expect(paymentRailService.defaultRail()).toBe("paystack");
  });

  it("initializes Paystack and returns the hosted checkout URL", async () => {
    const result = await checkoutService.startCheckout(
        "pl_1",
        "partner_1",
        { payerName: "Ada Lovelace", email: "ada@example.com" },
        "paystack",
    );

    expect(convertToKesForPaystack).toHaveBeenCalledWith(1000, "KES");
    expect(fundingRailService.initializePayment).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "paystack",
          amount: 1000,
          currency: "KES",
          email: "ada@example.com",
          callbackUrl: "https://example.test/b2bPortal/l/pl_1/success",
          metadata: expect.objectContaining({ product: "b2b_payment_link" }),
        }),
    );
    expect(result.rail).toBe("paystack");
    expect(result.checkoutUrl).toBe("https://checkout.paystack.com/pl_test");
    expect(result.checkoutId).toBe("fund_pl_1");
    expect(mockMappingSet).toHaveBeenCalled();
    expect(mockLinkUpdate).toHaveBeenCalled();
  });
});
