/**
 * @fileoverview Locked Exchange quote create / expire / replay / ownership / fees.
 */

const mockSet = jest.fn().mockResolvedValue(undefined);
const mockUpdate = jest.fn();
const quoteSnap = {current: {exists: false, data: () => ({})}};

jest.mock("../admin", () => ({
  firestore: Object.assign(
      jest.fn(() => ({
        collection: jest.fn((name) => ({
          doc: jest.fn((id) => ({
            id: id === "fees" ? "fees" : "q_test_1",
            set: mockSet,
            update: mockUpdate,
            get: jest.fn(async () => {
              if (name === "config" || id === "fees") {
                return {exists: true, data: () => ({swapFeeRate: 0})};
              }
              return quoteSnap.current;
            }),
          })),
        })),
      })),
      {
        Timestamp: {
          fromMillis: (ms) => ({toMillis: () => ms, _ms: ms}),
        },
        FieldValue: {
          serverTimestamp: jest.fn(() => "SERVER_TS"),
        },
      },
  ),
}));

jest.mock("../config", () => ({
  collections: {exchangeQuotes: "exchangeQuotes", config: "config"},
}));

const {
  createQuote,
  getOpenQuoteForSettlement,
  markQuoteUsedInTransaction,
  assertQuoteUsableByUser,
} = require("../services/exchangeQuoteService");

const book = {
  ETB: {buyRate: 1.4415, sellRate: 1.4327},
  USDC: {buyRate: 129.5, sellRate: 128.15},
  USD: {buyRate: 129.5, sellRate: 128.15},
  KES: {buyRate: 1, sellRate: 1},
};

describe("exchangeQuoteService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("creates locked quote with fee fields and ETB→USDC ≈ 0.01106", async () => {
    const quote = await createQuote({
      rates: book,
      sendCurrency: "ETB",
      getCurrency: "USDC",
      sendAmount: 100000,
      rateVersion: 7,
      userId: "u1",
    });
    expect(Number(quote.exchangeRate)).toBeCloseTo(1.4327 / 129.5, 5);
    expect(Number(quote.grossGetAmount)).toBeCloseTo(1106.332046, 5);
    expect(quote.netGetAmount).toBe(quote.grossGetAmount);
    expect(quote.feeRate).toBe(0);
    expect(quote.feeAmount).toBe("0.00");
    expect(quote.totalDebit).toBe("100000.00");
    expect(quote.feeConvention).toBe("FEE_ON_SEND");
    expect(quote.settleable).toBe(false);
    expect(quote.immutable).toBe(true);
  });

  it("settleable USD→KES requires userId", async () => {
    await expect(createQuote({
      rates: book,
      sendCurrency: "USD",
      getCurrency: "KES",
      sendAmount: 10,
    })).rejects.toMatchObject({code: "UNAUTHORIZED_QUOTE"});
  });

  it("MISSING_RATE when USDC absent", async () => {
    await expect(createQuote({
      rates: {ETB: book.ETB},
      sendCurrency: "ETB",
      getCurrency: "USDC",
      sendAmount: 10,
      userId: "u1",
    })).rejects.toMatchObject({code: "MISSING_RATE"});
  });

  it("QUOTE_EXPIRED / QUOTE_ALREADY_USED / UNAUTHORIZED_QUOTE", async () => {
    quoteSnap.current = {
      exists: true,
      data: () => ({
        userId: "u1",
        status: "open",
        settleable: true,
        expiresAt: {toMillis: () => Date.now() - 1000},
      }),
    };
    await expect(getOpenQuoteForSettlement("q_test_1", "u1"))
        .rejects.toMatchObject({code: "QUOTE_EXPIRED"});

    quoteSnap.current = {
      exists: true,
      data: () => ({
        userId: "u1",
        status: "used",
        settleable: true,
        expiresAt: {toMillis: () => Date.now() + 60000},
      }),
    };
    await expect(getOpenQuoteForSettlement("q_test_1", "u1"))
        .rejects.toMatchObject({code: "QUOTE_ALREADY_USED"});

    quoteSnap.current = {
      exists: true,
      data: () => ({
        userId: "u1",
        status: "open",
        settleable: true,
        expiresAt: {toMillis: () => Date.now() + 60000},
      }),
    };
    await expect(getOpenQuoteForSettlement("q_test_1", "u2"))
        .rejects.toMatchObject({code: "UNAUTHORIZED_QUOTE"});
  });

  it("assertQuoteUsableByUser rejects unbound quotes", () => {
    expect(() => assertQuoteUsableByUser({
      userId: null,
      status: "open",
      settleable: true,
      expiresAt: {toMillis: () => Date.now() + 1000},
    }, "u1")).toThrow(/UNAUTHORIZED_QUOTE/);
  });

  it("markQuoteUsedInTransaction updates status", () => {
    const tx = {update: jest.fn()};
    markQuoteUsedInTransaction(tx, {id: "q_test_1"}, "order_1");
    expect(tx.update).toHaveBeenCalledWith(
        {id: "q_test_1"},
        expect.objectContaining({status: "used", orderId: "order_1"}),
    );
  });
});
