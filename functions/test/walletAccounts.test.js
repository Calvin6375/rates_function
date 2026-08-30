/**
 * @fileoverview C2B account list balance shaping (no RTDB).
 */

jest.mock("../admin", () => ({
  firestore: Object.assign(
      jest.fn(() => ({
        collection: jest.fn(() => ({
          doc: jest.fn(() => ({
            get: jest.fn(async () => ({
              exists: true,
              data: () => ({kesBalance: 6529.62, KES: 6529.62}),
            })),
          })),
        })),
      })),
      {
        FieldValue: {
          serverTimestamp: jest.fn(() => ({_serverTimestamp: true})),
        },
      },
  ),
  database: jest.fn(() => ({ref: jest.fn()})),
}));

jest.mock("../libs/realtime", () => ({
  ref: jest.fn(),
}));

jest.mock("../utils/firestore", () => ({
  syncBalanceToRealtimeDatabase: jest.fn(),
}));

jest.mock("../services/ledger/ledgerService", () => ({
  getAvailableBalance: jest.fn(),
}));

jest.mock("../services/ledger/fiatLedgerService", () => ({
  getLedgerBalance: jest.fn(),
  appendTransaction: jest.fn(),
}));

jest.mock("../services/ledger/fiatReservationService", () => ({
  getAvailableBalance: jest.fn(),
  getReservedTotal: jest.fn(),
}));

jest.mock("../services/circle/circleRailAdapter", () => ({
  getWallet: jest.fn(),
}));

const fiatLedgerService = require("../services/ledger/fiatLedgerService");
const {
  buildAccountBalancesFromUserData,
  STANDARD_FIAT_CURRENCIES,
  syncFiatLedgerFromUserProjection,
} = require("../services/walletService");

describe("buildAccountBalancesFromUserData", () => {
  it("maps users doc fields to fiat + crypto maps (RTDB-parity currencies)", () => {
    const {fiat, crypto} = buildAccountBalancesFromUserData(
        {
          usdBalance: 10,
          kesBalance: 1500,
          etbBalance: 200,
          usdtBalance: 3,
          wallets: {GBP: 5},
        },
        {usdc: 12.5},
    );

    expect(fiat.USD).toBe(10);
    expect(fiat.KES).toBe(1500);
    expect(fiat.ETB).toBe(200);
    expect(fiat.GBP).toBe(5);
    expect(fiat.EUR).toBe(0);
    expect(crypto).toEqual({USDT: 3, USDC: 12.5});
    expect(Object.keys(fiat).sort()).toEqual(
        expect.arrayContaining([...STANDARD_FIAT_CURRENCIES]),
    );
  });

  it("includes extra wallets.* fiat codes", () => {
    const {fiat} = buildAccountBalancesFromUserData({
      wallets: {UGX: 1000},
    });
    expect(fiat.UGX).toBe(1000);
  });

  it("does not treat missing user data as crash", () => {
    const {fiat, crypto} = buildAccountBalancesFromUserData(null);
    expect(fiat.KES).toBe(0);
    expect(crypto.USDC).toBe(0);
  });
});

describe("syncFiatLedgerFromUserProjection", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("credits fiatLedger when users.kesBalance is ahead (swap/legacy)", async () => {
    fiatLedgerService.getLedgerBalance.mockResolvedValue(0);
    fiatLedgerService.appendTransaction.mockResolvedValue({
      entryId: "fl_sync",
      newBalance: 6529.62,
    });

    const result = await syncFiatLedgerFromUserProjection("user_1", "KES");
    expect(result.synced).toBe(true);
    expect(result.gap).toBeCloseTo(6529.62);
    expect(fiatLedgerService.appendTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          direction: "credit",
          asset: "KES",
          source: "user_projection_sync",
        }),
    );
  });

  it("no-ops when ledger already matches projection", async () => {
    fiatLedgerService.getLedgerBalance.mockResolvedValue(6529.62);
    const result = await syncFiatLedgerFromUserProjection("user_1", "KES");
    expect(result.synced).toBe(false);
    expect(fiatLedgerService.appendTransaction).not.toHaveBeenCalled();
  });

  it("skips auto-debit by default when users is behind ledger", async () => {
    // users mock = 6529.62; ledger higher → would need debit
    fiatLedgerService.getLedgerBalance.mockResolvedValue(9000);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const result = await syncFiatLedgerFromUserProjection("user_1", "KES");
    expect(result.synced).toBe(false);
    expect(result.gap).toBeLessThan(0);
    expect(fiatLedgerService.appendTransaction).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("admin-zero then credit path: allowDebit clears stale ledger before add", async () => {
    // Simulate users.kesBalance = 0 after admin debit (override firestore mock for this case)
    const admin = require("../admin");
    admin.firestore.mockReturnValueOnce({
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          get: jest.fn(async () => ({
            exists: true,
            data: () => ({kesBalance: 0, KES: 0}),
          })),
        })),
      })),
    });
    fiatLedgerService.getLedgerBalance.mockResolvedValue(2660.69);
    fiatLedgerService.appendTransaction.mockResolvedValue({
      entryId: "fl_clear",
      newBalance: 0,
    });
    const result = await syncFiatLedgerFromUserProjection("user_1", "KES", {allowDebit: true});
    expect(result.synced).toBe(true);
    expect(fiatLedgerService.appendTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          direction: "debit",
          asset: "KES",
          amount: 2660.69,
        }),
    );
  });

  it("debits ledger when allowDebit is set (admin path)", async () => {
    fiatLedgerService.getLedgerBalance.mockResolvedValue(8000);
    fiatLedgerService.appendTransaction.mockResolvedValue({
      entryId: "fl_down",
      newBalance: 6529.62,
    });
    const result = await syncFiatLedgerFromUserProjection("user_1", "KES", {allowDebit: true});
    expect(result.synced).toBe(true);
    expect(fiatLedgerService.appendTransaction).toHaveBeenCalledWith(
        expect.objectContaining({direction: "debit", asset: "KES"}),
    );
  });
});
