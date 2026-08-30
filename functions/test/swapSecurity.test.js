/**
 * @fileoverview Security: client cannot manipulate swap financials; quote ownership.
 */

const mockQuoteData = {current: null};

jest.mock("../admin", () => {
  const quoteDocRef = {id: "q1"};
  return {
    firestore: Object.assign(
        jest.fn(() => ({
          collection: jest.fn((name) => {
            if (name === "exchangeQuotes") {
              return {
                doc: jest.fn(() => ({
                  ...quoteDocRef,
                  get: jest.fn(async () => ({
                    exists: !!mockQuoteData.current,
                    data: () => mockQuoteData.current,
                    ref: quoteDocRef,
                  })),
                })),
              };
            }
            if (name === "config") {
              return {
                doc: jest.fn((id) => ({
                  get: jest.fn().mockResolvedValue({
                    exists: true,
                    data: () => {
                      if (id === "fees") {
                        return {swapFeeRate: 0.01}; // 1% server fee
                      }
                      return {
                        rateVersion: 5,
                        rates: {
                          USD: {buyRate: 129.5, sellRate: 128.15},
                          KES: {buyRate: 1, sellRate: 1},
                          USDT: {buyRate: 129.5, sellRate: 128.15},
                        },
                      };
                    },
                  }),
                })),
              };
            }
            if (name === "users") {
              return {doc: jest.fn(() => ({id: "userA"}))};
            }
            if (name === "orders") {
              return {
                doc: jest.fn(() => ({id: "ord_1"})),
              };
            }
            if (name === "transactions") {
              return {
                doc: jest.fn(() => ({
                  collection: jest.fn(() => ({
                    doc: jest.fn(() => ({})),
                  })),
                })),
              };
            }
            return {doc: jest.fn()};
          }),
          runTransaction: jest.fn(async (fn) => {
            const tx = {
              get: jest.fn(async (ref) => {
                if (ref && ref.id === "q1") {
                  return {
                    exists: !!mockQuoteData.current,
                    data: () => mockQuoteData.current,
                    ref,
                  };
                }
                return {
                  exists: true,
                  data: () => ({
                    usdBalance: 1000,
                    USD: 1000,
                    kesBalance: 0,
                    KES: 0,
                    usdtBalance: 0,
                    USDT: 0,
                    fiatBalance: 1000,
                    cryptoBalance: 0,
                    balance: 1000,
                  }),
                };
              }),
              update: jest.fn(),
              set: jest.fn(),
            };
            return fn(tx);
          }),
        })),
        {
          FieldValue: {serverTimestamp: jest.fn(() => "TS")},
          Timestamp: {fromMillis: (ms) => ({toMillis: () => ms})},
        },
    ),
  };
});

jest.mock("../config", () => ({
  collections: {
    exchangeQuotes: "exchangeQuotes",
    config: "config",
    users: "users",
    orders: "orders",
    transactions: "transactions",
  },
}));

jest.mock("../utils/firestore", () => ({
  syncBalanceToRealtimeDatabase: jest.fn().mockResolvedValue(undefined),
}));

const {createSwapOrder} = require("../libs/swap");
const {assertQuoteUsableByUser} = require("../services/exchangeQuoteService");
const {resolveCustomerPair} = require("../utils/customerRatesResolve");
const {quoteAmounts} = require("../utils/money");

function openQuote(overrides = {}) {
  return {
    quoteId: "q1",
    userId: "userA",
    sendCurrency: "USD",
    getCurrency: "KES",
    sendAmount: "10.00",
    getAmount: "1281.50",
    grossGetAmount: "1281.50",
    netGetAmount: "1281.50",
    exchangeRate: "128.15",
    feeRate: 0.01,
    feeAmount: "0.10",
    feeCurrency: "USD",
    totalDebit: "10.10",
    feeConvention: "FEE_ON_SEND",
    feeSource: "config.fees.swapFeeRate",
    settleable: true,
    status: "open",
    rateVersion: 5,
    source: "admin_cross",
    expiresAt: {toMillis: () => Date.now() + 60_000},
    ...overrides,
  };
}

describe("swap security — client cannot set rate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuoteData.current = null;
  });

  it("legacy path ignores client exchangeRate / toAmount / fee / feeRate", async () => {
    const result = await createSwapOrder("userA", {
      fromCurrency: "USD",
      toCurrency: "KES",
      fromAmount: 10,
      exchangeRate: 999999,
      toAmount: 1,
      fee: 500,
      feeRate: 0.99,
    });
    expect(result.toAmount).toBe(1281.5);
    expect(result.exchangeRate).toBeCloseTo(128.15, 5);
    expect(result.exchangeRate).not.toBe(999999);
    // Server fee 1% of 10 USD = 0.10 — not client 500 / 0.99
    expect(result.fee).toBe(0.1);
    expect(result.feeRate).toBe(0.01);
    expect(result.fee).not.toBe(500);
  });

  it("quote path ignores client currency/amount/rate/fee overrides", async () => {
    mockQuoteData.current = openQuote();
    const result = await createSwapOrder("userA", {
      quoteId: "q1",
      fromCurrency: "KES",
      toCurrency: "USD",
      fromAmount: 1,
      exchangeRate: 0.001,
      toAmount: 999999,
      fee: 999,
      feeRate: 0.5,
    });
    expect(result.fromAmount).toBe(10);
    expect(result.toAmount).toBe(1281.5);
    expect(result.exchangeRate).toBeCloseTo(128.15, 5);
    expect(result.fee).toBe(0.1);
    expect(result.fee).not.toBe(999);
  });

  it("User B cannot use User A's quote", async () => {
    mockQuoteData.current = openQuote({userId: "userA"});
    await expect(createSwapOrder("userB", {quoteId: "q1"}))
        .rejects.toMatchObject({code: "UNAUTHORIZED_QUOTE"});
  });

  it("expired quote fails", async () => {
    mockQuoteData.current = openQuote({expiresAt: {toMillis: () => Date.now() - 1}});
    await expect(createSwapOrder("userA", {quoteId: "q1"}))
        .rejects.toMatchObject({code: "QUOTE_EXPIRED"});
  });

  it("used quote cannot be replayed", async () => {
    mockQuoteData.current = openQuote({status: "used"});
    await expect(createSwapOrder("userA", {quoteId: "q1"}))
        .rejects.toMatchObject({code: "QUOTE_ALREADY_USED"});
  });

  it("non-settleable ETB→USDC quote cannot settle", async () => {
    mockQuoteData.current = openQuote({
      sendCurrency: "ETB",
      getCurrency: "USDC",
      sendAmount: "100000.00",
      getAmount: "1106.332046",
      exchangeRate: String(1.4327 / 129.5),
      settleable: false,
    });
    await expect(createSwapOrder("userA", {quoteId: "q1"}))
        .rejects.toMatchObject({code: "PAIR_NOT_SETTLEABLE"});
  });
});

describe("quote ownership helper", () => {
  it("rejects null owner and wrong user", () => {
    expect(() => assertQuoteUsableByUser(openQuote({userId: null}), "userA"))
        .toThrow(/UNAUTHORIZED_QUOTE/);
    expect(() => assertQuoteUsableByUser(openQuote({userId: "userA"}), "userB"))
        .toThrow(/UNAUTHORIZED_QUOTE/);
  });

  it("simulates double-consume: second assert fails after used", () => {
    const q = openQuote();
    assertQuoteUsableByUser(q, "userA");
    q.status = "used";
    expect(() => assertQuoteUsableByUser(q, "userA")).toThrow(/QUOTE_ALREADY_USED/);
  });
});

describe("admin rate change does not alter locked quote math", () => {
  it("locked amounts stay fixed when book changes", () => {
    const book1 = {
      USD: {buyRate: 129.5, sellRate: 128.15},
      KES: {buyRate: 1, sellRate: 1},
    };
    const r1 = resolveCustomerPair(book1, "USD/KES");
    const locked = quoteAmounts(10, "USD", r1.sellRate, "KES");

    const book2 = {
      USD: {buyRate: 200, sellRate: 199},
      KES: {buyRate: 1, sellRate: 1},
    };
    const r2 = resolveCustomerPair(book2, "USD/KES");
    const live = quoteAmounts(10, "USD", r2.sellRate, "KES");

    expect(Number(locked.getAmount)).toBe(1281.5);
    expect(Number(live.getAmount)).toBe(1990);
    expect(locked.getAmount).not.toBe(live.getAmount);
  });
});
